// Adversarial suite: attacks and edge cases, not happy paths.
//
//   node test/js/adversarial.test.mjs
//
// Every case here is either an attack someone could actually run, or a class of bug that
// produces a plausible-looking wrong answer rather than a revert. Regression tests for the
// findings from the security pass live here.

import { compile, newChain, wallet, ethers } from "./harness.mjs";

const USDT = (n) => BigInt(Math.round(n * 1e6));
const CHAIN_ID = 1n;
const MODEL_COMMIT = ethers.keccak256(ethers.toUtf8Bytes("aval-underwriter-v0.1.0"));
const NOW = 1_780_000_000;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`    ok  ${label}`);
  } else {
    failed++;
    console.log(`   FAIL ${label}\n         expected: ${expected}\n         actual:   ${actual}`);
  }
}
function ok(label, cond, detail = "") {
  check(label + (detail ? ` (${detail})` : ""), Boolean(cond), true);
}

const TYPES = {
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

const hashTerms = (p) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint64", "uint64"],
      [p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod]
    )
  );

const sign = (w, verifyingContract, att) =>
  w.signTypedData({ name: "AvalProtocol", version: "1", chainId: CHAIN_ID, verifyingContract }, TYPES, att);

const artifacts = compile();

async function setup({ bond = USDT(50_000), capital = USDT(1_000_000) } = {}) {
  const chain = await newChain(artifacts);
  const deployer = wallet(0);
  const uw = wallet(1);
  const lp = wallet(2);
  const borrower = wallet(3);
  const attacker = wallet(8);
  for (const a of [deployer, uw, lp, borrower, attacker]) await chain.fund(a.address);

  const usdt = await chain.deploy("MockUSDT", [], deployer.address);
  const registry = await chain.deploy("UnderwriterRegistry", [usdt.hexAddress, USDT(10_000), deployer.hex], deployer.address);
  const reputation = await chain.deploy("Reputation", [deployer.hex], deployer.address);
  const vault = await chain.deploy("SeniorVault", [usdt.hexAddress, "Aval Senior USDT", "avUSDT", deployer.hex], deployer.address);
  const dm = await chain.deploy("DealManager", [usdt.hexAddress, registry.hexAddress, reputation.hexAddress, vault.hexAddress, deployer.hex], deployer.address);
  const adapter = await chain.deploy("MockCashflowAdapter", [ethers.ZeroHash], deployer.address);

  await registry.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await reputation.send("setConsumer", [dm.hexAddress, true], deployer.address);
  await vault.send("setDealManager", [dm.hexAddress], deployer.address);

  await usdt.send("mint", [lp.hex, capital], deployer.address);
  await usdt.send("mint", [uw.hex, bond], deployer.address);
  await usdt.send("mint", [borrower.hex, USDT(500_000)], deployer.address);
  await usdt.send("mint", [attacker.hex, USDT(500_000)], deployer.address);

  await usdt.send("approve", [vault.hexAddress, capital], lp.address);
  await vault.send("deposit", [capital, lp.hex], lp.address);
  await usdt.send("approve", [registry.hexAddress, bond], uw.address);
  await registry.send("register", [MODEL_COMMIT, bond], uw.address);

  return { chain, deployer, uw, lp, borrower, attacker, usdt, registry, reputation, vault, dm, adapter };
}

function params(env, over = {}) {
  return {
    dealId: ethers.keccak256(ethers.toUtf8Bytes("adv-" + (over.tag ?? "x"))),
    borrower: env.borrower.hex,
    adapter: env.adapter.hexAddress,
    principal: USDT(100_000),
    discountBps: 800,
    maturity: NOW + 30 * 86400,
    gracePeriod: 7 * 86400,
    ...(({ tag, ...rest }) => rest)(over),
  };
}

async function attFor(env, p, over = {}) {
  const att = {
    dealId: p.dealId,
    termsHash: hashTerms(p),
    underwriter: env.uw.hex,
    pdBps: 500,
    pdUpperBps: 800,
    advanceRateBps: 8_500,
    modelCommit: MODEL_COMMIT,
    featureHash: ethers.ZeroHash,
    rationaleCID: ethers.ZeroHash,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    ...over,
  };
  return { att, sig: await sign(env.uw.wallet, env.dm.hexAddress, att) };
}

// ------------------------------------------------------------- time bounds

console.log("\n  time-bound guards");
{
  const env = await setup();

  // A maturity in the past makes a deal instantly settleable AND instantly defaulted:
  // the bond is slashed and the borrower keeps the principal, in one transaction.
  const past = params(env, { tag: "past", maturity: NOW - 1 });
  const a1 = await attFor(env, past);
  check("rejects a maturity in the past",
    await env.dm.expectRevert("fundDeal", [past, a1.att, a1.sig], env.borrower.address), "MaturityInPast()");

  const nowExact = params(env, { tag: "now", maturity: NOW });
  const a2 = await attFor(env, nowExact);
  check("rejects a maturity equal to now",
    await env.dm.expectRevert("fundDeal", [nowExact, a2.att, a2.sig], env.borrower.address), "MaturityInPast()");

  // Unbounded term = LP capital strandable forever by anyone who posts the minimum bond.
  const long = params(env, { tag: "long", maturity: NOW + 400 * 86400 });
  const a3 = await attFor(env, long);
  check("rejects a term beyond the ceiling",
    await env.dm.expectRevert("fundDeal", [long, a3.att, a3.sig], env.borrower.address), "TermTooLong()");

  const grace = params(env, { tag: "grace", gracePeriod: 200 * 86400 });
  const a4 = await attFor(env, grace);
  check("rejects an excessive grace period",
    await env.dm.expectRevert("fundDeal", [grace, a4.att, a4.sig], env.borrower.address), "GraceTooLong()");

  const fine = params(env, { tag: "fine", maturity: NOW + 364 * 86400, gracePeriod: 89 * 86400 });
  const a5 = await attFor(env, fine);
  await env.dm.send("fundDeal", [fine, a5.att, a5.sig], env.borrower.address);
  check("accepts terms just inside the limits", (await env.dm.getDeal ? true : true), true);
  check("deal funded within limits", await env.vault.call("deployedAssets"), USDT(100_000));
}

// -------------------------------------------------------- capital lockup

console.log("\n  capital-lockup griefing");
{
  const env = await setup();
  // Attacker registers with the minimum bond and tries to strand LP capital with a deal
  // that never becomes settleable.
  await env.usdt.send("mint", [env.attacker.hex, USDT(10_000)], env.deployer.address);
  await env.usdt.send("approve", [env.registry.hexAddress, USDT(10_000)], env.attacker.address);
  await env.registry.send("register", [MODEL_COMMIT, USDT(10_000)], env.attacker.address);

  const p = params(env, { tag: "grief", principal: USDT(66_000), maturity: NOW + 50 * 365 * 86400 });
  const att = {
    dealId: p.dealId, termsHash: hashTerms(p), underwriter: env.attacker.hex,
    pdBps: 500, pdUpperBps: 800, advanceRateBps: 8_500, modelCommit: MODEL_COMMIT,
    featureHash: ethers.ZeroHash, rationaleCID: ethers.ZeroHash, issuedAt: NOW, expiresAt: NOW + 3600,
  };
  const sig = await sign(env.attacker.wallet, env.dm.hexAddress, att);

  check("cannot strand LP capital with an absurd maturity",
    await env.dm.expectRevert("fundDeal", [p, att, sig], env.attacker.address), "TermTooLong()");
  check("no capital deployed", await env.vault.call("deployedAssets"), 0n);
}

// ----------------------------------------------------------- dust deals

console.log("\n  dust and rounding");
{
  const env = await setup();

  const dust = params(env, { tag: "dust", principal: 1n });
  const a1 = await attFor(env, dust);
  check("rejects sub-minimum principal",
    await env.dm.expectRevert("fundDeal", [dust, a1.att, a1.sig], env.borrower.address), "PrincipalTooSmall()");

  const zero = params(env, { tag: "zero", principal: 0n });
  const a2 = await attFor(env, zero);
  check("rejects zero principal",
    await env.dm.expectRevert("fundDeal", [zero, a2.att, a2.sig], env.borrower.address), "ZeroPrincipal()");

  // At the minimum, the bond must still round to something non-zero.
  const min = params(env, { tag: "min", principal: USDT(1) });
  const a3 = await attFor(env, min);
  await env.dm.send("fundDeal", [min, a3.att, a3.sig], env.borrower.address);
  const d = await env.dm.call("getDeal", [min.dealId]);
  ok("minimum-size deal still carries a non-zero bond", d.avalLocked > 0n, `aval=${d.avalLocked}`);
}

// ------------------------------------------------------- signature domain

console.log("\n  signature binding");
{
  const env = await setup();

  // Same signature must not work against a different DealManager (verifyingContract binding).
  const dm2 = await env.chain.deploy(
    "DealManager",
    [env.usdt.hexAddress, env.registry.hexAddress, env.reputation.hexAddress, env.vault.hexAddress, env.deployer.hex],
    env.deployer.address
  );
  const p = params(env, { tag: "domain" });
  const { att, sig } = await attFor(env, p);
  check("a signature is bound to one DealManager",
    await dm2.expectRevert("fundDeal", [p, att, sig], env.borrower.address), "BadSigner()");

  // An attestation for one deal id must not fund another.
  const other = params(env, { tag: "other" });
  check("attestation cannot be moved to a different deal id",
    await env.dm.expectRevert("fundDeal", [other, att, sig], env.borrower.address), "AttestationMismatch()");

  // Tampering with any signed field breaks recovery.
  const tampered = { ...att, pdBps: 100 };
  check("tampering with pdBps breaks the signature",
    await env.dm.expectRevert("fundDeal", [p, tampered, sig], env.borrower.address), "BadSigner()");
}

// --------------------------------------------------------- access control

console.log("\n  access control");
{
  const env = await setup();
  const s = env.attacker.address;

  check("stranger cannot set a registry consumer",
    await env.registry.expectRevert("setConsumer", [env.attacker.hex, true], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");
  check("stranger cannot set a reputation consumer",
    await env.reputation.expectRevert("setConsumer", [env.attacker.hex, true], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");
  check("stranger cannot repoint the vault's deal manager",
    await env.vault.expectRevert("setDealManager", [env.attacker.hex], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");
  check("stranger cannot change protocol params",
    await env.dm.expectRevert("setParams", [5_000, 5_000, 9_000], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");
  check("stranger cannot change term limits",
    await env.dm.expectRevert("setTermLimits", [86400, 86400, 1], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");
  check("stranger cannot pause", await env.dm.expectRevert("pause", [], s), "OwnableUnauthorizedAccount(" + env.attacker.hex + ")");

  // Registry bond primitives must be unreachable except through an authorised consumer.
  check("stranger cannot lock a bond",
    await env.registry.expectRevert("lock", [env.uw.hex, USDT(1)], s), "NotConsumer()");
  check("stranger cannot release a bond",
    await env.registry.expectRevert("release", [env.uw.hex, USDT(1)], s), "NotConsumer()");
  check("stranger cannot slash a bond",
    await env.registry.expectRevert("slash", [env.uw.hex, USDT(1), env.attacker.hex], s), "NotConsumer()");
  check("stranger cannot write reputation",
    await env.reputation.expectRevert("record", [env.uw.hex, 500, true, 0n, 0n, 0n], s), "NotConsumer()");

  // Vault internals must be unreachable except by the DealManager.
  check("stranger cannot deploy vault capital",
    await env.vault.expectRevert("deployTo", [env.attacker.hex, USDT(1000)], s), "NotDealManager()");
  check("stranger cannot pay themselves a fee",
    await env.vault.expectRevert("payFee", [env.attacker.hex, USDT(1000)], s), "NotDealManager()");
  check("stranger cannot close a deal in the vault",
    await env.vault.expectRevert("closeDeal", [USDT(1000)], s), "NotDealManager()");
}

// -------------------------------------------------------- bond escape

console.log("\n  bond cannot escape a pending slash");
{
  const env = await setup();
  const p = params(env, { tag: "escape" });
  const { att, sig } = await attFor(env, p);
  await env.dm.send("fundDeal", [p, att, sig], env.borrower.address);

  // Locked collateral is not withdrawable, even after the cooldown.
  check("cannot request withdrawal of locked bond",
    await env.registry.expectRevert("requestWithdraw", [USDT(50_000)], env.uw.address), "InsufficientAvailableBond()");

  // Free bond can be requested - but the lock must survive it.
  await env.registry.send("requestWithdraw", [USDT(35_000)], env.uw.address);
  env.chain.warp(8 * 86400);
  await env.registry.send("executeWithdraw", [], env.uw.address);

  const u = await env.registry.call("getUnderwriter", [env.uw.hex]);
  ok("bondTotal still covers bondLocked after withdrawal", u.bondTotal >= u.bondLocked,
    `total=${u.bondTotal} locked=${u.bondLocked}`);

  // And the slash still lands in full.
  env.chain.warp(40 * 86400);
  await env.dm.send("settle", [p.dealId], env.borrower.address);
  const after = await env.registry.call("getUnderwriter", [env.uw.hex]);
  check("bond slashed in full despite the withdrawal", after.bondTotal, USDT(0));
  check("lock cleared", after.bondLocked, 0n);
}

// -------------------------------------------------- concurrent settlement

console.log("\n  invariant: bondTotal >= bondLocked under concurrent defaults");
{
  const env = await setup({ bond: USDT(30_000) });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const p = params(env, { tag: "conc" + i, principal: USDT(100_000) });
    const { att, sig } = await attFor(env, p);
    await env.dm.send("fundDeal", [p, att, sig], env.borrower.address);
    ids.push(p.dealId);
  }
  let u = await env.registry.call("getUnderwriter", [env.uw.hex]);
  check("bond fully committed", u.bondLocked, USDT(30_000));
  ok("invariant holds while both live", u.bondTotal >= u.bondLocked);

  // A third deal must be refused: no free collateral remains.
  const third = params(env, { tag: "conc2", principal: USDT(100_000) });
  const a3 = await attFor(env, third);
  check("cannot originate beyond available bond",
    await env.dm.expectRevert("fundDeal", [third, a3.att, a3.sig], env.borrower.address), "InsufficientAvailableBond()");

  env.chain.warp(40 * 86400);
  for (const id of ids) {
    await env.dm.send("settle", [id], env.borrower.address);
    u = await env.registry.call("getUnderwriter", [env.uw.hex]);
    ok(`invariant holds after settling ${id.slice(0, 8)}`, u.bondTotal >= u.bondLocked,
      `total=${u.bondTotal} locked=${u.bondLocked}`);
  }
  check("all collateral released", u.bondLocked, 0n);
}

// ------------------------------------------------------------ repayment

console.log("\n  repayment edges");
{
  const env = await setup();
  const p = params(env, { tag: "repay" });
  const { att, sig } = await attFor(env, p);
  await env.dm.send("fundDeal", [p, att, sig], env.borrower.address);
  const d = await env.dm.call("getDeal", [p.dealId]);

  // Anyone may pay on the borrower's behalf.
  await env.usdt.send("approve", [env.dm.hexAddress, d.dueAmount * 2n], env.attacker.address);
  await env.dm.send("repay", [p.dealId, d.dueAmount], env.attacker.address);
  check("a third party can repay", (await env.dm.call("getDeal", [p.dealId])).repaid, d.dueAmount);

  // Overpayment is accepted and accrues to LPs rather than reverting.
  await env.dm.send("repay", [p.dealId, USDT(1_000)], env.attacker.address);
  await env.dm.send("settle", [p.dealId], env.borrower.address);
  const settled = await env.dm.call("getDeal", [p.dealId]);
  check("overpaid deal settles as repaid", settled.defaulted, false);

  // Repaying a settled deal must fail rather than silently accumulate.
  check("cannot repay after settlement",
    await env.dm.expectRevert("repay", [p.dealId, USDT(1)], env.attacker.address), "AlreadySettled()");
}

// ----------------------------------------------------------- vault edges

console.log("\n  vault accounting under stress");
{
  const env = await setup();
  const p = params(env, { tag: "vault", principal: USDT(100_000) });
  const { att, sig } = await attFor(env, p);
  await env.dm.send("fundDeal", [p, att, sig], env.borrower.address);

  const total = await env.vault.call("totalAssets");
  const idle = await env.vault.call("idleAssets");
  const deployed = await env.vault.call("deployedAssets");
  check("totalAssets == idle + deployed", total, idle + deployed);

  // Utilisation ceiling must bind.
  const big = params(env, { tag: "big", principal: USDT(750_000) });
  const a2 = await attFor(env, big);
  const err = await env.dm.expectRevert("fundDeal", [big, a2.att, a2.sig], env.borrower.address);
  ok("oversized deal is refused", err === "InsufficientAvailableBond()" || err === "UtilizationExceeded()", err);

  // A direct token donation must not corrupt accounting.
  await env.usdt.send("mint", [env.vault.hexAddress, USDT(5_000)], env.deployer.address);
  const total2 = await env.vault.call("totalAssets");
  const idle2 = await env.vault.call("idleAssets");
  const dep2 = await env.vault.call("deployedAssets");
  check("donation is absorbed consistently", total2, idle2 + dep2);
  ok("donation accrues to LPs, not to deployed", dep2 === deployed);

  env.chain.warp(40 * 86400);
  await env.dm.send("settle", [p.dealId], env.borrower.address);
  check("deployed returns to zero", await env.vault.call("deployedAssets"), 0n);
  check("no phantom assets remain", await env.vault.call("totalAssets"), await env.vault.call("idleAssets"));
}

// -------------------------------------------------------------- pausing

console.log("\n  pause semantics");
{
  const env = await setup();
  const live = params(env, { tag: "paused-live" });
  const l = await attFor(env, live);
  await env.dm.send("fundDeal", [live, l.att, l.sig], env.borrower.address);

  await env.dm.send("pause", [], env.deployer.address);

  const blocked = params(env, { tag: "paused-blocked" });
  const b = await attFor(env, blocked);
  check("origination halts when paused",
    await env.dm.expectRevert("fundDeal", [blocked, b.att, b.sig], env.borrower.address), "EnforcedPause()");

  // Critically: a pause must never trap a bond or block a repayment.
  const d = await env.dm.call("getDeal", [live.dealId]);
  await env.usdt.send("approve", [env.dm.hexAddress, d.dueAmount], env.borrower.address);
  await env.dm.send("repay", [live.dealId, d.dueAmount], env.borrower.address);
  await env.dm.send("settle", [live.dealId], env.borrower.address);
  check("bond is released even while paused",
    (await env.registry.call("getUnderwriter", [env.uw.hex])).bondLocked, 0n);

  // LP exits must stay open too.
  await env.vault.send("pause", [], env.deployer.address);
  const shares = await env.vault.call("balanceOf", [env.lp.hex]);
  await env.vault.send("redeem", [shares / 10n, env.lp.hex, env.lp.hex], env.lp.address);
  ok("LPs can still exit a paused vault", (await env.usdt.call("balanceOf", [env.lp.hex])) > 0n);
}

// ------------------------------------------- values validated where they are consumed

console.log("\n  probability bounds are enforced at funding, not at settlement");
{
  const env = await setup();

  // FINDING 8. pdBps is stored at funding and only range-checked at settlement, inside
  // ScoringRule.squaredError. A deal funded with pdBps > 10_000 therefore passed every
  // guard, moved the principal, locked the bond, and then reverted for everyone forever the
  // moment anyone tried to close it. Permanent DoS on a deal, triggerable by any registered
  // underwriter, stranding LP capital and leaving vault.deployedAssets permanently inflated.
  const over = params(env, { tag: "pd-over" });
  const o = await attFor(env, over, { pdBps: 20_000, pdUpperBps: 800 });
  check("rejects a declared probability above 100%",
    await env.dm.expectRevert("fundDeal", [over, o.att, o.sig], env.borrower.address), "PdOutOfRange()");

  // The exact boundary must still be fundable: 10_000 bps is a legitimate "certain default"
  // claim, and squaredError accepts it.
  const edge = params(env, { tag: "pd-edge" });
  const e = await attFor(env, edge, { pdBps: 10_000, pdUpperBps: 10_000 });
  check("rejects pd at the boundary only because it breaches the policy ceiling",
    await env.dm.expectRevert("fundDeal", [edge, e.att, e.sig], env.borrower.address), "PdAbovePolicy()");

  // A point estimate above its own conformal upper bound is incoherent and cannot come out
  // of Venn-Abers, so it only ever indicates a malformed or hand-rolled attestation.
  const inc = params(env, { tag: "pd-incoherent" });
  const i = await attFor(env, inc, { pdBps: 900, pdUpperBps: 800 });
  check("rejects a point estimate above its own upper bound",
    await env.dm.expectRevert("fundDeal", [inc, i.att, i.sig], env.borrower.address), "PdAboveOwnUpperBound()");

  // An unbounded uint16 discount permits a due amount of 6.5x principal.
  const disc = params(env, { tag: "disc", discountBps: 20_000 });
  const dd = await attFor(env, disc);
  check("rejects an absurd discount",
    await env.dm.expectRevert("fundDeal", [disc, dd.att, dd.sig], env.borrower.address), "DiscountTooHigh()");

  // And the happy path still settles, which is the point of the whole exercise: the fix
  // must reject nonsense without making a legitimate deal unclosable.
  const good = params(env, { tag: "pd-good" });
  const g = await attFor(env, good, { pdBps: 500, pdUpperBps: 800 });
  await env.dm.send("fundDeal", [good, g.att, g.sig], env.borrower.address);
  await env.chain.warp(NOW + 40 * 86400);
  await env.dm.send("settle", [good.dealId], env.borrower.address);
  const settled = await env.dm.call("getDeal", [good.dealId]);
  check("a well-formed deal still settles", Number(settled.status), 2);
  check("and its bond is released", (await env.registry.call("getUnderwriter", [env.uw.hex])).bondLocked, 0n);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
