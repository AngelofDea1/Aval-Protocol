# Security

**Aval Protocol is unaudited.** This document records what was reviewed, what was found and
fixed, and which risks are knowingly accepted. An undocumented finding in a public repo is
worse than a documented accepted risk, so everything known is listed here - including the
things that are still wrong.

## Static analysis

Slither 0.11.6, 102 detectors across 41 contracts.

| Severity | Findings |
|---|---|
| High | **0** |
| Medium | **0** |
| Low | **0** |
| Informational | 4 |

The four informational findings are all the same detector, `unimplemented-functions`, claiming
that `UnderwriterRegistry`, `Reputation`, `ProtocolRevenueAdapter` and `InvoiceAdapter` do not
implement their interfaces.

**These are false positives**, and demonstrably so: every function named is present in the
compiled ABI of the deployed contract, marked `override`, and exercised by the test suite.
`web/lib/aval.ts` calls `getRecord`, `brierScore`, `realisedDefaultRateBps` and
`getUnderwriter` against the live deployment, and the ABI compatibility check verifies every
fragment by canonical selector. This detector is known to misreport interface implementations.

Reproduce:

```bash
slither . --exclude-dependencies --filter-paths "node_modules|mocks"
```

Aderyn has not been run.

## Test coverage

| Suite | Assertions | What it covers |
|---|---|---|
| `test/AvalProtocol.t.sol` | 28 tests | Foundry: lifecycle, fuzz, guards, pause |
| `test/js/aval.test.mjs` | 44 | Lifecycle on an in-process EVM |
| `test/js/adapters.test.mjs` | 21 | Adapter access control and monotonicity |
| `test/js/adversarial.test.mjs` | 55 | Attacks, edge cases, invariants |
| `test/js/manifest.test.mjs` | 48 | The agent manifest against the real ABI and errors |
| `test/js/model-sync.test.mjs` | 17 | The browser's copy of the model matches the agent's |
| `test/js/frontend-abi.test.mjs` | 47 | Every hand-written ABI fragment, by canonical selector |
| `test/js/ingest.test.mjs` | 31 | Revenue sources, and attacks on signed attestations |
| `agent/test/parity.test.mjs` | 734 | Python to JavaScript model parity, 1e-9 tolerance |
| `agent/test/underwrite.test.mjs` | 41 | Agent pipeline plus onchain end-to-end |

**1038 assertions across the nine JavaScript suites, plus 28 Foundry tests.** Reproduce with
`npm run test:all` and `forge test -vv`.

---

## Findings fixed

### 1. Attestation did not bind deal terms - CRITICAL

The EIP-712 signature covered only `dealId`. Anyone observing a valid attestation in the
mempool could call `fundDeal` with substituted `DealParams` - their own address as borrower
and `principal` set to the vault's entire idle balance - and the signature would still
verify. Full vault drain by a passive observer.

**Fix:** added `termsHash` to the attestation, a commitment over all seven economic terms,
checked in `fundDeal`.
**Regression:** `test_RejectsTermsSubstitution`, plus three assertions in the JS suite
including that altering the principal by one base unit invalidates the signature.

### 2. Maturity in the past - HIGH

`fundDeal` accepted any maturity. A deal whose maturity had already passed was instantly
settleable and instantly defaulted: the bond would be slashed and the borrower would keep
the principal, in a single transaction.

Terms are signed, so this could only arrive through an underwriter-side bug - but a
seconds/milliseconds mix-up in the agent is an ordinary mistake with total-loss
consequences, and the same units-confusion class had already been found once in the feature
pipeline. Refused outright rather than trusted.

**Fix:** `if (p.maturity <= block.timestamp) revert MaturityInPast();`
**Regression:** `test_RejectsMaturityInPast`, two adversarial assertions.

### 3. Unbounded term - capital lockup griefing - HIGH

Term and grace were unbounded. An attacker could register with the minimum bond
(10,000 USDT) and originate deals with a 50-year maturity, stranding roughly 6.7× that in
senior capital permanently. The bond is slashable, but the principal would never become
recoverable, so the attack costs the attacker their bond and costs LPs a multiple of it.

**Fix:** `maxTermSeconds` (365d) and `maxGraceSeconds` (90d), owner-configurable.
**Regression:** `test_RejectsExcessiveTerm`, `test_RejectsExcessiveGrace`, and a full
attack simulation in the adversarial suite.

### 4. Dust deals could carry no bond - MEDIUM

Below `10_000 / firstLossBps` base units the aval rounds to zero. Such a deal would be
recorded as a bonded prediction and scored on the leaderboard while carrying no first loss
at all - quietly polluting the calibration record with costless predictions.

**Fix:** `minPrincipal` plus an explicit `if (aval == 0) revert ZeroAval();`
**Regression:** `test_RejectsDustPrincipal`, `testFuzz_EveryDealCarriesNonZeroBond`.

### 5. No pause mechanism - MEDIUM

**Fix:** `Pausable` on `DealManager.fundDeal` and `SeniorVault._deposit`.

Pause semantics are deliberately asymmetric. Origination and deposits can be halted;
**repayment, settlement and LP withdrawals never can.** A pause that trapped an
underwriter's bond, blocked a borrower from repaying, or froze an LP's exit would be a worse
failure than whatever prompted it, and a vault that can trap capital is not one anyone
should deposit into.
**Regression:** three pause tests in each suite.

### 6. Division by zero in `deployTo` - LOW

`(newDeployed * 10_000) / totalAssets()` reverts opaquely on an empty vault. Unreachable
while `ZeroPrincipal` holds, but a confusing failure deep in the funding path.
**Fix:** explicit `total == 0` guard.

### 7. Units mismatch produced a plausible wrong answer - HIGH (offchain)

If the revenue series and `faceAmount` are in different units, coverage collapses by 10⁶ and
the model reports near-certain default while every output looks well-formed. Found while
writing the agent's own end-to-end test.
**Fix:** `implausibleCoverage` guard in `underwrite()` - warns loudly and records the
condition in the rationale. **Do not remove it.**
**Regression:** three assertions in `agent/test/underwrite.test.mjs`.

### 8. Out-of-range `pdBps` bricked settlement permanently - HIGH

`fundDeal` validated `pdUpperBps` against the policy ceiling but never range-checked
`pdBps`. That value is stored and then used once, at settlement, where
`ScoringRule.squaredError` requires it to be at most `10_000`.

So an attestation declaring `pdBps = 20_000` - a perfectly valid `uint16` - passed every
guard at funding. The principal moved to the borrower, the bond locked, and then `settle()`
reverted with `ScoringRule: pd out of range` for **every caller, permanently**.

The consequences compound. The deal can never be closed, so the bond stays locked forever;
`vault.deployedAssets` never falls, so `totalAssets()` counts unrecoverable principal as an
asset indefinitely; and the inflated share price lets earlier redeemers exit at the expense
of later ones. Any registered underwriter could do this at will, to any deal it priced.

Found by tracing which values are validated where they are *consumed* rather than where they
*enter*, and confirmed by funding such a deal against the compiled bytecode and watching four
different callers fail to settle it.

**Fix:** `if (a.pdBps > 10_000) revert PdOutOfRange();` in `fundDeal`. Two related bounds
added alongside it: `PdAboveOwnUpperBound` rejects a point estimate above its own conformal
upper bound, which Venn-Abers cannot produce and which therefore only ever signals a
hand-rolled attestation; and `DiscountTooHigh` caps `discountBps`, which was an unbounded
`uint16` permitting a due amount of 6.5x principal.

**Regression:** six assertions in `test/js/adversarial.test.mjs`, including that the exact
boundary still behaves correctly and that a well-formed deal still settles and releases its
bond.

**The general lesson, which is why this is written out at length:** validate a value where it
enters the system, not where it is consumed. A `require` deep inside a library is a correct
assertion and a terrible gate. It turns a rejected transaction into a stuck one.

---

## Verified properties

- **`bondTotal >= bondLocked` always**, including concurrent deals from one underwriter with
  interleaved defaults and withdrawals.
- **Locked collateral cannot escape a pending slash.** Free bond may be withdrawn after the
  7-day cooldown; locked bond cannot, and the re-check at execution time survives locks
  taken during the cooldown.
- **`totalAssets() == balance + deployedAssets`** under funding, settlement, default, and
  direct token donation.
- **Loss to LPs is exactly the shortfall beyond the bond.** Slashed collateral is paid into
  the vault before the deal's principal is retired.
- **Signatures are bound to one DealManager and one deal id.** Verified against a second
  deployment and against a substituted deal id.
- **The scoring rule is proper.** Fuzzed across the full probability range: on a default a
  higher declared PD earns more, on a repayment a lower one does, and neither bias wins in
  both states.
- **Access control is complete.** Every privileged entrypoint refuses a stranger - registry
  consumers, reputation writes, vault deployment and fee payment, params, term limits, pause.

---

## Accepted risks

**Owner is a single EOA.** `setParams`, `setTermLimits`, `setConsumer`, `setDealManager` and
`pause` are all fund-relevant. **Move ownership to a multisig before mainnet.** The deploy
script deliberately leaves ownership with the deployer and prints this as a required next
step.

**Fee-denial griefing.** `settle()` skips the underwriter's fee if the vault is momentarily
illiquid, so a large LP could withdraw immediately before settlement to deny it. Accepted
because the alternative - reverting - would freeze the bond indefinitely, which is worse.
A claimable fee balance would remove the tradeoff.

**Adapter reporters are trusted for reporting.** Offchain revenue is not natively observable
onchain, so an authorised reporter posts observed inflow. That reporter is trusted for
reporting but **not** for underwriting: the bond, the scoring rule and the settlement
waterfall are all independent of it. Reports are monotonic and evented, so misreporting is
detectable after the fact against the public source. The honest fix is routing revenue
through an onchain collection address the adapter reads directly.

**Two facts about the model that its own output does not make obvious.**

`max_drawdown` has a fitted coefficient of exactly `0.0`. On the synthetic training set it
carries no signal, so the model is eight features wide and seven deep. It is left in the vector
rather than removed, because dropping it would change `featureHash` and therefore every
attestation ever signed, but no claim should describe eight features as all contributing.

`log_scale` has a coefficient of `+0.0499`, meaning a larger business scores as very slightly
riskier. That reads backwards, and it is worth understanding rather than defending. Training
revenue averages `e^8.96`, about 7,800 a day, with a standard deviation of 2.5 in logs. A
protocol earning a million a day sits about two standard deviations above anything the model was
fitted on, so its scale contribution reaches roughly `+0.097` - visible in the top four drivers
while remaining economically trivial next to momentum at `-0.85` and coverage at `-0.71`.

The honest reading: **large DeFi protocols are out of distribution for a model trained on
SME-scale synthetic revenue.** The ranking of drivers is still informative and the probability is
still calibrated by Venn-Abers, but "size raises risk" is an artefact of extrapolation, not a
finding about credit. Anyone quoting this model on a protocol of that size should say so.

**The LLM overlay can move a marginal deal under the ceiling.** Stage 2 of the model is an
LLM adjustment over unstructured context, clamped in code to ±30% of the base PD
(`MAX_ADJUSTMENT = 0.30` in `agent/src/llm.mjs`). The interval is shifted by the same
multiplier so the overlay cannot silently collapse the model's own uncertainty - but shifting
it down is still shifting it. With `maxPdUpperBps = 3000`, a deal whose structural `pdUpper`
falls between 30.00% and 42.85% (3000 ÷ 0.7) can be pulled under the onchain ceiling by a
maximal downward adjustment. Anything above 42.85% is unreachable no matter what the LLM
returns, and `DealManager` reverts with `PdAbovePolicy` regardless of what was signed.

That window is deliberate rather than overlooked. An overlay that cannot change an outcome is
not an overlay. What bounds the damage is not the clamp but the economics: the underwriter
posts 15% of principal on every deal and is Brier-scored on the number it published, so an
operator whose LLM talks it into marginal loans pays for that itself, repeatedly and
publicly. **Nothing here requires the LLM to be correct.** That is the point of the protocol.

The mechanical protections, all asserted in `agent/test/underwrite.test.mjs`: out-of-range
output is clamped rather than trusted, saturation is reported via `hitClamp`, `NaN` and
malformed JSON are treated as no information, the result cannot be driven to a degenerate 0 or
1, and an error, timeout, missing key or empty body skips the stage with the reason recorded
in the rationale rather than blocking or silently zeroing. The site's `/api/price` route never
calls it at all. Stages 1 and 3 are deterministic and have 734 Python↔JavaScript parity
assertions behind them.

**Browser underwriting is testnet only, and must stay that way.** `/api/underwrite` prices a
business, signs an attestation with the underwriter's key, and hands it to the browser so a
visitor can call `fundDeal` themselves. It makes the Borrow tab a real product rather than a
calculator.

It is also, by construction, open. `fundDeal` never checks that the borrower has anything to do
with the revenue being scored: the underwriter's signature is the only gate. So an endpoint that
signs for whatever borrower the caller supplies lets anyone price a loan against a business they
have no connection to, take the principal into their own wallet, and never repay. The bond and
the vault's utilisation cap are the only limits. That is the same shape as finding 1, reachable
with an HTTP request rather than mempool observation.

Against MockUSDT on testnet this costs nothing and demonstrates the mechanism honestly. Against
real USDT it drains the vault. The route therefore **refuses chain 196 in code** and returns 403,
the same way `Seed.s.sol` refuses mainnet, because a warning nobody reads is not a control. Face
amount is capped, attestations expire in 15 minutes, and free bond is checked against the chain
before anything is signed.

**The fix, when it matters, is in the contract, not the endpoint:** bind the borrower to the
obligor so an advance can only be paid to the business whose revenue was scored. Until that
exists, browser underwriting is a demonstration and is labelled as one.

**Revenue attestors are identifiable, not bonded.** `agent/src/ingest/attested.mjs` lets a
business without public revenue borrow by presenting a daily series signed by a named
attestor. The signature covers a hash of every value, so the numbers cannot be edited after
signing, and 31 assertions in `test/js/ingest.test.mjs` confirm that editing one day, shifting
the start date, renaming the business, changing the currency, replaying onto another chain or
signing with an unregistered key are all rejected.

None of that makes the attestor *honest*. It makes them identifiable and committed to what
they said. An attestor who signs fiction costs the underwriter its bond, and the only
consequence today is that the underwriter stops accepting that key. **An attested deal is not
equivalent to one priced on public revenue and must not be described as such.** The obvious
next mechanism is bonding attestors under the same slashing rule the underwriter already
lives under - the protocol's whole argument is that an opinion should cost something, and
that argument applies to the party supplying the data too. Not built.

**Invoice double-financing is not checked.** `InvoiceAdapter` records commitments but does
not verify an invoice exists, was acknowledged by the buyer, or is not financed elsewhere - the classic receivables fraud. Documented in the contract. Do not describe it as solved.

**ERC-4626 first-depositor edge case.** OpenZeppelin 5 mitigates inflation attacks with
virtual shares. Seed the vault with a small deposit at deployment anyway; it removes the
edge case entirely and `deployTo` requires non-zero assets regardless.

**Timestamp dependence.** Maturity, grace and the withdrawal cooldown all read
`block.timestamp`. Validator manipulation is on the order of seconds against periods
measured in days. Flagged by `forge lint`; accepted.

**Settlement is permissionless, and the keeper automates it.** Anyone may call `settle()`.
This is deliberate: the contract reads its own state to decide the outcome, the amount
slashed and the fee paid, so the caller cannot influence the result and gains nothing from
calling. A keeper working from a stale view can only be early, which reverts with
`NotYetSettleable`. Contrast the monitor, which deliberately does **not** act, because
judging that a borrower has deteriorated is a decision a bot should not make alone.

**Model quality.** v0, trained on a synthetic bootstrap dataset (`agent/model/synth.py`).
Walk-forward Brier 0.196 against a 0.311 base rate - real signal, modest. Not a claim about
real-world accuracy. The defensible contribution is the mechanism.

---

## Before mainnet

- [ ] Transfer ownership to a multisig
- [x] Run Slither; fix or document every high and medium - done, see the top of this file
      (0 high, 0 medium, 0 low across 41 contracts). Aderyn has not been run.
- [ ] Seed the vault before opening deposits
- [ ] Set `USDT_ADDRESS` to real USDT - `MockUSDT` must never reach mainnet
- [ ] Verify chain id and RPC firsthand
- [ ] Keep initial TVL small
