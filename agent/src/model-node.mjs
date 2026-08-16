// Node-only loader for the underwriting model.
//
// model.mjs is deliberately free of any node import, because the same scoring code runs in
// the browser to price a borrower live on the site. Reading a file off disk is the one thing
// that cannot work there, so it lives here instead.
//
// Anything running under node should import loadModel from this file. Anything that already
// has the artifact as data should construct UnderwritingModel directly.

import fs from "node:fs";
import { UnderwritingModel } from "./model.mjs";

export { UnderwritingModel };

/** Read a trained artifact from disk and construct the model. */
export function loadModel(path) {
  return new UnderwritingModel(JSON.parse(fs.readFileSync(path, "utf8")));
}
