#!/usr/bin/env node
/**
 * The AI underwrites a real borrower and funds the loan onchain, end to end.
 *
 *   node agent/src/fund.mjs --slug uniswap --face 50000 --borrower 0x... --dry-run
 *   node agent/src/fund.mjs --slug uniswap --face 50000 --borrower 0x...
 *
 * This is the command that makes the claim true. Everything else in the repo proves the
 * model works in tests; this puts a probability the model actually computed onto a public
 * chain, signed by the underwriter key, with the inputs hashed into the attestation.
 *
 * Order of operations matters. It scores first, preflights every constraint locally, and
 * only then broadcasts. A revert inside fundDeal tells you almost nothing; preflight tells
 * you exactly which constraint failed and why.
 *
 * Required env (see .env.example):
 *   UNDERWRITER_PRIVATE_KEY  key registered in UnderwriterRegistry
 *   DEAL_MANAGER_ADDRESS     deployed DealManager
 *   REGISTRY_ADDRESS         deployed UnderwriterRegistry
 *   MODEL_COMMIT             must equal the registry's stored commit for this underwriter
 *   XLAYER_TESTNET_RPC_URL   or XLAYER_RPC_URL
 *   PRIVATE_KEY              pays gas and receives the advance (the borrower side)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import { loadModel } from "./model-node.mjs";
import { fetchFeeSeries, obligorAgeDays, temporalConcentration } from "./ingest/defillama.mjs";
import { attest, makeDealId, underwrite } from "./underwrite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, "..", "model", "model.json");
const USDT = 1_000_000n;

const DEAL_MANAGER_ABI = [
  "function fundDeal((bytes32,address,address,uint256,uint16,uint64,uint64) p, (bytes32,bytes32,address,uint16,uint16,uint16,bytes32,bytes32,bytes32,uint64,uint64) a, bytes signature)",
  "function getDeal(bytes32) view returns (tuple(address borrower,address adapter,address underwriter,uint256 principal,uint256 dueAmount,uint256 avalLocked,uint256 repaid,uint64 maturity,uint64 gracePeriod,uint16 pdBps,uint8 status,bool defaulted))",
  "function hashTerms((bytes32,address,address,uint256,uint16,uint64,uint64) p) view returns (bytes32)",
  "function firstLossBps() view returns (uint16)",
  "function maxPdUpperBps() view returns (uint16)",
  "function paused() view returns (bool)",
];
const REGISTRY_ABI = [
  "function getUnderwriter(address) view returns (tuple(bool active,uint32 modelVersion,uint64 registeredAt,bytes32 modelCommit,uint256 bondTotal,uint256 bondLocked,uint256 withdrawRequested,uint64 withdrawUnlockAt))",
];
const ADAPTER_ABI = [
  "function dealObligor(bytes32) view returns (bytes32)",
  "function linkDeal(bytes32 dealId, bytes32 obligorId)",
  "function isEligible(bytes32) view returns (bool)",
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      out[k] = n === undefined || n.startsWith("--") ? true : argv[++i];
    } else out._.push(a);
  }
  return out;
}

const need = (k) => {
  const v = process.env[k];
  if (!v || v === "0x") throw new Error(`${k} is not set in .env`);
  return v;
};

/** Deterministic offline series so the flow is demonstrable without network access. */
function offlineSeries(n = 180) {
  const out = [];
  let level = 9_000;
  for (let i = 0; i < n; i++) {
    level *= Math.exp(0.0012 + Math.sin(i / 11) * 0.012);
    out.push(level * 1e6);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(`No trained model at ${MODEL_PATH}. Run: python3 agent/model/train.py`);
  }

  const rpc = process.env.XLAYER_TESTNET_RPC_URL || process.env.XLAYER_RPC_URL;
  if (!rpc) throw new Error("Set XLAYER_TESTNET_RPC_URL in .env");

  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  const chainId = net.chainId;

  const underwriterKey = need("UNDERWRITER_PRIVATE_KEY");
  const signer = new ethers.Wallet(underwriterKey, provider);
  const funder = new ethers.Wallet(need("PRIVATE_KEY"), provider);

  const dealManagerAddress = need("DEAL_MANAGER_ADDRESS");
  const registryAddress = need("REGISTRY_ADDRESS");
  const adapterAddress = process.env.ADAPTER_ADDRESS;
  const modelCommit = need("MODEL_COMMIT");

  const dm = new ethers.Contract(dealManagerAddress, DEAL_MANAGER_ABI, provider);
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);

  console.log(`\n  chain          ${chainId}`);
  console.log(`  underwriter    ${await signer.getAddress()}`);
  console.log(`  deal manager   ${dealManagerAddress}`);

  if (await dm.paused()) throw new Error("DealManager is paused, origination is halted");

  // ---- 1. gather the borrower's revenue history --------------------------
  let obligor, series, concentration, ageDays, source;
  if (args.offline) {
    obligor = "offline-demo";
    series = offlineSeries();
    concentration = 0.18;
    ageDays = 720;
    source = "deterministic offline series";
  } else {
    const slug = args.slug;
    if (!slug || slug === true) throw new Error("--slug is required (or use --offline)");
    console.log(`\n  fetching revenue history for "${slug}"...`);
    const fetched = await fetchFeeSeries(slug);
    obligor = slug;
    // DefiLlama reports USD; scale to USDT base units so it matches faceAmount.
    series = fetched.values.map((v) => v * 1e6);
    concentration = temporalConcentration(fetched.values);
    ageDays = obligorAgeDays(fetched);
    source = fetched.source;
    console.log(`  ${fetched.values.length} daily observations from ${source}`);
  }

  // ---- 2. the model decides ----------------------------------------------
  const faceUsdt = Number(args.face ?? 50_000);
  const faceAmount = Math.round(faceUsdt * 1e6);
  const model = loadModel(MODEL_PATH);

  const decision = await underwrite(
    { obligor, series, concentration, obligorAgeDays: ageDays, faceAmount, context: String(args.context ?? "") },
    { model }
  );

  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`\n  MODEL OUTPUT`);
  console.log(`  structural PD    ${pct(decision.structural.pd)}`);
  console.log(`  calibrated band  [${pct(decision.structural.p0)}, ${pct(decision.structural.p1)}]`);
  console.log(`  qualitative      ${decision.llm.skipped ? `skipped (${decision.llm.reason})` : `${(decision.adjusted.effectiveMultiplier * 100).toFixed(1)}%`}`);
  console.log(`  final PD         ${pct(decision.pd)}   upper ${pct(decision.pdUpper)}`);
  console.log(`  advance rate     ${decision.pricing.advanceRateBps} bps`);
  console.log(`  interest         ${decision.pricing.discountBps} bps`);
  console.log(`  principal        ${(decision.principal / 1e6).toFixed(2)} USDT`);

  if (decision.implausibleCoverage) {
    throw new Error("coverage is implausible, refusing to sign. Check that the series and faceAmount share units.");
  }

  // ---- 3. build and sign the attestation ----------------------------------
  const maxPdUpperBps = Number(await dm.maxPdUpperBps());
  const firstLossBps = Number(await dm.firstLossBps());
  const uwState = await registry.getUnderwriter(await signer.getAddress());

  const nowSec = Math.floor(Date.now() / 1000);
  const dealId = makeDealId(obligor, args.nonce ?? nowSec);
  const borrower = String(args.borrower ?? (await funder.getAddress()));

  const signed = await attest(
    decision,
    {
      dealId,
      borrower,
      adapter: adapterAddress ?? ethers.ZeroAddress,
      // Generous enough to survive broadcast latency; see SeedDemoLoan for why this matters.
      maturity: nowSec + Number(args.days ?? 30) * 86400,
      gracePeriod: Number(args.grace ?? 7) * 86400,
    },
    {
      signer,
      chainId,
      dealManager: dealManagerAddress,
      modelCommit,
      rationaleCID: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(decision.rationale))),
      registryView: {
        active: uwState.active,
        modelCommit: uwState.modelCommit,
        bondTotal: uwState.bondTotal,
        bondLocked: uwState.bondLocked,
      },
      policy: { maxPdUpperBps, firstLossBps },
      ttlSeconds: 3600,
    }
  );

  // ---- 4. preflight every constraint the contract enforces -----------------
  if (signed.problems.length) {
    console.error(`\n  PREFLIGHT FAILED, nothing was broadcast:`);
    for (const p of signed.problems) console.error(`    - ${p}`);
    process.exit(1);
  }
  const onchainTermsHash = await dm.hashTerms(toTuple(signed.dealParams));
  if (onchainTermsHash !== signed.termsHash) {
    throw new Error(`termsHash mismatch: contract says ${onchainTermsHash}, agent computed ${signed.termsHash}`);
  }
  console.log(`\n  preflight        clean`);
  console.log(`  deal id          ${dealId}`);
  console.log(`  bond to lock     ${((Number(signed.dealParams.principal) * firstLossBps) / 10_000 / 1e6).toFixed(2)} USDT`);

  const outPath = args.out && args.out !== true ? String(args.out) : null;
  if (outPath) {
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        { dealParams: { ...signed.dealParams, principal: signed.dealParams.principal.toString() },
          attestation: signed.attestation, signature: signed.signature, rationale: decision.rationale },
        null, 2
      )
    );
    console.log(`  written          ${outPath}`);
  }

  if (dryRun) {
    console.log(`\n  DRY RUN, nothing broadcast. Drop --dry-run to fund this loan.\n`);
    return;
  }

  // ---- 5. fund it ---------------------------------------------------------
  if (adapterAddress) {
    const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, funder);
    const obligorId = ethers.keccak256(ethers.toUtf8Bytes(obligor));
    if ((await adapter.dealObligor(dealId)) === ethers.ZeroHash && (await adapter.isEligible(obligorId))) {
      console.log(`\n  linking deal to obligor...`);
      await (await adapter.linkDeal(dealId, obligorId)).wait();
    }
  }

  console.log(`\n  broadcasting fundDeal...`);
  const dmWrite = new ethers.Contract(dealManagerAddress, DEAL_MANAGER_ABI, funder);
  const tx = await dmWrite.fundDeal(toTuple(signed.dealParams), toAttTuple(signed.attestation), signed.signature);
  console.log(`  tx               ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt.blockNumber}`);

  const deal = await dm.getDeal(dealId);
  console.log(`\n  FUNDED`);
  console.log(`  principal        ${(Number(deal.principal) / 1e6).toFixed(2)} USDT`);
  console.log(`  owed back        ${(Number(deal.dueAmount) / 1e6).toFixed(2)} USDT`);
  console.log(`  bond locked      ${(Number(deal.avalLocked) / 1e6).toFixed(2)} USDT`);
  console.log(`  PD onchain       ${(Number(deal.pdBps) / 100).toFixed(2)}%`);

  const explorer = chainId === 196n
    ? "https://www.okx.com/web3/explorer/xlayer"
    : "https://www.okx.com/web3/explorer/xlayer-test";
  console.log(`\n  ${explorer}/tx/${tx.hash}\n`);
}

/** ethers needs plain tuples for struct args, in declaration order. */
const toTuple = (p) => [p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod];
const toAttTuple = (a) => [
  a.dealId, a.termsHash, a.underwriter, a.pdBps, a.pdUpperBps, a.advanceRateBps,
  a.modelCommit, a.featureHash, a.rationaleCID, a.issuedAt, a.expiresAt,
];

main().catch((err) => {
  console.error(`\n  ERROR: ${err.message}`);
  if (err.context) console.error(`  context: ${JSON.stringify(err.context, null, 2)}`);
  process.exit(1);
});
