#!/usr/bin/env node
// pathToFileURL, not `file://` + path: this repo lives under a directory with a space
// in its name, and the naive form never matches, so the CLI block silently never runs.
import { pathToFileURL } from "node:url";
/**
 * Settlement keeper. Closes the last human step in the loop.
 *
 *   node agent/src/keeper.mjs --once
 *   node agent/src/keeper.mjs --interval 300
 *
 * A loan that has matured sits in limbo until someone calls settle(): the underwriter's
 * bond stays locked, lenders do not receive their interest, and the accuracy record does
 * not update. Nothing forces anyone to do it, so this does.
 *
 * Why automating this is safe, when auto-slashing would not be:
 *
 *   settle() takes no arguments beyond the deal id. The contract reads its own state to
 *   decide whether the loan repaid or defaulted, how much to slash, and what fee to pay.
 *   The caller cannot influence the outcome and gains nothing from calling it. So a keeper
 *   working from a slightly stale view can only ever be early (the call reverts with
 *   NotYetSettleable) or correct. It can never settle a loan the wrong way.
 *
 * Contrast that with the monitor, which deliberately does not act: deciding a borrower has
 * deteriorated is a judgement call, and a bot making it from one RPC read is how you slash
 * an honest underwriter.
 */

import { ethers } from "ethers";

const ABI = [
  "function getDeal(bytes32) view returns (tuple(address borrower,address adapter,address underwriter,uint256 principal,uint256 dueAmount,uint256 avalLocked,uint256 repaid,uint64 maturity,uint64 gracePeriod,uint16 pdBps,uint8 status,bool defaulted))",
  "function settle(bytes32 dealId)",
  "function paused() view returns (bool)",
  "event DealFunded(bytes32 indexed dealId, address indexed borrower, address indexed underwriter, uint256 principal, uint256 dueAmount, uint256 avalLocked, uint16 pdBps)",
];

const usdt = (v) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fetch logs in adaptive chunks; public RPCs cap eth_getLogs ranges differently. */
async function queryChunked(contract, filter, fromBlock, toBlock, chunk = 9_000) {
  const out = [];
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    try {
      out.push(...(await contract.queryFilter(filter, start, end)));
      start = end + 1;
      if (size < chunk) size = Math.min(chunk, size * 2);
    } catch (err) {
      if (size <= 1) throw err;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out;
}

export function isSettleable(deal, now) {
  if (Number(deal.status) !== 1) return { ready: false, reason: "not active" };
  const paidInFull = BigInt(deal.repaid) >= BigInt(deal.dueAmount);
  const pastGrace = now > Number(deal.maturity) + Number(deal.gracePeriod);
  if (paidInFull) return { ready: true, expect: "repaid" };
  if (pastGrace) return { ready: true, expect: "default" };
  return { ready: false, reason: `matures in ${(((Number(deal.maturity) + Number(deal.gracePeriod)) - now) / 3600).toFixed(1)}h` };
}

async function tick({ provider, wallet, dealManager, fromBlock, dryRun }) {
  const read = new ethers.Contract(dealManager, ABI, provider);
  const write = wallet ? new ethers.Contract(dealManager, ABI, wallet) : null;

  const head = await provider.getBlockNumber();
  const funded = await queryChunked(read, read.filters.DealFunded(), fromBlock, head);
  const ids = [...new Set(funded.map((l) => l.args.dealId))];

  const now = Math.floor(Date.now() / 1000);
  let settled = 0;
  let pending = 0;

  for (const id of ids) {
    const deal = await read.getDeal(id);
    const check = isSettleable(deal, now);
    if (!check.ready) {
      if (Number(deal.status) === 1) pending++;
      continue;
    }

    const label = check.expect === "default" ? "DEFAULT, bond will be slashed" : "repaid";
    console.log(`  settleable  ${id.slice(0, 10)}...  ${usdt(deal.principal)} USDT  (${label})`);

    if (dryRun || !write) {
      console.log(`              dry run, not sending`);
      continue;
    }

    try {
      // Simulate first. A revert here means our view was stale, not that anything is wrong.
      await write.settle.staticCall(id);
      const tx = await write.settle(id);
      const receipt = await tx.wait();
      console.log(`              settled in block ${receipt.blockNumber}  ${tx.hash}`);
      settled++;
    } catch (err) {
      const msg = err?.shortMessage ?? err?.message ?? "unknown";
      console.log(`              skipped: ${msg.slice(0, 120)}`);
    }
  }

  console.log(`  [${new Date().toISOString()}] ${ids.length} loan(s), ${settled} settled, ${pending} still running`);
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  const iAt = args.indexOf("--interval");
  const interval = iAt >= 0 ? Number(args[iAt + 1]) : 300;

  const rpc = process.env.XLAYER_TESTNET_RPC_URL || process.env.XLAYER_RPC_URL;
  const dealManager = process.env.DEAL_MANAGER_ADDRESS;
  const key = process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const fromBlock = Number(process.env.DEPLOY_BLOCK ?? 0);

  if (!rpc || !dealManager) {
    console.error("Set XLAYER_TESTNET_RPC_URL and DEAL_MANAGER_ADDRESS in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = key && !dryRun ? new ethers.Wallet(key, provider) : null;

  console.log(`\n  keeper on ${(await provider.getNetwork()).chainId}`);
  console.log(`  deal manager  ${dealManager}`);
  console.log(`  caller        ${wallet ? await wallet.getAddress() : "(read only)"}`);
  console.log(`  scanning from block ${fromBlock}\n`);

  const run = () =>
    tick({ provider, wallet, dealManager, fromBlock, dryRun }).catch((e) =>
      // Never exit the loop on a transient RPC failure.
      console.error(`  scan failed: ${e.message?.slice(0, 160)}`)
    );

  await run();
  if (!once) {
    console.log(`\n  watching every ${interval}s, ctrl-c to stop`);
    setInterval(run, interval * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
