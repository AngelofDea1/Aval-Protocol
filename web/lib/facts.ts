/**
 * Single source of truth for every number and address shown on the site.
 *
 * No page is allowed to hardcode a statistic. If a figure appears in the UI it comes from
 * here, and every entry below carries the command or file that produced it so it can be
 * re-checked rather than trusted.
 *
 * The worked example is COMPUTED from the real contract formula rather than typed in, so it
 * cannot drift away from what the contracts actually do.
 *
 * Verified 16 August 2026.
 */

/* ------------------------------------------------------------------ protocol */

/** DealManager.firstLossBps() on the live deployment. */
export const FIRST_LOSS_BPS = 1500;

/** DealManager.underwriterFeeBps() default. */
export const UNDERWRITER_FEE_BPS = 100;

/* ------------------------------------------------------------------- network */

/**
 * Which deployment this build describes. Set NEXT_PUBLIC_NETWORK=mainnet after deploying to
 * chain 196.
 *
 * This reads the SAME variable lib/aval.ts reads, on purpose. The app talks to whichever
 * chain that variable names, and every page on the site describes whichever chain this file
 * names, so if the two were configured separately a build could sincerely tell a reader it
 * was a test network while the dashboard beside it moved real money. One switch, no drift.
 */
export const IS_MAINNET = process.env.NEXT_PUBLIC_NETWORK === "mainnet";

/** Chain 195 is the old deprecated testnet. Do not use it. */
const CHAINS = {
  mainnet: {
    name: "X Layer",
    chainId: 196,
    rpc: "https://rpc.xlayer.tech",
    explorer: "https://www.okx.com/web3/explorer/xlayer",
    gasToken: "OKB",
  },
  testnet: {
    name: "X Layer testnet",
    chainId: 1952,
    rpc: "https://testrpc.xlayer.tech/terigon",
    explorer: "https://www.okx.com/web3/explorer/xlayer-test",
    gasToken: "OKB",
  },
} as const;

export const NETWORK = {
  ...(IS_MAINNET ? CHAINS.mainnet : CHAINS.testnet),
  mainnetChainId: CHAINS.mainnet.chainId,
};

/** Testnet, deployed 15 August 2026. Verify any of these on the explorer. */
const TESTNET_CONTRACTS = {
  dealManager: "0x0f9bF65cb7f2549EA41012A9D692986bE633d52F",
  seniorVault: "0x0D410fbc0942919F0ab8a55B1fbbFF5E9dc3D3fa",
  underwriterRegistry: "0xd0424f9908C36D3E91AFaEf6C546eeD7D8E742E2",
  reputation: "0xCBda55841d6C1EE5585155F52d4cecA50ce53fA5",
  protocolRevenueAdapter: "0xe67808e42a12EC5beBE54EB782bE11B0d84575e3",
} as const;

/**
 * Mainnet addresses arrive by env rather than being pasted here, so a mainnet build cannot be
 * cut before the contracts exist.
 *
 * The throw below matters more than it looks. Without it, setting NEXT_PUBLIC_NETWORK=mainnet
 * and forgetting the addresses produces a site that says "X Layer" at the top and links every
 * contract to a testnet address on the mainnet explorer - a page that is wrong in a way that
 * looks entirely fine. Failing the build is the only honest option.
 */
const MAINNET_CONTRACTS = {
  dealManager: process.env.NEXT_PUBLIC_DEAL_MANAGER ?? "",
  seniorVault: process.env.NEXT_PUBLIC_VAULT ?? "",
  underwriterRegistry: process.env.NEXT_PUBLIC_REGISTRY ?? "",
  reputation: process.env.NEXT_PUBLIC_REPUTATION ?? "",
  protocolRevenueAdapter: process.env.NEXT_PUBLIC_ADAPTER ?? "",
} as const;

if (IS_MAINNET) {
  const missing = Object.entries(MAINNET_CONTRACTS)
    .filter(([, v]) => !/^0x[0-9a-fA-F]{40}$/.test(v))
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK=mainnet but no mainnet address for: ${missing.join(", ")}. ` +
        `Set them from the output of script/deploy-mainnet.sh before building.`
    );
  }
}

export const CONTRACTS = IS_MAINNET ? MAINNET_CONTRACTS : TESTNET_CONTRACTS;

export const explorerLink = (address: string) => `${NETWORK.explorer}/address/${address}`;

/* --------------------------------------------------------------- engineering */

/**
 * Individual assertions across the nine JavaScript suites, NOT "tests" in the usual sense:
 * 734 of them are model parity checks. Reproduce with `npm run test:all`.
 *
 *   protocol core 44 · adapters 21 · adversarial 55 · agent manifest 48 · model sync 17 ·
 *   frontend ABI 47 · revenue ingest 31 · parity 734 · agent end-to-end 41
 */
export const ASSERTIONS_PASSING = 1038;

/** Foundry test functions in test/AvalProtocol.t.sol. Separate from the count above. */
export const FOUNDRY_TESTS = 28;

/** `slither . --exclude-dependencies --filter-paths "node_modules|mocks"` */
export const SLITHER = {
  contractsAnalysed: 41,
  detectors: 102,
  high: 0,
  medium: 0,
  low: 0,
  /** All four are the same false-positive detector; see SECURITY.md. */
  informational: 4,
} as const;

/** Findings we found in our own review and published in SECURITY.md. */
export const PUBLISHED_FINDINGS = 8;

/** agent/test/parity.test.mjs, tolerance 1e-9. */
export const PARITY_ASSERTIONS = 734;

/* --------------------------------------------------------------------- model */

/**
 * Model metrics. Most come from agent/model/report.json, produced by `npm run model:train`.
 *
 * Two do not, and they are called out below rather than left to look like the others. Both
 * are derived from the dataset itself, which is deterministic (`make_dataset(seed=7)`), so
 * they are reproducible in one command:
 *
 *   cd agent/model && python3 -c "import numpy as np; from synth import make_dataset; \
 *     y = np.asarray(make_dataset()['labels']); print(y.mean(), y.mean()*(1-y.mean()))"
 *
 *   -> 0.3108108108108108  0.2142074506939372
 */
export const MODEL = {
  /** report.json: mean_out_of_time_brier.logistic (0.19649...). Walk-forward, expanding window. */
  brierLogistic: 0.1965,
  /** report.json: mean_out_of_time_brier.gbm (0.20605...). */
  brierGradientBoosting: 0.2061,
  /**
   * NOT in report.json. A constant predictor at the base rate scores p(1-p), which for
   * p = 0.31081... is 0.21420...
   *
   * This read 0.2143 until it was checked against the dataset. Wrong in the fourth decimal,
   * which nobody would have caught by eye, and it sat on the model page as a measured figure.
   */
  brierConstantPredictor: 0.2142,
  /** report.json: holdout.venn_abers.auc (0.71077...). The calibrated path is the one that ships. */
  heldOutAuc: 0.711,
  /** report.json: mean_interval_width (0.04607...). */
  meanIntervalWidth: 0.046,
  /**
   * NOT in report.json, which records only the holdout base rate (0.3146). This is the base
   * rate of the full dataset (0.31081...), which is the sample the walk-forward score above
   * is measured over, so it is the one that belongs next to it.
   */
  baseRate: 0.311,
  /**
   * Not real default data. Stated everywhere the numbers appear, because presenting
   * synthetic-data metrics as real performance is the fastest way to lose credibility.
   */
  trainedOn: "synthetic bootstrap dataset",
} as const;

/* ------------------------------------------------------------ worked example */

/**
 * Brier fee, matching src/libraries/ScoringRule.sol exactly.
 *
 *   S(p, o) = 1 − (p − o)²
 *
 * Kept as code rather than prose so the example on the site is always what the deployed
 * contract would actually pay.
 */
export function brierFee(feeBase: number, pdBps: number, defaulted: boolean): number {
  const ONE = 10_000;
  const o = defaulted ? ONE : 0;
  const diff = Math.abs(pdBps - o);
  return (feeBase * (ONE * ONE - diff * diff)) / (ONE * ONE);
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The illustration used on the protocol page. An honest hypothetical, not a real loan,
 * with every figure derived from the contract's own arithmetic.
 */
export function workedExample(principal = 100_000, declaredPdBps = 500) {
  const collateral = (principal * FIRST_LOSS_BPS) / 10_000;
  const feeBase = (principal * UNDERWRITER_FEE_BPS) / 10_000;
  const feeKept = brierFee(feeBase, declaredPdBps, true);
  const lenderLoss = principal - collateral + feeKept;

  /** What the same default would have paid on an honest, cautious call. */
  const honestPdBps = 2900;
  const feeIfHonest = brierFee(feeBase, honestPdBps, true);

  return {
    principal,
    declaredPd: `${(declaredPdBps / 100).toFixed(2)}%`,
    collateral: fmt(collateral),
    collateralTaken: `−${fmt(collateral)}`,
    feeBase: fmt(feeBase),
    feeKept: fmt(feeKept),
    lenderLoss: fmt(lenderLoss),
    lossWithoutCollateral: fmt(principal),
    coveredByAi: `+${fmt(collateral)}`,
    honestPd: `${(honestPdBps / 100).toFixed(0)}%`,
    feeIfHonest: fmt(feeIfHonest),
  };
}

/* ------------------------------------------------------------------- status */

/**
 * What is and is not true right now. Referenced by the site so nothing overstates.
 */
export const STATUS = {
  deployedTestnet: true,
  /**
   * Derived, never hand-edited. Someone flipping this by hand while the build still pointed
   * at chain 1952 would have the terms page tell a reader their money was on a public
   * blockchain when it was not.
   */
  deployedMainnet: IS_MAINNET,
  audited: false,
  /** A real loan was funded, repaid and settled on testnet. */
  loansSettled: true,
} as const;
