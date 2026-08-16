// Attacks against the revenue ingest layer.
//
// This layer decides what number the underwriter posts collateral against, which makes it a
// more attractive target than the contracts: there is no point draining a vault if you can
// simply persuade the model that a failing business is a thriving one.
//
// Every test below is an attempt to get a false series accepted.

import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  fetchAttestedSeries,
  hashRevenueSeries,
  signRevenueAttestation,
  verifyRevenueAttestation,
  MAX_ATTESTATION_AGE_SECONDS,
} from "../../agent/src/ingest/attested.mjs";
import {
  SOURCES,
  SOURCE_IDS,
  fetchRevenueSeries,
  MIN_OBSERVATIONS,
  obligorAgeDays,
  temporalConcentration,
} from "../../agent/src/ingest/index.mjs";

let passed = 0;
let failed = 0;
const group = (name) => console.log(`\n  ${name}`);
function ok(name, fn) {
  try {
    fn();
    console.log(`    ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`    FAIL  ${name}\n          ${err.message}`);
    failed++;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    console.log(`    ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`    FAIL  ${name}\n          ${err.message}`);
    failed++;
  }
}
async function rejects(name, fn, match) {
  await okAsync(name, async () => {
    await assert.rejects(fn, (err) => {
      assert.match(err.message, match, `wrong error: ${err.message}`);
      return true;
    });
  });
}

const CHAIN_ID = 1952;
const NOW = 1_786_800_000;

const attestorKey = ethers.Wallet.createRandom();
const impostorKey = ethers.Wallet.createRandom();
const ATTESTORS = new Map([[attestorKey.address, "Demo Payments Ltd"]]);

/** 90 days of a plausible small business: about 1,200 a day in cents, with weekly seasonality. */
function bakeryCents(days = 90) {
  return Array.from({ length: days }, (_, i) =>
    Math.round(120_000 * (1 + 0.25 * Math.sin((i / 7) * 2 * Math.PI)) + i * 40)
  );
}

async function makeAttestation(overrides = {}, signer = attestorKey) {
  const base = {
    business: "hakim-bakery",
    currency: "GBP",
    startDate: NOW - 90 * 86400,
    minorUnits: bakeryCents(),
    issuedAt: NOW - 3600,
  };
  const merged = { ...base, ...overrides };
  return signRevenueAttestation(signer, merged, CHAIN_ID);
}

console.log("\ningest layer");

/* ------------------------------------------------------------------ the registry */

group("the registry refuses to start on an undeclared trust assumption");

ok("every registered source states what a lender must believe", () => {
  for (const id of SOURCE_IDS) {
    assert.equal(typeof SOURCES[id].trust, "string");
    assert.ok(SOURCES[id].trust.length > 20, `${id} has a token trust string`);
  }
});

ok("every registered source is daily, because the model is trained on daily", () => {
  for (const id of SOURCE_IDS) assert.equal(SOURCES[id].period, "daily");
});

ok("the public source claims no trust and the attested one names its own", () => {
  assert.match(SOURCES.defillama.trust, /Nobody/);
  assert.match(SOURCES.attested.trust, /attestor/i);
});

await rejects(
  "an unregistered source id cannot be reached",
  () => fetchRevenueSeries("../../etc/passwd", "x"),
  /unknown revenue source/
);

/* ------------------------------------------------------------------- the hashing */

group("hashing the series");

ok("the same values hash the same way twice", () => {
  assert.equal(hashRevenueSeries([1, 2, 3]), hashRevenueSeries([1, 2, 3]));
});

ok("changing one day by one penny changes the hash", () => {
  assert.notEqual(hashRevenueSeries([1, 2, 3]), hashRevenueSeries([1, 2, 4]));
});

ok("reordering the days changes the hash", () => {
  assert.notEqual(hashRevenueSeries([1, 2, 3]), hashRevenueSeries([3, 2, 1]));
});

ok("a trailing zero day is not the same as no day at all", () => {
  assert.notEqual(hashRevenueSeries([1, 2, 3]), hashRevenueSeries([1, 2, 3, 0]));
});

ok("floats are refused rather than silently rounded", () => {
  assert.throws(() => hashRevenueSeries([1.5, 2]), /integers in minor units/);
});

ok("negative revenue is refused", () => {
  assert.throws(() => hashRevenueSeries([1, -2]), /non-negative/);
});

/* ---------------------------------------------------------------- the happy path */

group("a genuine attestation");

await okAsync("verifies and recovers the attestor", async () => {
  const a = await makeAttestation();
  const v = verifyRevenueAttestation(a, { chainId: CHAIN_ID, now: NOW });
  assert.equal(v.attestor, attestorKey.address);
  assert.equal(v.days, 90);
});

await okAsync("produces the same shape the public source produces", async () => {
  const a = await makeAttestation();
  const s = await fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  for (const k of ["slug", "source", "fetchedAt", "points", "values"]) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.values.length, 90);
  assert.equal(s.points.length, 90);
});

await okAsync("minor units become major units exactly once", async () => {
  const a = await makeAttestation({ minorUnits: [100_00, 250_50, 1_00] });
  const s = await fetchAttestedSeries(
    { ...a, minorUnits: [100_00, 250_50, 1_00] },
    { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW }
  );
  assert.deepEqual(s.values, [100, 250.5, 1]);
});

await okAsync("days are contiguous, so a missing week cannot hide in the gaps", async () => {
  const a = await makeAttestation();
  const s = await fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  for (let i = 1; i < s.points.length; i++) {
    assert.equal(s.points[i].timestamp - s.points[i - 1].timestamp, 86400);
  }
});

await okAsync("the source string names who signed it", async () => {
  const a = await makeAttestation();
  const s = await fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  assert.match(s.source, /Demo Payments Ltd/);
  assert.match(s.source, new RegExp(attestorKey.address));
});

/* ---------------------------------------------------------------------- the attacks */

group("attacks");

await rejects(
  "editing a single day after signing is caught",
  async () => {
    const a = await makeAttestation();
    const tampered = { ...a, minorUnits: [...a.minorUnits] };
    tampered.minorUnits[45] += 1;
    return fetchAttestedSeries(tampered, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /did not recover|not by an attestor/
);

await rejects(
  "inflating the whole series is caught",
  async () => {
    const a = await makeAttestation();
    const tampered = { ...a, minorUnits: a.minorUnits.map((v) => v * 10) };
    return fetchAttestedSeries(tampered, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /did not recover|not by an attestor/
);

await rejects(
  "a valid signature from an unregistered key is refused",
  async () => {
    const a = await makeAttestation({}, impostorKey);
    return fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /not by an attestor this pool has registered/
);

await rejects(
  "an attestation for another chain does not work here",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries(a, { chainId: 196, attestors: ATTESTORS, now: NOW });
  },
  /not by an attestor this pool has registered/
);

await rejects(
  "a stale attestation is refused",
  async () => {
    const a = await makeAttestation({ issuedAt: NOW - MAX_ATTESTATION_AGE_SECONDS - 86400 });
    return fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /days old/
);

await rejects(
  "an attestation dated in the future is refused",
  async () => {
    const a = await makeAttestation({ issuedAt: NOW + 86400 });
    return fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /dated in the future/
);

await rejects(
  "a series running into the future is refused",
  async () => {
    const a = await makeAttestation({ startDate: NOW - 10 * 86400, minorUnits: bakeryCents(60) });
    return fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /runs into the future/
);

await rejects(
  "renaming the business after signing is caught",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries(
      { ...a, business: "someone-elses-bakery" },
      { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW }
    );
  },
  /not by an attestor this pool has registered/
);

await rejects(
  "changing the currency after signing is caught",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries({ ...a, currency: "USD" }, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /not by an attestor this pool has registered/
);

await rejects(
  "shifting the start date after signing is caught",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries(
      { ...a, startDate: a.startDate - 30 * 86400 },
      { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW }
    );
  },
  /not by an attestor this pool has registered/
);

await rejects(
  "an empty attestor registry accepts nothing",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries(a, { chainId: CHAIN_ID, attestors: new Map(), now: NOW });
  },
  /no attestors are registered/
);

await rejects(
  "a garbage signature is refused",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries({ ...a, signature: "0xdead" }, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  /65-byte hex/
);

await rejects(
  "an attestation with no chainId is refused rather than defaulted",
  async () => {
    const a = await makeAttestation();
    return fetchAttestedSeries(a, { attestors: ATTESTORS, now: NOW });
  },
  /needs a chainId/
);

await rejects(
  "too little history is refused by the registry, not scored",
  async () => {
    const a = await makeAttestation({ startDate: NOW - 20 * 86400, minorUnits: bakeryCents(20) });
    return fetchRevenueSeries("attested", a, { chainId: CHAIN_ID, attestors: ATTESTORS, now: NOW });
  },
  new RegExp(`at least ${MIN_OBSERVATIONS}`)
);

/* -------------------------------------------------------- it reaches the model intact */

group("the model cannot tell where the numbers came from");

await okAsync("an attested series scores exactly like the same series from anywhere else", async () => {
  const { loadModel } = await import("../../agent/src/model-node.mjs");
  const { buildFeatures } = await import("../../agent/src/features.mjs");
  const { fileURLToPath } = await import("node:url");
  const model = loadModel(
    fileURLToPath(new URL("../../agent/model/model.json", import.meta.url))
  );

  const a = await makeAttestation();
  const series = await fetchRevenueSeries("attested", a, {
    chainId: CHAIN_ID,
    attestors: ATTESTORS,
    now: NOW,
  });

  // The same numbers, arriving as if from the public source. Nothing but provenance differs.
  const asIfPublic = [...series.values];

  const opts = {
    concentration: temporalConcentration(series.values),
    obligorAgeDays: obligorAgeDays(series),
    dueAmount: 51_000,
    horizonDays: 30,
  };
  const a1 = model.predict(buildFeatures(series.values, opts));
  const a2 = model.predict(buildFeatures(asIfPublic, opts));

  assert.equal(a1.pd, a2.pd, "provenance changed the price");
  assert.equal(a1.pdUpper, a2.pdUpper, "provenance changed the ceiling");
  assert.ok(a1.pd > 0 && a1.pd < 1, `pd out of range: ${a1.pd}`);
});

await okAsync("the trust assumption travels with the data", async () => {
  const a = await makeAttestation();
  const series = await fetchRevenueSeries("attested", a, {
    chainId: CHAIN_ID,
    attestors: ATTESTORS,
    now: NOW,
  });
  assert.equal(series.sourceId, "attested");
  assert.match(series.trust, /attestor/i);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
