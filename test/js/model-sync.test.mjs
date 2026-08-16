// The model the website prices with must be the model the agent underwrites with.
//
// web/lib/underwriting/ holds copies of the scoring code, because the web app builds with
// `web` as its root and cannot rely on reaching outside it. Copies drift. This is what stops
// them: every copy must be byte-identical to its source, or the suite goes red.
//
// The failure this prevents is quiet and expensive. A borrower is shown a probability by the
// site, decides to accept, and the agent then scores them differently because one of the two
// copies moved. The number a judge sees on the page would not be the number the contract
// gets. There is no runtime check that would ever catch that.

import { SYNCED, withBanner, readSource, readCopy } from "../../script/sync-model-to-web.mjs";

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

console.log("\nmodel sync: web copies match the agent originals\n");

for (const [source, name] of Object.entries(SYNCED)) {
  const copy = readCopy(name);

  if (copy === null) {
    ok(false, `${name} exists (run: npm run sync:model)`);
    continue;
  }

  let expected = withBanner(source, readSource(source));

  // Mirrors the one transformation sync applies: the CLI smoke-test block at the end of
  // defillama.mjs is stripped, since it reads process.argv and has no meaning in a route.
  if (name === "defillama.mjs") {
    const marker = "// Manual smoke check:";
    const cut = expected.indexOf(marker);
    if (cut !== -1) expected = expected.slice(0, cut).trimEnd() + "\n";
  }

  const same = copy === expected;
  ok(same, `${name} is byte-identical to ${source}`);
  if (!same) {
    console.log(`        copy ${copy.length} bytes, source ${expected.length} bytes`);
    console.log(`        fix with: npm run sync:model`);
  }
}

/* --------------------------------------------- the copy actually scores identically */

const { UnderwritingModel } = await import("../../agent/src/model.mjs");
const { UnderwritingModel: WebModel } = await import("../../web/lib/underwriting/model.mjs");
const { buildFeatures } = await import("../../agent/src/features.mjs");
const { buildFeatures: webBuildFeatures } = await import("../../web/lib/underwriting/features.mjs");
const { priceDeal } = await import("../../agent/src/pricing.mjs");
const { priceDeal: webPriceDeal } = await import("../../web/lib/underwriting/pricing.mjs");
const { default: artifact } = await import("../../agent/model/model.json", { with: { type: "json" } });
const { default: webArtifact } = await import("../../web/lib/underwriting/model.json", { with: { type: "json" } });

console.log("\n  both copies produce the same number on real-shaped input");

const agentModel = new UnderwritingModel(artifact);
const webModel = new WebModel(webArtifact);

// A few different revenue shapes, so this is not one lucky case.
const shapes = {
  steady: Array.from({ length: 400 }, () => 50_000e6),
  growing: Array.from({ length: 400 }, (_, i) => (30_000 + i * 100) * 1e6),
  volatile: Array.from({ length: 400 }, (_, i) => (40_000 + (i % 7) * 12_000) * 1e6),
  declining: Array.from({ length: 400 }, (_, i) => Math.max(5_000, 90_000 - i * 180) * 1e6),
};

for (const [label, series] of Object.entries(shapes)) {
  const opts = { concentration: 0.12, obligorAgeDays: 900, dueAmount: 50_000e6, horizonDays: 30 };
  const a = agentModel.predict(buildFeatures(series, opts));
  const w = webModel.predict(webBuildFeatures(series, opts));

  ok(a.pd === w.pd, `${label}: pd identical (${a.pd.toFixed(12)})`);
  ok(a.pdUpper === w.pdUpper, `${label}: pdUpper identical`);

  const pa = priceDeal({ pd: a.pd, pdUpper: a.pdUpper });
  const pw = webPriceDeal({ pd: w.pd, pdUpper: w.pdUpper });
  ok(
    pa.advanceRateBps === pw.advanceRateBps && pa.discountBps === pw.discountBps,
    `${label}: pricing identical (advance ${pa.advanceRateBps}bps, discount ${pa.discountBps}bps)`
  );
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
