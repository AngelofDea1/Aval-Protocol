#!/usr/bin/env node
/**
 * Copy the underwriting model into the web app.
 *
 * WHY COPY RATHER THAN IMPORT ACROSS THE BOUNDARY
 *
 * The site prices a borrower live using the real model, so the web app needs this code. It
 * could import it as `../../agent/src/model.mjs`, and that resolves fine locally. But Vercel
 * builds with `web` as the root directory, and a deploy that silently excludes the parent
 * directory fails at build time on someone else's machine, days later, for reasons nobody
 * remembers. Copying removes that class of failure entirely.
 *
 * The cost of copying is drift, which is the exact thing this project refuses to accept
 * anywhere else. So it is not accepted here either: test/js/model-sync.test.mjs asserts every
 * copy is byte-identical to its source, and fails the build if it is not.
 *
 *   node script/sync-model-to-web.mjs        # copy
 *   node test/js/model-sync.test.mjs         # verify
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "web", "lib", "underwriting");

/** source relative to repo root -> filename in web/lib/underwriting */
export const SYNCED = {
  "agent/src/model.mjs": "model.mjs",
  "agent/src/features.mjs": "features.mjs",
  "agent/src/pricing.mjs": "pricing.mjs",
  "agent/src/ingest/defillama.mjs": "defillama.mjs",
  "agent/model/model.json": "model.json",
};

const BANNER = `// GENERATED FILE. DO NOT EDIT.
//
// Copied verbatim from {SOURCE} by script/sync-model-to-web.mjs.
// Edit the original, then run: npm run sync:model
//
// test/js/model-sync.test.mjs fails if this file differs from its source, so the two cannot
// drift apart without the test suite going red.
`;

/** The banner is prepended to JS but never to JSON, which must stay parseable. */
export function withBanner(source, contents) {
  if (source.endsWith(".json")) return contents;
  return BANNER.replace("{SOURCE}", source) + "\n" + contents;
}

export function readSource(source) {
  return fs.readFileSync(path.join(ROOT, source), "utf8");
}

export function readCopy(name) {
  const p = path.join(DEST, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function main() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const [source, name] of Object.entries(SYNCED)) {
    let contents = readSource(source);
    // defillama.mjs ends with a CLI smoke-test block guarded by process.argv, which has no
    // meaning in a bundled server route and would reference `process` in a browser build.
    if (name === "defillama.mjs") {
      const marker = "// Manual smoke check:";
      const cut = contents.indexOf(marker);
      if (cut !== -1) contents = contents.slice(0, cut).trimEnd() + "\n";
    }
    fs.writeFileSync(path.join(DEST, name), withBanner(source, contents));
    console.log(`  ${source} -> web/lib/underwriting/${name}`);
  }
  console.log(`\n${Object.keys(SYNCED).length} files synced.`);
}

/**
 * `file://${process.argv[1]}` is the idiom you see everywhere and it is wrong the moment a
 * path contains a space, because import.meta.url is percent-encoded and the raw path is not.
 * This repository lives under "Aval Protocol", so the naive form never matches and the script
 * silently does nothing. pathToFileURL encodes it the same way.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
