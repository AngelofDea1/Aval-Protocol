#!/usr/bin/env node
// Aval underwriting agent CLI.
//
//   node agent/src/index.mjs underwrite --slug uniswap --face 100000
//   node agent/src/index.mjs underwrite --offline --face 100000     # no network
//   node agent/src/index.mjs sign       --slug uniswap --face 100000 --out deal.json
//
// `underwrite` scores an obligor and prints the decision.
// `sign` additionally produces a signed attestation ready to pass to fundDeal.
//
// Env for `sign`:
//   UNDERWRITER_PRIVATE_KEY   key registered in UnderwriterRegistry
//   DEAL_MANAGER_ADDRESS      deployed DealManager
//   CHAIN_ID                  196 mainnet / 195 testnet (verify)
//   MODEL_COMMIT              must equal the registry's stored commit for this underwriter

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import { loadModel } from "./model-node.mjs";
import { fetchFeeSeries, obligorAgeDays, temporalConcentration } from "./ingest/defillama.mjs";
import { attest, makeDealId, underwrite } from "./underwrite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, "..", "model", "model.json");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/// Deterministic offline series so the pipeline is demonstrable without network access.
function offlineSeries(n = 180) {
  const out = [];
  let level = 9_000;
  for (let i = 0; i < n; i++) {
    level *= Math.exp(0.0012 + Math.sin(i / 11) * 0.012);
    out.push(level * 1e6); // USDT base units, matching faceAmount
  }
  return out;
}

async function loadObligor(args) {
  if (args.offline) {
    return {
      obligor: "offline-demo",
      series: offlineSeries(),
      concentration: 0.18,
      obligorAgeDays: 720,
      source: "synthetic (offline mode)",
    };
  }

  const slug = args.slug;
  if (!slug || slug === true) throw new Error("--slug is required (or use --offline)");

  const series = await fetchFeeSeries(slug);
  return {
    obligor: slug,
    // DefiLlama reports USD; scale to USDT base units so it matches faceAmount.
    series: series.values.map((v) => v * 1e6),
    concentration: temporalConcentration(series.values),
    obligorAgeDays: obligorAgeDays(series),
    source: series.source,
  };
}

function printDecision(d, obligorMeta) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log("");
  console.log(`  obligor            ${obligorMeta.obligor}`);
  console.log(`  source             ${obligorMeta.source}`);
  console.log(`  observations       ${obligorMeta.series.length}`);
  console.log("");
  console.log(`  structural PD      ${pct(d.structural.pd)}`);
  console.log(`  venn-abers band    [${pct(d.structural.p0)}, ${pct(d.structural.p1)}]`);
  console.log(
    `  qualitative        ${d.llm.skipped ? `skipped (${d.llm.reason})` : `${d.llm.adjustment >= 0 ? "+" : ""}${(d.adjusted.effectiveMultiplier * 100).toFixed(1)}% [${d.llm.confidence}]`}`
  );
  console.log(`  final PD           ${pct(d.pd)}   upper ${pct(d.pdUpper)}`);
  console.log("");
  console.log(`  advance rate       ${d.pricing.advanceRateBps} bps`);
  console.log(`  discount           ${d.pricing.discountBps} bps  (breakeven ${d.pricing.breakevenBps})`);
  console.log(`  principal          ${(d.principal / 1e6).toFixed(2)} USDT`);
  console.log("");
  console.log("  top contributions to log-odds:");
  for (const c of d.contributions.slice(0, 5)) {
    const sign = c.contribution >= 0 ? "+" : "-";
    console.log(
      `    ${c.feature.padEnd(16)} ${String(c.value.toFixed(4)).padStart(12)}   ${sign}${Math.abs(c.contribution).toFixed(4)}`
    );
  }
  if (d.rationale.warnings.length) {
    console.log("");
    for (const w of d.rationale.warnings) console.log(`  WARNING: ${w}`);
  }
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "underwrite";

  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`No model at ${MODEL_PATH}\nRun: python3 agent/model/train.py`);
    process.exit(1);
  }
  const model = loadModel(MODEL_PATH);

  const faceUsdt = Number(args.face ?? 100_000);
  if (!Number.isFinite(faceUsdt) || faceUsdt <= 0) throw new Error("--face must be a positive number of USDT");
  const faceAmount = Math.round(faceUsdt * 1e6);

  const obligorMeta = await loadObligor(args);
  const decision = await underwrite(
    {
      obligor: obligorMeta.obligor,
      series: obligorMeta.series,
      concentration: obligorMeta.concentration,
      obligorAgeDays: obligorMeta.obligorAgeDays,
      faceAmount,
      context: args.context && args.context !== true ? String(args.context) : "",
    },
    { model }
  );

  printDecision(decision, obligorMeta);

  if (command === "underwrite") {
    if (args.out && args.out !== true) {
      fs.writeFileSync(String(args.out), JSON.stringify(decision.rationale, null, 2));
      console.log(`  rationale -> ${args.out}\n`);
    }
    return;
  }

  if (command !== "sign") {
    console.error(`Unknown command "${command}". Expected: underwrite | sign`);
    process.exit(1);
  }

  // ---- sign -------------------------------------------------------------
  const pk = process.env.UNDERWRITER_PRIVATE_KEY;
  const dealManager = process.env.DEAL_MANAGER_ADDRESS;
  const chainId = process.env.CHAIN_ID;
  const modelCommit = process.env.MODEL_COMMIT;

  const missing = [
    !pk && "UNDERWRITER_PRIVATE_KEY",
    !dealManager && "DEAL_MANAGER_ADDRESS",
    !chainId && "CHAIN_ID",
    !modelCommit && "MODEL_COMMIT",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Cannot sign - missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const signer = new ethers.Wallet(pk);
  const nowSec = Math.floor(Date.now() / 1000);
  const signed = await attest(
    decision,
    {
      dealId: makeDealId(obligorMeta.obligor, args.nonce ?? nowSec),
      borrower: String(args.borrower ?? (await signer.getAddress())),
      adapter: String(args.adapter ?? ethers.ZeroAddress),
      maturity: nowSec + Number(args.days ?? 30) * 86400,
      gracePeriod: Number(args.grace ?? 7) * 86400,
    },
    {
      signer,
      chainId: BigInt(chainId),
      dealManager,
      modelCommit,
      rationaleCID: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(decision.rationale))),
      registryView: null, // not checked offline; fundDeal will enforce it
      policy: { maxPdUpperBps: Number(args.maxPd ?? 3_000), firstLossBps: 1_500 },
    }
  );

  if (signed.problems.length) {
    console.error("  PREFLIGHT FAILED - not broadcastable:");
    for (const p of signed.problems) console.error(`    - ${p}`);
    process.exit(1);
  }
  console.log("  preflight          clean\n");

  const payload = {
    dealParams: {
      ...signed.dealParams,
      principal: signed.dealParams.principal.toString(),
    },
    attestation: signed.attestation,
    signature: signed.signature,
    termsHash: signed.termsHash,
    rationale: decision.rationale,
  };

  const outPath = args.out && args.out !== true ? String(args.out) : "deal.json";
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`  signed attestation -> ${outPath}\n`);
}

main().catch((err) => {
  console.error(`\n  ERROR: ${err.message}`);
  if (err.context) console.error(`  context: ${JSON.stringify(err.context, null, 2)}`);
  process.exit(1);
});
