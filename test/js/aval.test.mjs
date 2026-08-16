// Full lifecycle tests for Aval Protocol.
//
//   node test/js/aval.test.mjs
//
// Covers: bonding, EIP-712 attestation verification and its rejection paths, the happy
// path, the default/slash waterfall, and - most importantly - that the Brier-scored fee
// actually rewards honest probability reporting.

import { compile, newChain, wallet, ethers } from "./harness.mjs";

const USDT = (n) => BigInt(Math.round(n * 1e6));
const CHAIN_ID = 1n;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`    ok  ${label}`);
  } else {
    failed++;
    console.log(`   FAIL ${label}\n         expected: ${expected}\n         actual:   ${actual}`);
  }
}

function checkTrue(label, cond) {
  check(label, Boolean(cond), true);
}

const MODEL_COMMIT = ethers.keccak256(ethers.toUtf8Bytes("aval-underwriter-v0.1.0"));

function attestationTypes() {
  return {
    Attestation: [
      { name: "dealId", type: "bytes32" },
      { name: "termsHash", type: "bytes32" },
      { name: "underwriter", type: "address" },
      { name: "pdBps", type: "uint16" },
      { name: "pdUpperBps", type: "uint16" },
      { name: "advanceRateBps", type: "uint16" },
      { name: "modelCommit", type: "bytes32" },
      { name: "featureHash", type: "bytes32" },
      { name: "rationaleCID", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
    ],
  };
}

async function signAttestation(signer, verifyingContract, att) {
  const domain = { name: "AvalProtocol", version: "1", chainId: CHAIN_ID, verifyingContract };
  return signer.signTypedData(domain, attestationTypes(), att);
}

async function setup(artifacts) {
  const chain = await newChain(artifacts);
  const deployer = wallet(0);
  const uw = wallet(1);
  const lp = wallet(2);
  const borrower = wallet(3);

  for (const a of [deployer, uw, lp, borrower]) await chain.fund(a.address);

  const usdt = await chain.deploy("MockUSDT", [], deployer.address);
  const registry = await chain.deploy(
    "UnderwriterRegistry",
    [usdt.hexAddress, USDT(10_000), deployer.hex],
    deployer.address
  );
  const reputation = await chain.deploy("Reputation", [deployer.hex], deployer.address);
  const vault = await chain.deploy(
    "SeniorVault",
    [usdt.hexAddress, "Aval Senior USDT", "avUSDT", deployer.hex],
    deployer.address
  );
  const dm = await chain.deploy(
    "DealManager",
    [usdt.hexAddress, registry.hexAddress, reputation.hexAddress, vault.hexAddress, deployer.hex],
    deployer.address
  );

  await registry.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await reputation.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await vault.send("setDealManager", [dm.hexAddress], deployer.address);

  // Seed balances.
  await usdt.send("mint", [lp.hex, USDT(1_000_000)], deployer.address);
  await usdt.send("mint", [uw.hex, USDT(50_000)], deployer.address);
  await usdt.send("mint", [borrower.hex, USDT(200_000)], deployer.address);

  // LP supplies senior capital.
  await usdt.send("approve", [vault.hexAddress, USDT(1_000_000)], lp.address);
  await vault.send("deposit", [USDT(1_000_000), lp.hex], lp.address);

  // Underwriter posts its bond.
  await usdt.send("approve", [registry.hexAddress, USDT(50_000)], uw.address);
  await registry.send("register", [MODEL_COMMIT, USDT(50_000)], uw.address);

  return { chain, deployer, uw, lp, borrower, usdt, registry, reputation, vault, dm };
}

/// Mirror of DealManager.hashTerms. Must stay byte-identical to the contract.
function hashTerms(p) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint64", "uint64"],
      [p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod]
    )
  );
}

function makeAttestation(p, uwHex, { pdBps = 500, pdUpperBps = 1200, expiresAt = 1_790_000_000 } = {}) {
  const dealId = p.dealId;
  return {
    dealId,
    termsHash: hashTerms(p),
    underwriter: uwHex,
    pdBps,
    pdUpperBps,
    advanceRateBps: 8_500,
    modelCommit: MODEL_COMMIT,
    featureHash: ethers.keccak256(ethers.toUtf8Bytes("features:" + dealId)),
    rationaleCID: ethers.keccak256(ethers.toUtf8Bytes("ipfs:" + dealId)),
    issuedAt: 1_780_000_000,
    expiresAt,
  };
}

function dealParams(dealId, borrowerHex, adapterHex, { principal = USDT(100_000), discountBps = 800 } = {}) {
  return {
    dealId,
    borrower: borrowerHex,
    adapter: adapterHex,
    principal,
    discountBps,
    maturity: 1_780_000_000 + 30 * 86400,
    gracePeriod: 7 * 86400,
  };
}

// ---------------------------------------------------------------------------

async function testSetupAndBonding(artifacts) {
  console.log("\n  setup and bonding");
  const { registry, vault, uw } = await setup(artifacts);

  const u = await registry.call("getUnderwriter", [uw.hex]);
  check("bond posted", u.bondTotal, USDT(50_000));
  check("nothing locked yet", u.bondLocked, 0n);
  check("model version starts at 1", u.modelVersion, 1n);
  check("vault total assets", await vault.call("totalAssets"), USDT(1_000_000));
}

async function testAttestationRejections(artifacts) {
  console.log("\n  attestation verification");
  const { chain, uw, borrower, dm } = await setup(artifacts);
  const adapter = await chain.deploy(
    "MockCashflowAdapter",
    [ethers.keccak256(ethers.toUtf8Bytes("protocol-revenue-v1"))],
    borrower.address
  );

  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-reject"));
  const p = dealParams(dealId, borrower.hex, adapter.hexAddress);

  // Signed by the wrong key.
  const imposter = wallet(9);
  const att = makeAttestation(p, uw.hex);
  const badSig = await signAttestation(imposter.wallet, dm.hexAddress, att);
  check("rejects a forged signature", await dm.expectRevert("fundDeal", [p, att, badSig], borrower.address), "BadSigner()");

  // Model commit that does not match what the registry holds.
  const staleAtt = { ...att, modelCommit: ethers.keccak256(ethers.toUtf8Bytes("some-other-model")) };
  const staleSig = await signAttestation(uw.wallet, dm.hexAddress, staleAtt);
  check(
    "rejects an undeclared model version",
    await dm.expectRevert("fundDeal", [p, staleAtt, staleSig], borrower.address),
    "StaleModelCommit()"
  );

  // PD above the protocol's policy ceiling.
  const riskyAtt = makeAttestation(p, uw.hex, { pdUpperBps: 5_000 });
  const riskySig = await signAttestation(uw.wallet, dm.hexAddress, riskyAtt);
  check(
    "rejects PD above policy",
    await dm.expectRevert("fundDeal", [p, riskyAtt, riskySig], borrower.address),
    "PdAbovePolicy()"
  );

  // Expired attestation.
  const expiredAtt = makeAttestation(p, uw.hex, { expiresAt: 1_779_000_000 });
  const expiredSig = await signAttestation(uw.wallet, dm.hexAddress, expiredAtt);
  check(
    "rejects an expired attestation",
    await dm.expectRevert("fundDeal", [p, expiredAtt, expiredSig], borrower.address),
    "AttestationExpired()"
  );

  // The offchain signer and the contract must agree on the terms commitment exactly.
  check("offchain hashTerms matches the contract", await dm.call("hashTerms", [p]), hashTerms(p));
}

async function testTermsSubstitutionAttack(artifacts) {
  console.log("\n  terms substitution attack");
  const { chain, uw, borrower, vault, dm } = await setup(artifacts);
  const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], borrower.address);

  // A legitimate attestation for a 100k advance to `borrower`, as the underwriter intended.
  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-substitution"));
  const honest = dealParams(dealId, borrower.hex, adapter.hexAddress, { principal: USDT(100_000) });
  const att = makeAttestation(honest, uw.hex);
  const sig = await signAttestation(uw.wallet, dm.hexAddress, att);

  // An attacker observes the signed attestation and replays it with substituted params:
  // themselves as borrower, and a principal up to the vault's entire idle balance.
  const attacker = wallet(7);
  await chain.fund(attacker.address);
  const looted = dealParams(dealId, attacker.hex, adapter.hexAddress, { principal: USDT(800_000) });

  check(
    "cannot substitute borrower and principal under a valid signature",
    await dm.expectRevert("fundDeal", [looted, att, sig], attacker.address),
    "TermsMismatch()"
  );
  check("vault untouched", await vault.call("deployedAssets"), 0n);

  // Changing any single term invalidates the attestation.
  const nudged = dealParams(dealId, borrower.hex, adapter.hexAddress, { principal: USDT(100_001) });
  check(
    "cannot alter principal by even one unit",
    await dm.expectRevert("fundDeal", [nudged, att, sig], attacker.address),
    "TermsMismatch()"
  );

  // The honest terms still fund normally.
  await dm.send("fundDeal", [honest, att, sig], borrower.address);
  check("intended terms still fund", await vault.call("deployedAssets"), USDT(100_000));
}

async function testHappyPath(artifacts) {
  console.log("\n  happy path: funded, repaid, settled");
  const { chain, uw, borrower, usdt, registry, reputation, vault, dm } = await setup(artifacts);
  const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], borrower.address);

  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-happy"));
  const p = dealParams(dealId, borrower.hex, adapter.hexAddress);
  const att = makeAttestation(p, uw.hex, { pdBps: 500 });
  const sig = await signAttestation(uw.wallet, dm.hexAddress, att);

  await dm.send("fundDeal", [p, att, sig], borrower.address);

  const deal = await dm.call("getDeal", [dealId]);
  check("principal advanced", deal.principal, USDT(100_000));
  check("amount due includes the discount", deal.dueAmount, USDT(108_000));
  check("first-loss bond locked at 15%", deal.avalLocked, USDT(15_000));
  check("borrower received funds", await usdt.call("balanceOf", [borrower.hex]), USDT(300_000));
  check("vault total assets unchanged by funding", await vault.call("totalAssets"), USDT(1_000_000));
  check("vault deployed", await vault.call("deployedAssets"), USDT(100_000));
  check("bond locked in registry", (await registry.call("getUnderwriter", [uw.hex])).bondLocked, USDT(15_000));

  // Repay in full.
  await usdt.send("approve", [dm.hexAddress, USDT(108_000)], borrower.address);
  await dm.send("repay", [dealId, USDT(108_000)], borrower.address);
  await dm.send("settle", [dealId], borrower.address);

  // pd = 500bps, outcome 0  ->  squared error 250_000 / 1e8  ->  fee = 99.75% of 1_000
  check("underwriter earns a Brier-scored fee", await usdt.call("balanceOf", [uw.hex]), USDT(997.5));
  check("bond fully released", (await registry.call("getUnderwriter", [uw.hex])).bondLocked, 0n);
  check("deployed back to zero", await vault.call("deployedAssets"), 0n);
  check("LPs keep interest net of the fee", await vault.call("totalAssets"), USDT(1_007_002.5));

  const rec = await reputation.call("getRecord", [uw.hex]);
  check("one prediction recorded", rec.predictions, 1n);
  check("no defaults", rec.defaults, 0n);
  check("squared error accumulated", rec.sumSquaredError, 250_000n);
  check("Brier score (1e18 scaled)", await reputation.call("brierScore", [uw.hex]), 2_500_000_000_000_000n);
}

async function testDefaultAndSlash(artifacts) {
  console.log("\n  default: bond is slashed into the senior vault");
  const { chain, uw, borrower, usdt, registry, reputation, vault, dm } = await setup(artifacts);
  const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], borrower.address);

  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-default"));
  const p = dealParams(dealId, borrower.hex, adapter.hexAddress);
  const att = makeAttestation(p, uw.hex, { pdBps: 500 }); // confidently wrong
  const sig = await signAttestation(uw.wallet, dm.hexAddress, att);

  await dm.send("fundDeal", [p, att, sig], borrower.address);

  check(
    "cannot settle before maturity",
    await dm.expectRevert("settle", [dealId], borrower.address),
    "NotYetSettleable()"
  );

  chain.warp(38 * 86400); // past maturity + grace, nothing repaid
  await dm.send("settle", [dealId], borrower.address);

  const deal = await dm.call("getDeal", [dealId]);
  checkTrue("deal marked defaulted", deal.defaulted);

  // Loss 108_000, bond covers 15_000 of it.
  check("bond slashed in full", (await registry.call("getUnderwriter", [uw.hex])).bondTotal, USDT(35_000));
  check("bond lock cleared", (await registry.call("getUnderwriter", [uw.hex])).bondLocked, 0n);

  // pd = 500bps, outcome 1 -> squared error 90_250_000/1e8 -> fee = 9.75% of 1_000
  check("confidently wrong underwriter forfeits most of its fee", await usdt.call("balanceOf", [uw.hex]), USDT(97.5));

  // LPs: -100_000 principal +15_000 slashed -97.5 fee
  check("LPs wear only the loss beyond the bond", await vault.call("totalAssets"), USDT(914_902.5));
  check("deployed back to zero", await vault.call("deployedAssets"), 0n);

  const rec = await reputation.call("getRecord", [uw.hex]);
  check("default recorded", rec.defaults, 1n);
  check("slash recorded", rec.totalSlashed, USDT(15_000));
  check("Brier score degraded", await reputation.call("brierScore", [uw.hex]), 902_500_000_000_000_000n);
}

async function testProperScoringIncentive(artifacts) {
  console.log("\n  incentive: honest reporting beats shading the number");

  // Same deal, same outcome (default). The only difference is the reported probability.
  async function feeFor(pdBps, willDefault) {
    const { chain, uw, borrower, usdt, dm } = await setup(artifacts);
    const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], borrower.address);
    const dealId = ethers.keccak256(ethers.toUtf8Bytes(`deal-${pdBps}-${willDefault}`));
    const p = dealParams(dealId, borrower.hex, adapter.hexAddress);
    const att = makeAttestation(p, uw.hex, { pdBps, pdUpperBps: Math.min(pdBps + 200, 3000) });
    const sig = await signAttestation(uw.wallet, dm.hexAddress, att);
    await dm.send("fundDeal", [p, att, sig], borrower.address);

    if (willDefault) {
      chain.warp(38 * 86400);
    } else {
      await usdt.send("approve", [dm.hexAddress, USDT(108_000)], borrower.address);
      await dm.send("repay", [dealId, USDT(108_000)], borrower.address);
    }
    await dm.send("settle", [dealId], borrower.address);
    return usdt.call("balanceOf", [uw.hex]);
  }

  const lowPdDefault = await feeFor(200, true);
  const highPdDefault = await feeFor(2_900, true);
  checkTrue("on a default, the more cautious forecast is paid more", highPdDefault > lowPdDefault);

  const lowPdRepaid = await feeFor(200, false);
  const highPdRepaid = await feeFor(2_900, false);
  checkTrue("on a repayment, the more confident forecast is paid more", lowPdRepaid > highPdRepaid);

  // Properness: neither extreme dominates across outcomes, so the fee-maximising report
  // tracks the underwriter's true belief rather than a fixed bias in either direction.
  checkTrue("no direction of bias wins in both states", lowPdDefault < highPdDefault && lowPdRepaid > highPdRepaid);
}

async function testDoubleFundAndSettleGuards(artifacts) {
  console.log("\n  guards");
  const { chain, uw, borrower, usdt, dm } = await setup(artifacts);
  const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], borrower.address);
  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-guards"));
  const p = dealParams(dealId, borrower.hex, adapter.hexAddress);
  const att = makeAttestation(p, uw.hex);
  const sig = await signAttestation(uw.wallet, dm.hexAddress, att);

  await dm.send("fundDeal", [p, att, sig], borrower.address);
  check("cannot fund the same deal twice", await dm.expectRevert("fundDeal", [p, att, sig], borrower.address), "DealExists()");

  await usdt.send("approve", [dm.hexAddress, USDT(108_000)], borrower.address);
  await dm.send("repay", [dealId, USDT(108_000)], borrower.address);
  await dm.send("settle", [dealId], borrower.address);
  check("cannot settle twice", await dm.expectRevert("settle", [dealId], borrower.address), "AlreadySettled()");

  const unknown = ethers.keccak256(ethers.toUtf8Bytes("nope"));
  check("unknown deal reverts", await dm.expectRevert("settle", [unknown], borrower.address), "DealNotFound()");
}

// ---------------------------------------------------------------------------

const t0 = Date.now();
console.log("compiling...");
const artifacts = compile();
console.log(`compiled ${Object.keys(artifacts).length} contracts`);

await testSetupAndBonding(artifacts);
await testAttestationRejections(artifacts);
await testTermsSubstitutionAttack(artifacts);
await testHappyPath(artifacts);
await testDefaultAndSlash(artifacts);
await testProperScoringIncentive(artifacts);
await testDoubleFundAndSettleGuards(artifacts);

console.log(`\n  ${passed} passed, ${failed} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
process.exit(failed > 0 ? 1 : 0);
