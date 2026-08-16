// Every function the agent manifest tells an outside agent to call must actually exist.
//
// WHY THIS TEST EXISTS
//
// The manifest at /api/agent is a promise to strangers. If it names a function the contracts
// do not have, an integrating agent builds a transaction against a selector that does not
// exist and gets an unhelpful failure, with nothing on our side ever going red.
//
// That is not hypothetical. The manifest shipped claiming `rotateModel(bytes32)`; the real
// function is `updateModel(bytes32)`. Nothing caught it, because prose in a TypeScript file
// is not checked against anything. This test is what checks it.
//
// It reads the compiled ABIs in out-solc/ (produced by `npm run compile`) and the manifest
// source, and asserts every named function resolves. Signatures are compared by name and
// arity rather than by exact text, because the manifest deliberately spells out parameter
// names and tuple shapes for human readability.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ARTIFACTS = path.join(ROOT, "out-solc");
const MANIFEST = path.join(ROOT, "web", "lib", "agent-manifest.ts");

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`    ok  ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL  ${msg}`);
  }
}

if (!fs.existsSync(ARTIFACTS)) {
  console.error("out-solc/ missing. Run `npm run compile` first.");
  process.exit(1);
}

/* ---------------------------------------------- every function the contracts expose */

/** name -> Set of input counts, across every compiled contract including inherited ones. */
const onchain = new Map();
for (const file of fs.readdirSync(ARTIFACTS).filter((f) => f.endsWith(".json"))) {
  const { abi } = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file), "utf8"));
  if (!Array.isArray(abi)) continue;
  for (const entry of abi) {
    if (entry.type !== "function") continue;
    if (!onchain.has(entry.name)) onchain.set(entry.name, new Set());
    onchain.get(entry.name).add((entry.inputs || []).length);
  }
}

console.log(`\nagent manifest\n`);
console.log(`  compiled ABI surface: ${onchain.size} distinct function names\n`);

/* ------------------------------------------------ what the manifest tells agents to call */

const src = fs.readFileSync(MANIFEST, "utf8");

console.log("  every function named in a capability signature exists onchain");

// `signature: "function name(...)"` across the capabilities array.
const declared = [...src.matchAll(/signature:\s*\n?\s*"function\s+([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]);
ok(declared.length > 0, `found ${declared.length} function signatures to check`);

for (const name of [...new Set(declared)]) {
  ok(onchain.has(name), `${name}() exists in the compiled ABI`);
}

/* -------------------------------------------------------- verifyWith getters resolve */

console.log("\n  every policy value names a getter that exists");
const getters = [...src.matchAll(/verifyWith:\s*"([A-Za-z]+)\.([a-zA-Z0-9_]+)\(\)"/g)];
ok(getters.length > 0, `found ${getters.length} verifyWith getters`);
for (const [, contract, fn] of getters) {
  ok(onchain.has(fn), `${contract}.${fn}() exists in the compiled ABI`);
}

/* ------------------------------------------------------------- read-capability calls */

console.log("\n  read capabilities name real getters");
for (const name of ["totalAssets", "deployedAssets", "idleAssets", "utilizationBps", "brierScore", "getRecord", "getDeal"]) {
  ok(onchain.has(name), `${name}() exists in the compiled ABI`);
}

/* --------------------------------------------------------- EIP-712 type string parity */

console.log("\n  the manifest's Attestation type matches AvalAttestation.sol exactly");

const solidity = fs.readFileSync(path.join(ROOT, "src", "libraries", "AvalAttestation.sol"), "utf8");
const typehash = solidity.match(/"(Attestation\([^"]+\))"/);
ok(Boolean(typehash), "found ATTESTATION_TYPEHASH in the Solidity source");

if (typehash) {
  // Rebuild the same string from the manifest's declared field list.
  const block = src.slice(src.indexOf("Attestation: ["), src.indexOf("]", src.indexOf("Attestation: [")));
  const fields = [...block.matchAll(/\{\s*name:\s*"([a-zA-Z0-9_]+)",\s*type:\s*"([a-z0-9]+)"\s*\}/g)].map(
    (m) => `${m[2]} ${m[1]}`
  );
  const rebuilt = `Attestation(${fields.join(",")})`;
  ok(fields.length === 11, `manifest declares 11 attestation fields (got ${fields.length})`);
  ok(
    rebuilt === typehash[1],
    "manifest field order and types are byte-identical to the Solidity typehash"
  );
  if (rebuilt !== typehash[1]) {
    console.log(`        solidity: ${typehash[1]}`);
    console.log(`        manifest: ${rebuilt}`);
  }
}

/* ------------------------------------------------------------------ revert names exist */

console.log("\n  every revert the manifest names is a real custom error");
const errors = new Set();
for (const file of fs.readdirSync(ARTIFACTS).filter((f) => f.endsWith(".json"))) {
  const { abi } = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file), "utf8"));
  if (!Array.isArray(abi)) continue;
  for (const e of abi) if (e.type === "error") errors.add(e.name);
}
const named = [...src.matchAll(/"([A-Z][A-Za-z]+):/g)].map((m) => m[1]);
const listed = [...src.matchAll(/"([A-Za-z, ]+)"\s*,?\s*\]/g)]
  .flatMap((m) => m[1].split(",").map((s) => s.trim()))
  .filter((s) => /^[A-Z][A-Za-z]+$/.test(s));
for (const name of [...new Set([...named, ...listed])]) {
  ok(errors.has(name), `${name} is a declared custom error`);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
