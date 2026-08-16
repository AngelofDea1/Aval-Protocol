// pathToFileURL, not `file://` + path: this repo lives under a directory with a space
// in its name, and the naive form never matches, so the CLI block silently never runs.
import { pathToFileURL } from "node:url";
// Post-funding monitor.
//
// Underwriting ends at funding; risk does not. This watches live deals for cashflow
// deterioration against what the model assumed, and surfaces deals that have become
// settleable.
//
//   node agent/src/monitor.mjs --once
//   node agent/src/monitor.mjs --interval 900
//
// Deliberately does NOT auto-settle. Settlement slashes an underwriter's bond, and a bot
// firing that on a stale RPC read or a transient data outage is a far worse failure than a
// late settlement. It reports; a human or a reviewed job acts.

import { ethers } from "ethers";

export const SEVERITY = { OK: "ok", WATCH: "watch", ALERT: "alert", SETTLEABLE: "settleable" };

const DEAL_MANAGER_ABI = [
  "function getDeal(bytes32) view returns (tuple(address borrower,address adapter,address underwriter,uint256 principal,uint256 dueAmount,uint256 avalLocked,uint256 repaid,uint64 maturity,uint64 gracePeriod,uint16 pdBps,uint8 status,bool defaulted))",
  "event DealFunded(bytes32 indexed dealId, address indexed borrower, address indexed underwriter, uint256 principal, uint256 dueAmount, uint256 avalLocked, uint16 pdBps)",
];

const ADAPTER_ABI = ["function observedInflow(bytes32) view returns (uint256)"];

/**
 * Assess one deal.
 *
 * The core signal is *pace*: at 50% of the way through the term, roughly 50% of the amount
 * due should have arrived. Falling behind that line is the earliest observable sign a deal
 * is heading for default.
 */
export function assessDeal({ deal, observedInflow, now }) {
  const maturity = Number(deal.maturity);
  const grace = Number(deal.gracePeriod);
  const due = BigInt(deal.dueAmount);
  const repaid = BigInt(deal.repaid);
  const observed = BigInt(observedInflow ?? 0);

  // Cash actually in hand: explicit repayments, or adapter-observed inflow where higher.
  const collected = repaid > observed ? repaid : observed;

  if (Number(deal.status) === 2) return { severity: SEVERITY.OK, reason: "already settled" };
  if (Number(deal.status) === 0) return { severity: SEVERITY.OK, reason: "not funded" };

  const paidInFull = collected >= due;
  const pastGrace = now > maturity + grace;

  if (paidInFull || pastGrace) {
    return {
      severity: SEVERITY.SETTLEABLE,
      reason: paidInFull ? "repaid in full" : "past maturity and grace, short",
      shortfall: paidInFull ? 0n : due - collected,
      expectedDefault: !paidInFull,
    };
  }

  // Linear pace expectation across the term. Term start is unknown onchain, so approximate
  // it from maturity minus a 30-day nominal term.
  const nominalTerm = 30 * 86400;
  const start = maturity - nominalTerm;
  const elapsed = Math.max(0, Math.min(now - start, nominalTerm));
  const progress = nominalTerm > 0 ? elapsed / nominalTerm : 0;

  const expected = (due * BigInt(Math.round(progress * 10_000))) / 10_000n;
  const pace = expected > 0n ? Number((collected * 10_000n) / expected) / 10_000 : 1;

  let severity = SEVERITY.OK;
  let reason = "on pace";
  if (progress > 0.25) {
    if (pace < 0.5) {
      severity = SEVERITY.ALERT;
      reason = `collections at ${(pace * 100).toFixed(0)}% of expected pace`;
    } else if (pace < 0.8) {
      severity = SEVERITY.WATCH;
      reason = `collections at ${(pace * 100).toFixed(0)}% of expected pace`;
    }
  }

  return {
    severity,
    reason,
    progress,
    pace,
    collected,
    expected,
    daysToMaturity: (maturity - now) / 86400,
  };
}

export async function scanDeals({ provider, dealManagerAddress, dealIds, fromBlock = 0 }) {
  const dm = new ethers.Contract(dealManagerAddress, DEAL_MANAGER_ABI, provider);
  const now = Math.floor(Date.now() / 1000);

  // Discover deals from events when an explicit list isn't supplied.
  let ids = dealIds;
  if (!ids || ids.length === 0) {
    const logs = await dm.queryFilter(dm.filters.DealFunded(), fromBlock, "latest");
    ids = [...new Set(logs.map((l) => l.args.dealId))];
  }

  const results = [];
  for (const dealId of ids) {
    const deal = await dm.getDeal(dealId);

    let observedInflow = 0n;
    if (deal.adapter && deal.adapter !== ethers.ZeroAddress) {
      try {
        observedInflow = await new ethers.Contract(deal.adapter, ADAPTER_ABI, provider).observedInflow(dealId);
      } catch {
        // Adapters that cannot observe cash onchain return nothing; explicit repayments
        // still drive the assessment.
      }
    }

    results.push({ dealId, deal, ...assessDeal({ deal, observedInflow, now }) });
  }
  return results;
}

function format(r) {
  const badge = { ok: "  OK  ", watch: " WATCH", alert: " ALERT", settleable: " SETTLE" }[r.severity];
  const id = r.dealId.slice(0, 10);
  const extra =
    r.severity === SEVERITY.SETTLEABLE
      ? r.expectedDefault
        ? `shortfall ${(Number(r.shortfall) / 1e6).toFixed(2)} USDT - settling will SLASH the bond`
        : "repaid in full - settle to release the bond and pay the fee"
      : `${(r.progress * 100).toFixed(0)}% through term, ${r.daysToMaturity?.toFixed(1)}d to maturity`;
  return `  [${badge}] ${id}  ${r.reason}\n            ${extra}`;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const intervalIdx = args.indexOf("--interval");
  const interval = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 900;

  const rpc = process.env.XLAYER_RPC_URL;
  const dealManagerAddress = process.env.DEAL_MANAGER_ADDRESS;
  if (!rpc || !dealManagerAddress) {
    console.error("Set XLAYER_RPC_URL and DEAL_MANAGER_ADDRESS");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const fromBlock = Number(process.env.DEPLOY_BLOCK ?? 0);

  const tick = async () => {
    try {
      const results = await scanDeals({ provider, dealManagerAddress, fromBlock });
      console.log(`\n[${new Date().toISOString()}] ${results.length} deal(s)`);
      if (results.length === 0) console.log("  none found");
      for (const r of results) console.log(format(r));

      const settleable = results.filter((r) => r.severity === SEVERITY.SETTLEABLE);
      if (settleable.length) {
        console.log(`\n  ${settleable.length} deal(s) awaiting settlement. Review, then call settle().`);
      }
    } catch (err) {
      // Never exit the loop on a transient RPC failure.
      console.error(`  scan failed: ${err.message}`);
    }
  };

  await tick();
  if (!once) {
    console.log(`\nwatching every ${interval}s - ctrl-c to stop`);
    setInterval(tick, interval * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
