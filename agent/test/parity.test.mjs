// Python <-> JavaScript parity.
//
// Training runs in Python, inference runs in JavaScript. Nothing at runtime would catch a
// divergence: a drifted feature or a mismatched calibration still yields a plausible
// number, which is then signed, bonded, and acted on. This test is the only thing standing
// between that and production.
//
//   node agent/test/parity.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFeatures, FEATURE_ORDER } from "../src/features.mjs";
import { UnderwritingModel, pava } from "../src/model.mjs";
import { loadModel } from "../src/model-node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.resolve(__dirname, "..", "model");

const TOL = 1e-9;
let passed = 0;
let failed = 0;

function close(label, actual, expected, tol = TOL) {
  const a = Number(actual);
  const e = Number(expected);
  const diff = Math.abs(a - e);
  const scale = Math.max(1, Math.abs(e));
  if (Number.isFinite(a) && diff / scale <= tol) {
    passed++;
  } else {
    failed++;
    console.log(`   FAIL ${label}\n         expected ${e}\n         actual   ${a}\n         diff     ${diff}`);
  }
}

function ok(label, cond) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`   FAIL ${label}`);
  }
}

function requireFile(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`\nMissing ${path.basename(p)}.\nRun: ${hint}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- PAVA units

console.log("\n  PAVA");
{
  // Already isotonic -> unchanged.
  const a = pava([0, 0, 1, 1]);
  ok("leaves an isotonic sequence untouched", JSON.stringify(a) === JSON.stringify([0, 0, 1, 1]));

  // Single violation pools to the mean.
  const b = pava([1, 0]);
  close("pools a violating pair", b[0], 0.5);
  close("pools a violating pair (2)", b[1], 0.5);

  // Cascading merge.
  const c = pava([1, 1, 0, 0, 0]);
  ok("cascades merges", c.every((v) => Math.abs(v - 0.4) < 1e-12));

  ok("handles the empty case", pava([]).length === 0);
}

// ------------------------------------------------------------ feature parity

console.log("\n  features: JS vs Python");
{
  const p = path.join(MODEL_DIR, "feature_fixtures.json");
  requireFile(p, "python3 agent/model/export_feature_fixtures.py");
  const cases = JSON.parse(fs.readFileSync(p, "utf8"));

  let degenerate = 0;
  for (const [i, c] of cases.entries()) {
    if (c.series.length < 30) degenerate++;
    const got = buildFeatures(c.series, {
      concentration: c.concentration,
      obligorAgeDays: c.obligor_age_days,
      dueAmount: c.due_amount,
    });
    for (const k of FEATURE_ORDER) close(`case ${i} · ${k}`, got[k], c.expected[k]);
  }
  console.log(`    ${cases.length} cases (${degenerate} short/degenerate) × ${FEATURE_ORDER.length} features`);
}

// -------------------------------------------------------------- model parity

console.log("\n  model: JS vs Python");
{
  const modelPath = path.join(MODEL_DIR, "model.json");
  const fixturesPath = path.join(MODEL_DIR, "fixtures.json");
  requireFile(modelPath, "python3 agent/model/train.py");
  requireFile(fixturesPath, "python3 agent/model/train.py");

  const model = loadModel(modelPath);
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

  for (const [i, f] of fixtures.entries()) {
    const out = model.predict(f.features);
    close(`fixture ${i} · decision score`, out.score, f.score);
    close(`fixture ${i} · uncalibrated p`, out.pRaw, f.p_raw);
    close(`fixture ${i} · venn-abers p0`, out.p0, f.p0);
    close(`fixture ${i} · venn-abers p1`, out.p1, f.p1);
    close(`fixture ${i} · merged p`, out.pd, f.p_merged);
  }
  console.log(`    ${fixtures.length} fixtures × 5 quantities`);

  // Structural guarantees the rest of the agent relies on.
  for (const f of fixtures) {
    const out = model.predict(f.features);
    ok("p0 <= p1", out.p0 <= out.p1 + 1e-12);
    ok("pd within [0,1]", out.pd >= 0 && out.pd <= 1);
    ok("pdUpper >= pd", out.pdUpper >= out.pd - 1e-12);
  }

  // A mismatched feature order must fail loudly, not score silently.
  const broken = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  broken.feature_order = [...broken.feature_order].reverse();
  let threw = false;
  try {
    new UnderwritingModel(broken);
  } catch {
    threw = true;
  }
  ok("rejects an artifact whose feature order disagrees with the code", threw);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
