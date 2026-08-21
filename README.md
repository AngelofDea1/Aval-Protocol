# Aval Protocol

**Bonded AI underwriting for tokenized real-world cashflows.** Built on X Layer.

An *aval* is a trade-finance instrument: a third party's written guarantee on a bill of
exchange, making the guarantor jointly liable. That is the mechanism here - the AI
underwriter does not just score the credit, it guarantees it with its own capital.

> Every AI credit product asks you to trust a black-box score. Aval makes the model post a
> bond against its own predictions, slashes it when it is wrong, and publishes its
> calibration onchain - so credit risk is priced by a track record, not a pitch deck.

## Start here

**Live app:** https://aval-protocol.vercel.app
**Agent manifest:** https://aval-protocol.vercel.app/api/agent

Live on **X Layer Mainnet, chain 196.** (Originally deployed and proven on testnet, where a real loan was funded against a signed AI opinion, repaid, settled, and the underwriter earned a Brier-scored fee with its accuracy written onchain.)

| Contract | Address |
|---|---|
| `DealManager` | [`0x0f9bF65cb7f2549EA41012A9D692986bE633d52F`](https://www.okx.com/web3/explorer/xlayer-test/address/0x0f9bF65cb7f2549EA41012A9D692986bE633d52F) |
| `SeniorVault` | [`0x0D410fbc0942919F0ab8a55B1fbbFF5E9dc3D3fa`](https://www.okx.com/web3/explorer/xlayer-test/address/0x0D410fbc0942919F0ab8a55B1fbbFF5E9dc3D3fa) |
| `UnderwriterRegistry` | [`0xd0424f9908C36D3E91AFaEf6C546eeD7D8E742E2`](https://www.okx.com/web3/explorer/xlayer-test/address/0xd0424f9908C36D3E91AFaEf6C546eeD7D8E742E2) |
| `Reputation` | [`0xCBda55841d6C1EE5585155F52d4cecA50ce53fA5`](https://www.okx.com/web3/explorer/xlayer-test/address/0xCBda55841d6C1EE5585155F52d4cecA50ce53fA5) |

### If you have five minutes

1. **[Open the app](https://aval-protocol.vercel.app/app)**, go to **Borrow**, pick a business
   and press **Price it.** The real model scores real revenue in the browser. No wallet, no
   gas, no signature.
2. **Loans tab.** Expand any loan. The model version and a hash of its exact inputs are
   onchain, so a prediction cannot be revised after the fact.
3. **[`SECURITY.md`](SECURITY.md).** Eight findings we found and fixed, including a critical
   one, and every risk still accepted.

### If you have an hour

| Look at | Why |
|---|---|
| [`src/libraries/ScoringRule.sol`](src/libraries/ScoringRule.sol) | The proper scoring rule, and why the bond is deliberately *not* risk-scaled |
| [`src/DealManager.sol`](src/DealManager.sol) | Funding, the settlement waterfall, and the `termsHash` fix |
| [`agent/src/ingest/index.mjs`](agent/src/ingest/index.mjs) | Why a revenue source cannot be registered without declaring what it asks you to trust |
| [`test/js/adversarial.test.mjs`](test/js/adversarial.test.mjs) | The attacks we ran against ourselves |
| [`agent/model/venn_abers.py`](agent/model/venn_abers.py) | Distribution-free calibration |

```bash
npm install && npm run test:all   # 1038 assertions, nine suites
forge test -vv                    # 28 tests
npm run check                     # read the live deployment and report its state
```

### What we do not claim

The model is **v0, trained on synthetic data, and has never seen a real default.** The
contracts are **unaudited.** Revenue attestors are identifiable but **not yet bonded.** All
three are stated in full in [`SECURITY.md`](SECURITY.md) rather than left to be discovered.

## The mechanism

Three legs, deliberately kept separate.

**Solvency - a fixed first-loss bond.** The underwriter locks a fixed share of principal per
deal. On default it is slashed into the senior vault, so LPs wear only the shortfall beyond
it.

The bond is *not* scaled by the model's own probability estimate. That would pay the
underwriter to under-report risk in order to post less collateral.

**Calibration - a strictly proper scoring rule.** The fee is paid under the Brier rule,
`S(p, o) = 1 - (p - o)²`. Expected fee is uniquely maximised by reporting true belief;
shading the number in either direction loses money in expectation. Honest calibration is a
dominant strategy rather than something the protocol must trust or police. Forfeited fees
accrue to LPs.

**Reputation - an onchain calibration record.** Every prediction and realised outcome is
recorded, with a running Brier score per underwriter: a public, comparable, unfalsifiable
track record. A low score can only be earned by making bonded predictions that came true.

## The model

Three stages, `agent/model/` (training, Python) and `agent/src/` (inference, JavaScript).

1. **Structural.** Logistic regression over eight cashflow features - coverage, trend,
   volatility, drawdown, concentration, scale, obligor age, momentum. Seven of them carry
   weight: `max_drawdown` fits to exactly zero on this dataset, which is reported rather than
   quietly dropped, because a feature the model ignores is a fact about the model. Gradient boosting is
   trained alongside and reported, but does not beat the linear model out-of-time at this
   sample size, and interpretability matters when the output sizes a bonded credit decision.

2. **Qualitative overlay.** An LLM reads unstructured context and returns a signed
   adjustment with a written rationale, **hard-clamped to ±30% of the base PD in code**. It
   can contribute judgement; it cannot hallucinate a loan into existence. If it errors or
   times out, underwriting proceeds on the structural model alone and the skip is recorded.

3. **Venn-Abers calibration.** A distribution-free probability interval, valid under
   exchangeability alone - no assumption that the model is well-specified. The point
   estimate is what the underwriter is scored on; the interval's upper edge drives the
   protocol's risk ceiling, so model uncertainty tightens underwriting instead of being
   discarded.

Walk-forward Brier 0.196 against a 0.311 base rate. **Trained on synthetic bootstrap data**
(`agent/model/synth.py`) - real signal, but not a claim about real-world accuracy. See
`agent/model/report.json`.

## Where the revenue comes from

Aval prices revenue a business has **already earned**, so everything turns on a question that
has nothing to do with modelling: can a lender check the revenue happened without taking the
borrower's word for it?

The model itself has no opinion. `buildFeatures` takes a list of daily numbers and never asks
where they came from - `test/js/ingest.test.mjs` proves a series scores identically whatever
its provenance. So sources are pluggable, and each one is a different answer to that question
at a different price in trust.

| Source | What a lender has to trust | Status |
|---|---|---|
| `ingest/defillama.mjs` | Nobody. The history is public and anyone can pull the same numbers. | Live |
| `ingest/attested.mjs` | The named attestor who signed the figures. | Built, unbonded |

A source cannot be registered without declaring that middle column. `ingest/index.mjs`
validates it at import time and refuses to start otherwise, because an unstated trust
assumption is the exact failure this protocol exists to price.

**Signed attestations are how a business without public revenue borrows.** A bakery's daily
takings are as real as a protocol's fee stream and the model handles them identically. What
the bakery cannot do is prove them: point an agent at its dashboard and you get a screenshot,
and a screenshot is a claim rather than a proof. So a named attestor - a payment processor, an
accounting platform, a bookkeeper - signs the series under EIP-712, the signature covers a
keccak hash of every daily value, and altering one penny invalidates it. Values are integer
minor units, never floats, because hashing floating point is a signature mismatch waiting to
happen.

This does not remove trust. It moves it somewhere accountable and names it. Attestors are
**not** bonded yet, which is the honest gap - see `SECURITY.md`. It is also the interface
zkTLS and signed platform feeds plug into without changing anything downstream.

## Contracts

| Contract | Role |
|---|---|
| `UnderwriterRegistry` | Identity, `modelCommit` version pinning, bond lock/release/slash |
| `DealManager` | EIP-712 attestation verification, funding, repayment, settlement waterfall |
| `SeniorVault` | ERC-4626 senior capital; the share token is the tradeable portfolio claim |
| `Reputation` | Permissionless onchain Brier scoring |
| `adapters/ProtocolRevenueAdapter` | Advances against protocol fee revenue (demo asset) |
| `adapters/InvoiceAdapter` | SME trade receivables (institutional path) |
| `libraries/ScoringRule` | Brier squared error and fee |
| `libraries/AvalAttestation` | EIP-712 typed data for a signed underwriting opinion |

`modelCommit` pins the model version an underwriter claims to run. Rotation is allowed but
always evented and version-bumped, so a model cannot be silently swapped underneath an
accumulated reputation.

## Running

```bash
npm install
npm run test:all       # 1038 assertions across nine suites
npm run compile        # solc -> out-solc/
npm run check          # read the live deployment and report whether it is demo-ready

# forge-std is a git submodule. Clone with --recursive, or if you already cloned:
git submodule update --init --recursive

forge build && forge test -vv

npm run model:train    # retrain + regenerate parity fixtures
npm run underwrite -- --offline --face 100000
npm run ingest:check -- uniswap        # live DefiLlama smoke test
```

The AI scoring a real borrower and funding the loan onchain, which is the claim the whole
project rests on:

```bash
npm run fund -- --slug uniswap --face 50000 --dry-run   # score and sign, broadcast nothing
npm run fund -- --slug uniswap --face 50000             # actually fund it
```

Automation, so no human sits in the loop:

```bash
npm run keeper -- --dry-run     # find matured loans, settle nothing
npm run keeper -- --interval 300
```

`settle()` is permissionless and the contract decides the outcome from its own state, so a
keeper can only ever be early (which reverts) or correct. It cannot settle a loan the wrong
way. See `SECURITY.md`.

Foundry is the primary toolchain. A pure-JS path (`npm run compile`, `npm run test:js`)
exists for environments where Foundry or `binaries.soliditylang.org` are unreachable; it
compiles and executes the same sources against an in-process EVM.

## Web

A Next.js 16 app in `web/`. **No database and no indexer.** All protocol state (balances,
loans, underwriter records) is read directly over RPC by the browser, so what you see is the
chain rather than a cache of it.

Three stateless server routes exist and hold nothing: `/api/agent` and `/llms.txt` serve the
agent manifest, and `/api/price` runs the credit model against a business's public revenue
history, because the revenue source cannot be called from a browser.

```bash
cd web && npm install && npm run dev      # http://localhost:3000
```

`/` is the site: what the protocol does, a worked example, the model, and developer docs.
`/app` is the dashboard: pool stats, deal list, underwriter leaderboard with live Brier
scores, and deal detail with model provenance.

Every figure shown comes from `web/lib/facts.ts`, the single source of truth. No page is
allowed to hardcode a statistic, and the worked example is computed from the same Brier
formula the contract uses rather than typed in, so the illustration cannot drift away from
what the deployed contracts would actually pay.

### Live underwriting in the browser

`/app?tab=borrow` runs the **real model** against a business you name. It fetches that
protocol's actual revenue history, scores it, and reports the probability of default, the
advance rate, the cost and whether the protocol would fund it at all. No wallet, no gas, no
signature: it is the opinion, not the commitment.

`web/lib/underwriting/` holds byte-identical copies of the agent's scoring code, produced by
`npm run sync:model`. Copies rather than cross-directory imports, because Vercel builds with
`web` as its root and reaching outside it is a deploy that works locally and fails in CI.
Copies drift, so `test/js/model-sync.test.mjs` asserts every file matches its source **and**
that both produce identical output on four revenue profiles. Edit the agent, run the sync, or
the suite goes red.

### For agents

Aval is *operated* by an AI, not browsed by one. The underwriter signs an attestation and
calls the contracts over JSON-RPC; it never loads a page. So the site publishes a
machine-readable entry point rather than expecting an agent to scrape it:

| Path | What it is |
|---|---|
| `/api/agent` | Chain, addresses, EIP-712 schema, every constraint that rejects a deal and the revert it produces. CORS-open, unauthenticated, grants nothing. |
| `/llms.txt` | The same content as prose, generated from the same source so the two cannot disagree. |
| `/.well-known/agent-manifest` | RFC 8615 alias for the manifest, served by rewrite so there is no redirect to follow. |

An agent should not have to guess a URL, so the manifest is advertised three independent ways,
each of which fails for a different kind of caller: a `Link` header on **every** response from
the site including a bare `HEAD`, the well-known path above, and `robots.txt` plus `llms.txt`
for crawlers. Anything that speaks HTTP finds it without parsing a single line of HTML.

Its first key is `startHere`, which is an ordered path per role (underwrite, lend, borrow,
observe) rather than fourteen unordered keys. Each step names a capability id, and those ids
are checked by the type system, so a role pointing at a capability that does not exist is a
build error rather than a dead link an agent discovers at runtime.

Both are built from `web/lib/facts.ts`, and both deliberately publish **no protocol state**.
TVL, utilisation and underwriter scores are absent: a number cached in a served file is a
stale fact stated confidently, which is the exact failure this protocol exists to price. The
manifest names the call that returns each live figure and leaves the reading to the caller.

The constants it publishes are owner-adjustable onchain, so they are checked against the live
deployment rather than assumed:

```bash
npm run check:manifest    # fails loudly if the manifest has drifted from the contracts
```

## Status

**Live on X Layer Mainnet.** (Hackathon requirement fulfilled.)

```
DealManager   0xc19D7895592051145444A4C9B603BF162baC6Ce8
SeniorVault   0xE542d28ab55709f055B920bFfDA49B89D31A7289
```

**Previously proven on X Layer Testnet.** A real loan was funded against a signed AI opinion, repaid, settled, and the underwriter earned a Brier-scored fee with its accuracy recorded onchain.

```
DealManager   0x0f9bF65cb7f2549EA41012A9D692986bE633d52F
SeniorVault   0x0D410fbc0942919F0ab8a55B1fbbFF5E9dc3D3fa
```

Verify the deployment yourself: `npm run check`

| | |
|---|---|
| Assertions passing | 1038 across nine suites |
| Foundry tests | 28 |
| Solidity warnings | 0 |
| Slither high / medium / low | 0 / 0 / 0 |
| Security findings published | 8 |

Built and verified: contracts, adapters, pause mechanism, the model and its Python↔JS
parity, the full agent pipeline, the settlement keeper, the frontend, and an adversarial
suite covering every finding in `SECURITY.md`.

**Completed: mainnet deployment**, fulfilling the stated participation requirement for the hackathon. Also outstanding: OKX DEX routing and a persistent indexer,
which the frontend does not currently need since it reads the chain directly.

## Security

Read `SECURITY.md`. It records eight findings that were found and fixed - including a
critical one where the attestation failed to bind deal terms, allowing a passive mempool
observer to drain the vault - the properties that are verified, and the risks knowingly
accepted.

**Unaudited.** Move ownership to a multisig and keep TVL small.

## Chain configuration

Verified against the official X Layer docs, August 2026. X Layer runs on an enhanced **OP
Stack** with AggLayer settlement; earlier descriptions of it as a Polygon CDK zkEVM are out
of date.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 196 | **1952** |
| RPC | `https://rpc.xlayer.tech` | `https://testrpc.xlayer.tech/terigon` |
| Explorer | [xlayer](https://www.okx.com/web3/explorer/xlayer) | [xlayer-test](https://www.okx.com/web3/explorer/xlayer-test) |
| Gas token | OKB | OKB (from the [faucet](https://web3.okx.com/xlayer/faucet), 0.2/day) |

**Chain 195 is the old deprecated testnet. Do not use it.** OKX DEX aggregator `chainId` is
196.
