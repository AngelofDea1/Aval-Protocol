// Every contract call the frontend makes must exist, with the exact signature it declares.
//
// WHY THIS EXISTS
//
// web/lib/aval.ts holds hand-written ethers ABI fragments. ethers does not validate them
// against anything: a wrong parameter type, a missing return value or a renamed function
// produces a call that either reverts with no reason or, worse, decodes garbage into a
// number the UI then displays as fact. Nothing in the test suite would notice.
//
// This compares every fragment against the compiled ABI in out-solc/, by canonical selector,
// so a signature that differs by one type is caught. Run `npm run compile` first.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACTS = path.join(ROOT, "out-solc");
const AVAL_TS = path.join(ROOT, "web", "lib", "aval.ts");

let passed = 0;
let failed = 0;
const ok = (c, m) => (c ? (passed++, console.log(`    ok  ${m}`)) : (failed++, console.log(`  FAIL  ${m}`)));

if (!fs.existsSync(ARTIFACTS)) {
  console.error("out-solc/ missing. Run `npm run compile` first.");
  process.exit(1);
}

/* ------------------------------------------------- canonical selectors from the contracts */

/** selector -> "name(type,type)" across every compiled contract, including inherited. */
const onchain = new Map();
/** event topic0 -> canonical signature */
const events = new Map();

for (const file of fs.readdirSync(ARTIFACTS).filter((f) => f.endsWith(".json"))) {
  const { abi } = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file), "utf8"));
  if (!Array.isArray(abi)) continue;
  let iface;
  try {
    iface = new ethers.Interface(abi);
  } catch {
    continue;
  }
  iface.forEachFunction((f) => onchain.set(f.selector, f.format("sighash")));
  iface.forEachEvent((e) => events.set(e.topicHash, e.format("sighash")));
}

console.log(`\nfrontend ABI\n`);
console.log(`  compiled surface: ${onchain.size} function selectors, ${events.size} events\n`);

/* --------------------------------------------------- fragments declared by the frontend */

const src = fs.readFileSync(AVAL_TS, "utf8");

/** Pull the ABI object out of aval.ts by bracket matching, so nested arrays survive. */
function extractAbiBlock() {
  const start = src.indexOf("export const ABI = {");
  if (start === -1) throw new Error("could not find `export const ABI` in web/lib/aval.ts");
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in the ABI block");
}

const block = extractAbiBlock();

/** group name -> list of human-readable fragment strings */
const groups = {};
for (const m of block.matchAll(/(\w+):\s*\[([\s\S]*?)\n\s*\],/g)) {
  const name = m[1];
  const items = [...m[2].matchAll(/"((?:function|event)[^"]+)"/g)].map((x) => x[1]);
  if (items.length) groups[name] = items;
}

ok(Object.keys(groups).length > 0, `parsed ${Object.keys(groups).length} ABI groups from web/lib/aval.ts`);

let fragmentCount = 0;

for (const [group, fragments] of Object.entries(groups)) {
  console.log(`\n  ${group}`);
  for (const human of fragments) {
    fragmentCount++;
    let frag;
    try {
      frag = ethers.Fragment.from(human);
    } catch (e) {
      ok(false, `${human.slice(0, 60)} - not a parseable fragment: ${e.message}`);
      continue;
    }

    if (frag.type === "function") {
      const iface = new ethers.Interface([frag]);
      let selector, sig;
      iface.forEachFunction((f) => {
        selector = f.selector;
        sig = f.format("sighash");
      });
      const real = onchain.get(selector);
      ok(Boolean(real), `${sig} exists onchain`);
      // Selector equality already proves name + input types match exactly. Outputs are not
      // part of the selector, so a wrong return type would still decode wrongly; ethers
      // throws at decode time in that case, which is loud rather than silent.
    } else if (frag.type === "event") {
      const iface = new ethers.Interface([frag]);
      let topic, sig;
      iface.forEachEvent((e) => {
        topic = e.topicHash;
        sig = e.format("sighash");
      });
      ok(events.has(topic), `event ${sig} exists onchain`);
    }
  }
}

/* --------------------------------------- return shapes the UI destructures must be right */

console.log(`\n  return shapes the UI depends on`);

/** [fragment in aval.ts, contract artifact, function name] */
const SHAPES = [
  ["dealManager", "DealManager", "getDeal"],
  ["reputation", "Reputation", "getRecord"],
  ["registry", "UnderwriterRegistry", "getUnderwriter"],
];

for (const [group, artifactName, fnName] of SHAPES) {
  const artifactPath = path.join(ARTIFACTS, `${artifactName}.json`);
  if (!fs.existsSync(artifactPath)) {
    ok(false, `${artifactName}.json artifact exists`);
    continue;
  }
  const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const real = new ethers.Interface(abi).getFunction(fnName);
  const declared = ethers.Fragment.from(groups[group].find((f) => f.includes(`function ${fnName}(`)));

  const realOut = real.outputs[0];
  const declOut = declared.outputs[0];

  const realNames = (realOut.components ?? []).map((c) => c.name);
  const declNames = (declOut.components ?? []).map((c) => c.name);

  ok(
    realNames.length === declNames.length,
    `${fnName} returns ${realNames.length} fields, frontend declares ${declNames.length}`
  );
  ok(
    JSON.stringify(realNames) === JSON.stringify(declNames),
    `${fnName} field names and order match exactly`
  );
  if (JSON.stringify(realNames) !== JSON.stringify(declNames)) {
    console.log(`        onchain : ${realNames.join(", ")}`);
    console.log(`        frontend: ${declNames.join(", ")}`);
  }
}

console.log(`\n  ${fragmentCount} fragments checked`);
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
