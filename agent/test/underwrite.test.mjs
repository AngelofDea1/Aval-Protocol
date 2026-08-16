// Agent pipeline tests, including a full end-to-end run in which the agent's own signed
// attestation funds a real deal against the compiled contracts.
//
//   node agent/test/underwrite.test.mjs
//
// Runs entirely offline: no network, no LLM key. The LLM stage is expected to skip, which
// is itself the behaviour under test - a missing qualitative overlay must degrade to a
// structural-only decision, never block one.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile, newChain, wallet, ethers } from "../../test/js/harness.mjs";
import { loadModel } from "../src/model-node.mjs";
import { applyAdjustment, MAX_ADJUSTMENT } from "../src/llm.mjs";
import { attest, LIMITS, priceDeal, underwrite, makeDealId } from "../src/underwrite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, "..", "model", "model.json");

const USDT = (n) => BigInt(Math.round(n * 1e6));
const CHAIN_ID = 1n;
const MODEL_COMMIT = ethers.keccak256(ethers.toUtf8Bytes("aval-underwriter-v0.1.0"));
const NOW = 1_780_000_000;

let passed = 0;
let failed = 0;

function ok(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`    ok  ${label}`);
  } else {
    failed++;
    console.log(`   FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
}

/// Deterministic revenue series: `health` in [0,1] scales level and trend.
function series(health, n = 180) {
  const out = [];
  let level = 3_000 + 9_000 * health;
  for (let i = 0; i < n; i++) {
    const drift = (health - 0.5) * 0.004;
    const wobble = Math.sin(i / 9) * 0.05 * (1.4 - health);
    level *= Math.exp(drift + wobble * 0.1);
    out.push(Math.max(level, 1));
  }
  return out;
}

const model = loadModel(MODEL_PATH);

// ------------------------------------------------------------------- pricing

console.log("\n  pricing");
{
  const cheap = priceDeal({ pd: 0.02, pdUpper: 0.05 });
  const dear = priceDeal({ pd: 0.25, pdUpper: 0.35 });

  ok("riskier deals advance less", dear.advanceRateBps < cheap.advanceRateBps,
     `${dear.advanceRateBps} vs ${cheap.advanceRateBps}`);
  ok("riskier deals are priced higher", dear.discountBps > cheap.discountBps,
     `${dear.discountBps} vs ${cheap.discountBps}`);
  ok("discount covers expected loss", cheap.discountBps > cheap.breakevenBps);
  ok("advance rate respects floor", priceDeal({ pd: 0.9, pdUpper: 0.99 }).advanceRateBps >= LIMITS.minAdvanceRateBps);
  ok("advance rate respects cap", priceDeal({ pd: 0.0001, pdUpper: 0.0001 }).advanceRateBps <= LIMITS.maxAdvanceRateBps);
  ok("discount respects cap", priceDeal({ pd: 0.95, pdUpper: 0.99 }).discountBps <= LIMITS.maxDiscountBps);

  // Uncertainty must tighten the advance even when the point estimate is unchanged.
  const tight = priceDeal({ pd: 0.10, pdUpper: 0.12 });
  const wide = priceDeal({ pd: 0.10, pdUpper: 0.30 });
  ok("a wider interval advances less at the same point estimate",
     wide.advanceRateBps < tight.advanceRateBps, `${wide.advanceRateBps} vs ${tight.advanceRateBps}`);
}

// ------------------------------------------------------------- the LLM clamp

console.log("\n  LLM clamp");
{
  const base = 0.10;
  const max = applyAdjustment(base, 1);
  const min = applyAdjustment(base, -1);
  const over = applyAdjustment(base, 999);

  ok("a maximal push up is bounded", Math.abs(max.adjustedPd - base * (1 + MAX_ADJUSTMENT)) < 1e-12);
  ok("a maximal push down is bounded", Math.abs(min.adjustedPd - base * (1 - MAX_ADJUSTMENT)) < 1e-12);
  ok("out-of-range input is clamped, not trusted", Math.abs(over.adjustedPd - max.adjustedPd) < 1e-12);
  ok("clamp saturation is reported", over.hitClamp === true);
  ok("cannot be driven to a degenerate 0", applyAdjustment(0.0001, -1).adjustedPd > 0);
  ok("cannot be driven to a degenerate 1", applyAdjustment(0.999, 1).adjustedPd < 1);
  ok("garbage input is treated as no information", applyAdjustment(base, NaN).adjustedPd === base);
}

// -------------------------------------------------------- underwriting logic

console.log("\n  underwriting");
{
  const healthy = await underwrite(
    { obligor: "healthy-protocol", series: series(0.95), concentration: 0.15,
      obligorAgeDays: 900, faceAmount: 100_000 },
    { model }
  );
  const weak = await underwrite(
    { obligor: "declining-protocol", series: series(0.12), concentration: 0.72,
      obligorAgeDays: 90, faceAmount: 100_000 },
    { model }
  );

  ok("a weaker obligor scores a higher PD", weak.pd > healthy.pd,
     `weak ${(weak.pd * 100).toFixed(2)}% vs healthy ${(healthy.pd * 100).toFixed(2)}%`);
  ok("a weaker obligor advances less", weak.pricing.advanceRateBps < healthy.pricing.advanceRateBps);
  ok("a weaker obligor pays more", weak.pricing.discountBps > healthy.pricing.discountBps);
  ok("PD stays within [0,1]", healthy.pd > 0 && healthy.pd < 1 && weak.pd > 0 && weak.pd < 1);
  ok("upper bound is never below the point estimate", healthy.pdUpper >= healthy.pd && weak.pdUpper >= weak.pd);

  ok("LLM stage skipped cleanly with no key", healthy.llm.skipped === true && healthy.llm.adjustment === 0);
  ok("the skip is recorded in the rationale", Boolean(healthy.rationale.qualitative.reason));
  ok("rationale records the model version", healthy.rationale.model.version === model.version);
  ok("rationale carries explicit caveats", healthy.rationale.caveats.length >= 3);
  ok("rationale ranks feature contributions", healthy.rationale.topContributions.length === 5);
  ok("principal is derived from the advance rate",
     healthy.principal === Math.floor((100_000 * healthy.pricing.advanceRateBps) / 10_000));

  // A larger advance against identical cashflows must look riskier.
  const small = await underwrite(
    { obligor: "x", series: series(0.6), concentration: 0.3, obligorAgeDays: 400, faceAmount: 50_000 },
    { model }
  );
  const large = await underwrite(
    { obligor: "x", series: series(0.6), concentration: 0.3, obligorAgeDays: 400, faceAmount: 400_000 },
    { model }
  );
  ok("asking for more against the same revenue raises PD", large.pd > small.pd,
     `${(large.pd * 100).toFixed(2)}% vs ${(small.pd * 100).toFixed(2)}%`);

  // Rejects malformed input rather than scoring it.
  let threw = 0;
  for (const bad of [{ faceAmount: 0 }, { faceAmount: -5 }, { series: [] }]) {
    try {
      await underwrite(
        { obligor: "x", series: series(0.5), concentration: 0.3, obligorAgeDays: 400,
          faceAmount: 100_000, ...bad },
        { model }
      );
    } catch {
      threw++;
    }
  }
  ok("rejects malformed input", threw === 3);

  // The units trap: same obligor, faceAmount off by 1e6. Must be flagged, not scored silently.
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  const mismatched = await underwrite(
    { obligor: "units-trap", series: series(0.8), concentration: 0.2, obligorAgeDays: 600,
      faceAmount: 100_000 * 1e6 },
    { model }
  );
  console.warn = warn;
  ok("flags a units mismatch", mismatched.implausibleCoverage === true);
  ok("warns loudly on a units mismatch", warned === 1);
  ok("records the mismatch in the rationale", mismatched.rationale.warnings.length === 1);
}

// ------------------------------------------------------- end to end on chain

console.log("\n  end to end: agent attestation funds a real deal");
{
  const artifacts = compile();
  const chain = await newChain(artifacts);
  const deployer = wallet(0);
  const uw = wallet(1);
  const lp = wallet(2);
  const borrower = wallet(3);
  for (const a of [deployer, uw, lp, borrower]) await chain.fund(a.address);

  const usdt = await chain.deploy("MockUSDT", [], deployer.address);
  const registry = await chain.deploy("UnderwriterRegistry",
    [usdt.hexAddress, USDT(10_000), deployer.hex], deployer.address);
  const reputation = await chain.deploy("Reputation", [deployer.hex], deployer.address);
  const vault = await chain.deploy("SeniorVault",
    [usdt.hexAddress, "Aval Senior USDT", "avUSDT", deployer.hex], deployer.address);
  const dm = await chain.deploy("DealManager",
    [usdt.hexAddress, registry.hexAddress, reputation.hexAddress, vault.hexAddress, deployer.hex],
    deployer.address);

  await registry.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await reputation.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await vault.send("setDealManager", [dm.hexAddress], deployer.address);

  await usdt.send("mint", [lp.hex, USDT(1_000_000)], deployer.address);
  await usdt.send("mint", [uw.hex, USDT(50_000)], deployer.address);
  await usdt.send("approve", [vault.hexAddress, USDT(1_000_000)], lp.address);
  await vault.send("deposit", [USDT(1_000_000), lp.hex], lp.address);
  await usdt.send("approve", [registry.hexAddress, USDT(50_000)], uw.address);
  await registry.send("register", [MODEL_COMMIT, USDT(50_000)], uw.address);

  const adapter = await chain.deploy("MockCashflowAdapter",
    [ethers.keccak256(ethers.toUtf8Bytes("protocol-revenue-v1"))], deployer.address);

  // The agent underwrites a real-shaped obligor and signs its own opinion.
  // Revenue is expressed in USDT base units to match faceAmount - see the UNITS note on
  // underwrite(); a mismatch here silently produces a near-certain-default PD.
  const revenue = series(0.8).map((v) => v * 1e6);
  const decision = await underwrite(
    { obligor: "demo-protocol", series: revenue, concentration: 0.2,
      obligorAgeDays: 600, faceAmount: 100_000 * 1e6 },
    { model }
  );
  ok("coverage is plausible (units agree)", decision.implausibleCoverage === false,
     `coverage=${decision.features.coverage}`);
  ok("PD is fundable under policy", Math.round(decision.pdUpper * 10_000) <= 3_000,
     `pdUpper=${(decision.pdUpper * 100).toFixed(2)}%`);

  const registryView = await registry.call("getUnderwriter", [uw.hex]);
  const signed = await attest(
    decision,
    {
      dealId: makeDealId("demo-protocol", 1),
      borrower: borrower.hex,
      adapter: adapter.hexAddress,
      maturity: NOW + 30 * 86400,
      gracePeriod: 7 * 86400,
    },
    {
      signer: uw.wallet,
      chainId: CHAIN_ID,
      dealManager: dm.hexAddress,
      modelCommit: MODEL_COMMIT,
      rationaleCID: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(decision.rationale))),
      registryView: {
        active: registryView.active,
        modelCommit: registryView.modelCommit,
        bondTotal: registryView.bondTotal,
        bondLocked: registryView.bondLocked,
      },
      policy: { maxPdUpperBps: 3_000, firstLossBps: 1_500 },
    }
  );

  ok("preflight finds no problems", signed.problems.length === 0, JSON.stringify(signed.problems));
  ok("offchain termsHash matches the contract",
     signed.termsHash === (await dm.call("hashTerms", [signed.dealParams])));

  await dm.send("fundDeal", [signed.dealParams, signed.attestation, signed.signature], borrower.address);

  const deal = await dm.call("getDeal", [signed.dealParams.dealId]);
  ok("deal funded from an agent-signed attestation", deal.principal === signed.dealParams.principal);
  ok("PD recorded onchain matches the model", Number(deal.pdBps) === Math.round(decision.pd * 10_000));
  ok("bond locked at 15% of principal", deal.avalLocked === (signed.dealParams.principal * 1500n) / 10000n);
  ok("borrower received the advance", (await usdt.call("balanceOf", [borrower.hex])) === signed.dealParams.principal);

  // Settle it and confirm the underwriter is scored on its own number.
  await usdt.send("mint", [borrower.hex, USDT(200_000)], deployer.address);
  await usdt.send("approve", [dm.hexAddress, deal.dueAmount], borrower.address);
  await dm.send("repay", [signed.dealParams.dealId, deal.dueAmount], borrower.address);
  await dm.send("settle", [signed.dealParams.dealId], borrower.address);

  const rec = await reputation.call("getRecord", [uw.hex]);
  ok("prediction recorded against the underwriter", rec.predictions === 1n);
  ok("no default recorded on a repaid deal", rec.defaults === 0n);

  const expectedSqErr = BigInt(Math.round(decision.pd * 10_000)) ** 2n;
  ok("onchain Brier error matches the signed PD", rec.sumSquaredError === expectedSqErr,
     `${rec.sumSquaredError} vs ${expectedSqErr}`);

  console.log(
    `\n    demo deal: pd=${(decision.pd * 100).toFixed(2)}% ` +
      `upper=${(decision.pdUpper * 100).toFixed(2)}% ` +
      `advance=${decision.pricing.advanceRateBps}bps ` +
      `discount=${decision.pricing.discountBps}bps ` +
      `principal=${Number(signed.dealParams.principal) / 1e6} USDT`
  );
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
