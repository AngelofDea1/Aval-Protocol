/**
 * Machine-readable description of Aval Protocol, for autonomous agents.
 *
 * WHY THIS EXISTS
 *
 * Aval is operated by an AI, not browsed by one. The underwriter is a process that signs an
 * EIP-712 attestation and calls `fundDeal` over JSON-RPC; it never loads a page. But an
 * outside agent that wants to integrate has, until now, had no entry point other than
 * reading the repository. This file is that entry point.
 *
 * WHAT IT IS NOT
 *
 * It grants nothing. There is no endpoint here that moves money, signs anything, or holds a
 * key. Every capability listed below is a call the agent makes itself, to a public contract,
 * with its own signer. This is documentation in a parseable shape, and the contracts remain
 * the only authority.
 *
 * THE DRIFT RULE
 *
 * Nothing is hardcoded here that is stated anywhere else. Constants come from `facts.ts` and
 * `aval.ts`, which are the same sources the human-facing pages read. A number cannot be
 * correct on the website and wrong in the manifest, because there is only one of it.
 *
 * Live protocol state is deliberately ABSENT. The manifest tells an agent which call returns
 * the current TVL; it does not tell it what the TVL is. A cached number served from an API
 * is exactly the kind of confidently-stated stale fact this project is built to avoid.
 */

import {
  NETWORK,
  CONTRACTS,
  FIRST_LOSS_BPS,
  UNDERWRITER_FEE_BPS,
  ASSERTIONS_PASSING,
  FOUNDRY_TESTS,
  PARITY_ASSERTIONS,
  SLITHER,
  PUBLISHED_FINDINGS,
  MODEL,
  STATUS,
} from "./facts";
import { DEFAULT_ADDRESSES, USDT_DECIMALS } from "./aval";

/* ------------------------------------------------------------------ constants */

/**
 * Onchain policy limits. Each one is a public getter on the deployed contract, named in
 * `verifyWith` so an agent can confirm rather than trust this document.
 *
 * These are the values the contracts were deployed with. They are owner-adjustable, which is
 * precisely why every entry carries the call that returns the truth.
 */
const POLICY = {
  firstLossBps: {
    value: FIRST_LOSS_BPS,
    means: "Share of principal the underwriter must lock as first-loss collateral.",
    verifyWith: "DealManager.firstLossBps()",
  },
  underwriterFeeBps: {
    value: UNDERWRITER_FEE_BPS,
    means: "Base fee before the Brier multiplier is applied.",
    verifyWith: "DealManager.underwriterFeeBps()",
  },
  maxPdUpperBps: {
    value: 3000,
    means:
      "Risk ceiling. A deal whose conformal upper bound on PD exceeds this cannot be funded at all.",
    verifyWith: "DealManager.maxPdUpperBps()",
  },
  minPrincipal: {
    value: 1_000_000,
    unit: `smallest unit of the asset (${USDT_DECIMALS} decimals), so 1.00`,
    means: "Floor that stops dust deals whose 15% bond would round to zero.",
    verifyWith: "DealManager.minPrincipal()",
  },
  maxTermSeconds: {
    value: 31_536_000,
    means: "Longest permitted term. Bounds how long lender capital can be locked up.",
    verifyWith: "DealManager.maxTermSeconds()",
  },
  maxGraceSeconds: {
    value: 7_776_000,
    means: "Longest permitted grace period after maturity before default can be settled.",
    verifyWith: "DealManager.maxGraceSeconds()",
  },
  maxUtilizationBps: {
    value: 8000,
    means: "Vault will not deploy beyond this share of assets, so redemptions stay possible.",
    verifyWith: "SeniorVault.maxUtilizationBps()",
  },
  bondWithdrawCooldownSeconds: {
    value: 604_800,
    means:
      "Delay between requesting and completing a bond withdrawal, so collateral cannot be pulled ahead of a settlement.",
    verifyWith: "UnderwriterRegistry.WITHDRAW_COOLDOWN()",
  },
} as const;

/* -------------------------------------------------------------- capabilities */

type Capability = {
  id: string;
  kind: "read" | "write";
  contract: keyof typeof CONTRACTS | "asset";
  signature: string;
  summary: string;
  /** Everything that must already be true, so a failure is anticipated rather than debugged. */
  preconditions?: readonly string[];
  reverts?: readonly string[];
};

/**
 * The full surface an agent can act on. Signatures are copied from the deployed ABI, and the
 * revert reasons are the actual custom errors, so a failed simulation is diagnosable without
 * decompiling anything.
 */
const CAPABILITIES = [
  {
    id: "underwriter.register",
    kind: "write",
    contract: "underwriterRegistry",
    signature: "function register(bytes32 modelCommit, uint256 amount)",
    summary:
      "Register a model and post its bond. `modelCommit` is a hash of the model weights plus inference code, and it pins the version this underwriter claims to run.",
    preconditions: [
      "Caller has approved the registry to spend `amount` of the bond token.",
      "`amount` is at least UnderwriterRegistry.minBond().",
    ],
  },
  {
    id: "underwriter.updateModel",
    kind: "write",
    contract: "underwriterRegistry",
    signature: "function updateModel(bytes32 newCommit)",
    summary:
      "Change the pinned model version. Permitted, but always evented and version-bumped, so a track record cannot be silently inherited by a different model.",
  },
  {
    id: "underwriter.requestWithdraw",
    kind: "write",
    contract: "underwriterRegistry",
    signature: "function requestWithdraw(uint256 amount)",
    summary: `Begin withdrawing free bond. Completing it requires waiting ${POLICY.bondWithdrawCooldownSeconds.value} seconds.`,
    preconditions: ["`amount` does not exceed bondTotal minus bondLocked."],
  },
  {
    id: "deal.fund",
    kind: "write",
    contract: "dealManager",
    signature:
      "function fundDeal((bytes32 dealId,address borrower,address adapter,uint256 principal,uint16 discountBps,uint64 maturity,uint64 gracePeriod) p, (bytes32 dealId,bytes32 termsHash,address underwriter,uint16 pdBps,uint16 pdUpperBps,uint16 advanceRateBps,bytes32 modelCommit,bytes32 featureHash,bytes32 rationaleCID,uint64 issuedAt,uint64 expiresAt) a, bytes signature)",
    summary:
      "The core action. Submit signed terms and a credit opinion; the contract verifies the signature, locks the underwriter's bond, and moves principal to the borrower in the same transaction.",
    preconditions: [
      "`a.termsHash` equals keccak256(abi.encode(dealId, borrower, adapter, principal, discountBps, maturity, gracePeriod)).",
      "The signature recovers to `a.underwriter` under the EIP-712 domain below.",
      "`a.modelCommit` matches the registry's current commit for that underwriter.",
      `\`a.pdUpperBps\` is at most ${POLICY.maxPdUpperBps.value}, \`a.pdBps\` is at most 10000, and \`a.pdBps\` does not exceed \`a.pdUpperBps\`.`,
      "The underwriter has free bond of at least principal times firstLossBps.",
      "`maturity` is in the future and within maxTermSeconds.",
    ],
    reverts: [
      "TermsMismatch: termsHash does not commit to these params. This is the guard against signature replay with substituted terms.",
      "BadSigner: signature does not recover to the named underwriter.",
      "StaleModelCommit: the attestation names a model version the registry no longer pins.",
      "PdAbovePolicy, PdOutOfRange, PdAboveOwnUpperBound, DiscountTooHigh, PrincipalTooSmall, MaturityInPast, TermTooLong, GraceTooLong, ZeroAval, ZeroPrincipal, DealExists, AttestationExpired, AttestationMismatch",
    ],
  },
  {
    id: "deal.repay",
    kind: "write",
    contract: "dealManager",
    signature: "function repay(bytes32 dealId, uint256 amount)",
    summary: "Repay a live deal. Never pausable.",
    preconditions: ["Caller has approved the DealManager to spend `amount`."],
  },
  {
    id: "deal.settle",
    kind: "write",
    contract: "dealManager",
    signature: "function settle(bytes32 dealId)",
    summary:
      "Close a matured deal. Permissionless by design: the contract decides the outcome from its own state, so a caller can only be early, which reverts, or correct. It cannot settle a deal the wrong way. This is what makes unattended keepers safe. Never pausable.",
    preconditions: [
      "EITHER the deal is repaid in full (repaid >= dueAmount), in which case it is settleable immediately with no time condition at all, OR block.timestamp is past maturity plus gracePeriod.",
      "Checking only the clock is the easy mistake here, and it leaves a borrower who repaid early unable to close their own deal, with the underwriter's bond locked behind it.",
    ],
    reverts: ["NotYetSettleable", "AlreadySettled", "DealNotFound"],
  },
  {
    id: "vault.deposit",
    kind: "write",
    contract: "seniorVault",
    signature: "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
    summary: "Supply lending capital. Standard ERC-4626.",
  },
  {
    id: "vault.redeem",
    kind: "write",
    contract: "seniorVault",
    signature: "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
    summary: "Withdraw lending capital. Never pausable, under any circumstance.",
  },
  {
    id: "vault.state",
    kind: "read",
    contract: "seniorVault",
    signature: "totalAssets() | deployedAssets() | idleAssets() | utilizationBps()",
    summary: "Current pool state. Call these for live figures; this manifest deliberately carries none.",
  },
  {
    id: "reputation.record",
    kind: "read",
    contract: "reputation",
    signature:
      "function getRecord(address) returns ((uint256 sumSquaredError,uint256 principalUnderwritten,uint256 totalSlashed,uint256 feesForfeited,uint64 predictions,uint64 defaults))",
    summary:
      "An underwriter's full calibration history. Pair with brierScore(address) for the running score, where lower is better.",
  },
  {
    id: "reputation.brier",
    kind: "read",
    contract: "reputation",
    signature: "function brierScore(address) returns (uint256)",
    summary:
      "Mean squared error of that underwriter's predictions against realised outcomes, scaled by 1e18. The only number on this protocol that cannot be bought.",
  },
  {
    id: "deal.read",
    kind: "read",
    contract: "dealManager",
    signature:
      "function getDeal(bytes32) returns ((address borrower,address adapter,address underwriter,uint256 principal,uint256 dueAmount,uint256 avalLocked,uint256 repaid,uint64 maturity,uint64 gracePeriod,uint16 pdBps,uint8 status,bool defaulted))",
    summary: "Full state of one deal.",
  },
] as const satisfies readonly Capability[];

/** Every id that actually exists, derived from the array rather than restated. */
export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

/**
 * Compile-time guard for the role paths below.
 *
 * A role that points an agent at a capability which does not exist is a dead link in a
 * document whose entire job is navigation, and it would never fail loudly at runtime: the
 * agent simply would not find it. Routing the ids through this helper turns a typo, or a
 * capability that gets renamed later, into a build error.
 */
const caps = <T extends readonly CapabilityId[]>(...ids: T): T => ids;

/* ------------------------------------------------------------------ manifest */

/**
 * Ordered paths through the protocol, one per role.
 *
 * Without this an agent receives fourteen top-level keys and no stated order, and has to
 * infer the sequence from field names. Inference is where integrations go wrong: the step
 * most often missed is that a bond must be posted and the model commit registered *before*
 * the first attestation is signed, and skipping it produces a revert that says nothing about
 * the actual cause.
 *
 * Each step names a capability id, so the path and the ABI never drift apart.
 */
const START_HERE = {
  readThisFirst:
    "Pick the role you are acting in, follow its steps in order, and resolve each capability id against the `capabilities` array below. Read `incentives` before signing anything, because it determines what number you should report.",

  roles: {
    underwrite: {
      goal: "Price loans with your own model, stake capital behind each call, and build a public calibration record.",
      steps: [
        "Read `incentives.scoringRule`. The fee is strictly proper, so your profit-maximising report is your true posterior. Decide your reporting policy here, before any code.",
        "Compute modelCommit, a hash of your model weights plus inference code. This pins the version you claim to run.",
        "Approve the bond token, then call capability `underwriter.register` with that commit and your bond amount. This must happen before any attestation is signed.",
        "For each candidate loan, build DealParams and compute termsHash exactly as `attestation.termsHash.computation` states.",
        "Sign the Attestation with the domain and field order in `attestation`. Field order is consensus-critical.",
        "Run the preflight in `integration.referenceAgent.preflight` before broadcasting. It reproduces every constraint and returns readable reasons.",
        "Call capability `deal.fund`. Check `policy` first: pdUpperBps above the ceiling, principal below the floor, or a term beyond the maximum will all reject.",
        "Settlement is permissionless, so either run capability `deal.settle` on a timer or let anyone else call it. Your score updates either way.",
        "To wind down, call capability `underwriter.requestWithdraw` for any bond not currently locked against a live deal, then complete it after the cooldown in `policy.bondWithdrawCooldownSeconds`. Bond locked behind an unsettled deal cannot be withdrawn, which is the point.",
      ],
      capabilities: caps(
        "underwriter.register",
        "deal.fund",
        "deal.settle",
        "underwriter.updateModel",
        "underwriter.requestWithdraw"
      ),
      warning:
        "Your bond is slashed on default and most of your fee is forfeited. Size positions against your realised calibration, not your backtest.",
    },

    lend: {
      goal: "Supply capital and earn yield, with the underwriter's bond absorbing losses ahead of you.",
      steps: [
        "Read `status`. This is unaudited software and mainnet is not deployed.",
        "Check current utilisation with capability `vault.state`. The manifest publishes no figures, on purpose.",
        "Inspect the underwriters you would be lending behind using capability `reputation.brier`. Lower is better, and it can only be earned by bonded predictions that came true.",
        "Approve the asset, then call capability `vault.deposit`.",
        "Exit with capability `vault.redeem`. Redemption is never pausable, under any circumstance.",
      ],
      capabilities: caps("vault.state", "reputation.brier", "vault.deposit", "vault.redeem"),
    },

    borrow: {
      goal: "Raise cash against revenue already earned, without posting crypto collateral or selling equity.",
      steps: [
        "An underwriter must score you and sign an attestation. You do not call fundDeal yourself; it is called with your address as borrower.",
        "Principal arrives in the same transaction that funds the deal.",
        "Repay with capability `deal.repay` before maturity plus grace. Repayment is never pausable.",
        "Read your position at any time with capability `deal.read`.",
      ],
      capabilities: caps("deal.repay", "deal.read"),
    },

    observe: {
      goal: "Index the protocol, or evaluate underwriters, without transacting.",
      steps: [
        "Start from the block in `contracts.deployBlock`. Scanning from zero is rejected by most public endpoints.",
        "Subscribe to the events in `liveState.eventsToIndex`. DealFunded and AttestationAnchored give you the prediction, Settled gives you the outcome.",
        "Every prediction is paired with a realised outcome, so the calibration record can be recomputed independently rather than taken from `reputation.brier` on trust.",
      ],
      capabilities: caps("deal.read", "reputation.record", "reputation.brier", "vault.state"),
    },
  },
} as const;

export const AGENT_MANIFEST = {
  /**
   * No `$schema` key. There is no published JSON Schema for this document yet, and a
   * `$schema` pointing at a URL that 404s is worse than none: a validating client would
   * fetch it, fail, and have no idea whether the failure was its own. When a schema exists
   * it goes here.
   */
  specVersion: "1.0",
  documentation: "https://github.com/AngelofDea1/Aval-Protocol",
  source: "https://github.com/AngelofDea1/Aval-Protocol/blob/main/web/lib/agent-manifest.ts",

  /** Deliberately the first key: an agent reading top to bottom is oriented before anything else. */
  startHere: START_HERE,

  protocol: {
    name: "Aval Protocol",
    summary:
      "Lending where the AI underwriter posts its own capital against every credit decision, is slashed when wrong, and has its calibration recorded onchain permanently.",
    /**
     * Stated first because it is the thing most integrators get wrong: the AI is the
     * underwriter, not an assistant attached to one.
     */
    agentRole:
      "An autonomous agent is a first-class participant here, not a helper. It registers a model, posts a bond, signs credit opinions, and is paid or slashed on outcomes. There is no human approval step in the loop.",
    interface:
      "Contracts over JSON-RPC. The website is a human view of the same state and is not required for any operation.",
  },

  network: {
    name: NETWORK.name,
    chainId: NETWORK.chainId,
    rpc: NETWORK.rpc,
    explorer: NETWORK.explorer,
    gasToken: NETWORK.gasToken,
    note: "Chain 195 is a deprecated X Layer testnet. Do not use it.",
  },

  contracts: {
    ...CONTRACTS,
    asset: {
      address: DEFAULT_ADDRESSES.usdt,
      decimals: USDT_DECIMALS,
      note: "Six decimals, not eighteen. Assuming eighteen is the most common integration bug against USDT.",
    },
    deployBlock: DEFAULT_ADDRESSES.deployBlock,
  },

  policy: POLICY,

  /**
   * The mechanism, stated precisely enough that an agent can compute its own expected value
   * before deciding what probability to report.
   */
  incentives: {
    scoringRule: {
      name: "Brier",
      formula: "S(p, o) = 1 - (p - o)^2",
      feeFormula: "fee = feeBase * (1e8 - (pdBps - o)^2) / 1e8, where o is 10000 on default and 0 otherwise",
      property:
        "Strictly proper. Expected fee is uniquely maximised by reporting true belief, so honest calibration is the dominant strategy rather than a rule anyone enforces.",
      implication:
        "An agent integrating here should report its actual posterior. Shading the number in either direction loses money in expectation, and the loss is computable from the formula above.",
    },
    collateral: {
      rule: `A flat ${FIRST_LOSS_BPS / 100}% of principal, independent of the declared probability.`,
      whyNotRiskScaled:
        "If a lower declared risk meant posting less collateral, understating risk would be directly profitable. Fixing the bond removes that incentive entirely.",
    },
    onDefault:
      "Bond is slashed into the senior vault, most of the fee is forfeited to lenders, and the miss is written to the reputation record permanently.",
  },

  attestation: {
    standard: "EIP-712",
    domain: {
      name: "AvalProtocol",
      version: "1",
      chainId: NETWORK.chainId,
      verifyingContract: CONTRACTS.dealManager,
    },
    types: {
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
    },
    fieldOrderWarning:
      "Field order is consensus-critical and must match AvalAttestation.Attestation exactly. One transposed field produces BadSigner with no further diagnostic.",
    termsHash: {
      computation:
        "keccak256(abi.encode(bytes32 dealId, address borrower, address adapter, uint256 principal, uint16 discountBps, uint64 maturity, uint64 gracePeriod))",
      whyItExists:
        "Without it the signature binds only the deal id, and a passive mempool observer could replay a valid attestation with their own borrower address and a principal up to the vault's entire idle balance. We shipped that bug, found it, and fixed it. It is finding 1 in SECURITY.md and it has regression tests.",
    },
    referenceImplementation: "agent/src/attestation.mjs",
  },

  capabilities: CAPABILITIES,

  /**
   * How to get current numbers. The manifest states none of them, on purpose.
   */
  liveState: {
    principle:
      "This document contains no protocol state. TVL, utilisation, open deals and underwriter scores change continuously, and a value cached in a served JSON file is a stale fact asserted confidently. Read them from the contracts.",
    reads: CAPABILITIES.filter((c) => c.kind === "read").map((c) => c.id),
    eventsToIndex: [
      "DealFunded(bytes32 indexed dealId, address indexed borrower, address indexed underwriter, uint256 principal, uint256 dueAmount, uint256 avalLocked, uint16 pdBps)",
      "AttestationAnchored(bytes32 indexed dealId, address indexed underwriter, uint16 pdBps, uint16 pdUpperBps, uint16 advanceRateBps, bytes32 modelCommit, bytes32 featureHash, bytes32 rationaleCID)",
      "Settled(bytes32 indexed dealId, bool defaulted, uint256 repaid, uint256 slashed, uint256 feePaid, uint256 feeForfeited)",
    ],
    indexingHint: `Start from block ${DEFAULT_ADDRESSES.deployBlock}. Scanning from zero is rejected by most public endpoints, and nothing relevant was emitted earlier. Public RPCs impose different undocumented eth_getLogs range limits, so halve the window on rejection rather than tuning to one provider.`,
  },

  /**
   * Verifiable engineering claims. Every one is reproducible by the named command, because a
   * claim an integrator cannot check is worth nothing to them.
   */
  verification: {
    assertionsPassing: {
      value: ASSERTIONS_PASSING,
      note: `Individual assertions across nine JavaScript suites, of which ${PARITY_ASSERTIONS} are Python-to-JavaScript model parity checks. These are assertions, not independent test scenarios.`,
      reproduce: "npm run test:all",
    },
    foundryTests: { value: FOUNDRY_TESTS, reproduce: "forge test -vv" },
    staticAnalysis: {
      tool: "Slither",
      contractsAnalysed: SLITHER.contractsAnalysed,
      high: SLITHER.high,
      medium: SLITHER.medium,
      low: SLITHER.low,
      informational: SLITHER.informational,
      reproduce: 'slither . --exclude-dependencies --filter-paths "node_modules|mocks"',
    },
    publishedFindings: { value: PUBLISHED_FINDINGS, where: "SECURITY.md" },
    checkDeployment: "npm run check",
  },

  model: {
    stages: [
      "Logistic regression over eight cashflow features, of which seven carry non-zero weight. max_drawdown is fitted at exactly 0.0 on the v0 training set and is retained in the feature vector for shape stability, not because it contributes. The dominant terms are momentum, coverage and volatility.",
      "A language-model overlay on unstructured context, clamped to plus or minus 30% of the base probability. This clamp is offchain, in agent/src/llm.mjs. It is NOT a contract invariant; what the contract enforces is maxPdUpperBps, which reverts PdAbovePolicy.",
      "Venn-Abers calibration, giving a distribution-free interval whose upper edge drives the risk ceiling.",
    ],
    walkForwardBrier: MODEL.brierLogistic,
    baseRate: MODEL.baseRate,
    trainedOn: MODEL.trainedOn,
    honestLimitation:
      "The model is v0 and has never seen a real default. These figures describe behaviour on synthetic data and are not a claim about real-world accuracy. The contribution is the mechanism, not the model. Any agent relying on Aval's own model output should treat it accordingly.",
    substitutable:
      "The protocol does not privilege this model. Register your own commit, post a bond, and compete on realised calibration.",
  },

  status: {
    testnet: STATUS.deployedTestnet,
    mainnet: STATUS.deployedMainnet,
    audited: STATUS.audited,
    warning:
      "Unaudited experimental software. Static analysis and a published self-review are not an audit. An agent deploying capital here should size positions accordingly.",
  },

  integration: {
    repository: "https://github.com/AngelofDea1/Aval-Protocol",
    whereToRead: "See SECURITY.md for the risk register and agent/src/ for the reference agent.",
    quickstart: [
      "npm install",
      "npm run test:all",
      "npm run check",
      "npm run fund -- --slug uniswap --face 50000 --dry-run",
      "npm run keeper -- --interval 300",
    ],
    referenceAgent: {
      underwriteAndFund: "agent/src/fund.mjs",
      unattendedSettlement: "agent/src/keeper.mjs",
      signing: "agent/src/attestation.mjs",
      preflight:
        "attestation.mjs exports preflight(), which reproduces every constraint fundDeal enforces and returns readable reasons. Call it before broadcasting so a failure arrives as a sentence rather than a bare revert.",
    },
  },
} as const;

export type AgentManifest = typeof AGENT_MANIFEST;
