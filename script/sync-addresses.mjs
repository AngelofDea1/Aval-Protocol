#!/usr/bin/env node
/**
 * Propagate a fresh deployment's addresses everywhere they are written down.
 *
 * WHY THIS EXISTS
 *
 * Five files hardcode contract addresses: web/lib/aval.ts, web/lib/facts.ts,
 * script/verify-manifest.mjs, README.md and SUBMISSION.md. After a redeploy, editing them by
 * hand under deadline pressure is how a demo ends up pointed at a dead contract, or worse,
 * half-pointed: a frontend reading the new DealManager and the old vault, showing numbers
 * that are individually real and collectively meaningless.
 *
 * This reads the deployment record the deploy script already writes and rewrites all five,
 * then verifies nothing anywhere still mentions an old address.
 *
 *   bash script/deploy-testnet.sh          # writes deployments/1952.json and .env
 *   node script/sync-addresses.mjs         # propagate
 *   node script/sync-addresses.mjs --check # report drift, change nothing
 *
 * The deployment block matters as much as the addresses. Event scans start there, and X Layer
 * is past 37 million blocks: scanning from 0 is rejected by most public RPCs, so a wrong
 * value produces an app that loads forever or shows no deals at all.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = process.env.CHAIN_ID || "1952";
const CHECK_ONLY = process.argv.includes("--check");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

/* ------------------------------------------------------------------ inputs */

const deploymentPath = `deployments/${CHAIN_ID}.json`;
if (!fs.existsSync(path.join(ROOT, deploymentPath))) {
  console.error(`\n  ${deploymentPath} not found. Run the deploy first:\n`);
  console.error(`    bash script/deploy-testnet.sh\n`);
  process.exit(1);
}
const d = JSON.parse(read(deploymentPath));

/** USDT is deployed separately by the shell script, so it lands in .env rather than the JSON. */
function usdtFromEnv() {
  if (!fs.existsSync(path.join(ROOT, ".env"))) return null;
  const m = read(".env").match(/^USDT_ADDRESS=(0x[a-fA-F0-9]{40})/m);
  return m ? m[1] : null;
}

const usdt = d.usdt || usdtFromEnv();
if (!usdt) {
  console.error("\n  Could not find the USDT address in the deployment JSON or .env.\n");
  process.exit(1);
}

/**
 * The block the protocol went live at. Taken from the deployment record if present,
 * otherwise from the forge broadcast artifact, otherwise left for the operator to supply.
 */
function deployBlock() {
  const fromArg = process.argv.find((a) => a.startsWith("--deploy-block="));
  if (fromArg) return Number(fromArg.split("=")[1]);
  if (d.deployBlock) return Number(d.deployBlock);

  const bc = path.join(ROOT, "broadcast", "Deploy.s.sol", CHAIN_ID, "run-latest.json");
  if (fs.existsSync(bc)) {
    const b = JSON.parse(fs.readFileSync(bc, "utf8"));
    const blocks = (b.receipts || []).map((r) => Number(BigInt(r.blockNumber))).filter(Number.isFinite);
    if (blocks.length) return Math.min(...blocks);
  }
  return null;
}

const block = deployBlock();
if (block === null) {
  console.error("\n  Could not determine the deployment block.");
  console.error("  Pass it explicitly:  node script/sync-addresses.mjs --deploy-block=37717524\n");
  process.exit(1);
}

const NEW = {
  dealManager: d.dealManager,
  seniorVault: d.vault,
  underwriterRegistry: d.registry,
  reputation: d.reputation,
  protocolRevenueAdapter: d.protocolRevenueAdapter,
  usdt,
};

for (const [k, v] of Object.entries(NEW)) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(v || "")) {
    console.error(`\n  ${deploymentPath} is missing a valid address for ${k}: ${v}\n`);
    process.exit(1);
  }
}

console.log(`\n  chain ${CHAIN_ID}, deployment block ${block}\n`);
for (const [k, v] of Object.entries(NEW)) console.log(`    ${k.padEnd(24)} ${v}`);

/* ------------------------------------------------- what the repo currently believes */

const OLD = {};
{
  const facts = read("web/lib/facts.ts");
  for (const key of ["dealManager", "seniorVault", "underwriterRegistry", "reputation", "protocolRevenueAdapter"]) {
    const m = facts.match(new RegExp(`${key}:\\s*"(0x[a-fA-F0-9]{40})"`));
    if (m) OLD[key] = m[1];
  }
  const aval = read("web/lib/aval.ts");
  const mu = aval.match(/usdt:\s*"(0x[a-fA-F0-9]{40})"/);
  if (mu) OLD.usdt = mu[1];
}

const changed = Object.entries(NEW).filter(([k, v]) => OLD[k] && OLD[k].toLowerCase() !== v.toLowerCase());

if (changed.length === 0) {
  console.log(`\n  Everything already points at this deployment. Nothing to do.\n`);
  process.exit(0);
}

console.log(`\n  ${changed.length} address(es) differ from what the repo currently says:`);
for (const [k, v] of changed) console.log(`    ${k}: ${OLD[k]} -> ${v}`);

if (CHECK_ONLY) {
  console.log(`\n  --check: nothing written. Run without it to apply.\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ rewrite */

const FILES = [
  "web/lib/facts.ts",
  "web/lib/aval.ts",
  "script/verify-manifest.mjs",
  "README.md",
  "SUBMISSION.md",
];

let replacements = 0;
for (const file of FILES) {
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  let s = read(file);
  const before = s;

  // Replace by value, case-insensitively, so checksummed and lowercase forms both move.
  for (const [key, next] of Object.entries(NEW)) {
    const prev = OLD[key];
    if (!prev || prev.toLowerCase() === next.toLowerCase()) continue;
    s = s.replace(new RegExp(prev, "gi"), next);
  }

  if (s !== before) {
    write(file, s);
    const n = (before.match(/0x[a-fA-F0-9]{40}/g) || []).length;
    replacements++;
    console.log(`    updated ${file}`);
  }
}

// Deployment block, which lives in exactly one place.
{
  const p = "web/lib/aval.ts";
  const s = read(p);
  const next = s.replace(/deployBlock:\s*\d+/, `deployBlock: ${block}`);
  if (next !== s) {
    write(p, next);
    console.log(`    updated ${p} deployBlock -> ${block}`);
  }
}

/* ------------------------------------------------------------------- verify */

console.log(`\n  verifying no old address survives anywhere`);
let stale = 0;
for (const [key, prev] of Object.entries(OLD)) {
  if (!prev || prev.toLowerCase() === NEW[key].toLowerCase()) continue;
  for (const file of FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    if (new RegExp(prev, "i").test(read(file))) {
      console.log(`    STALE  ${prev} still in ${file}`);
      stale++;
    }
  }
}
console.log(stale === 0 ? `    clean, ${replacements} file(s) rewritten` : `    ${stale} stale reference(s) remain`);

console.log(`
  Next:
    npm run check              confirm the new deployment is wired and healthy
    npm run check:manifest     confirm /api/agent matches it
    npm run test:all           nothing broke
    cd web && npm run build    the site still builds
`);

process.exit(stale === 0 ? 0 : 1);
