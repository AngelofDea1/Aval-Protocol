/**
 * Aval Protocol front-end bindings.
 *
 * Addresses, ABIs, unit helpers and the plain-English labels the interface uses.
 * Addresses come from env at build time and can be overridden at runtime from the Settings
 * dialog, so the same build works against a local chain, testnet or mainnet.
 */

import { ethers } from "ethers";

/**
 * Verified against official X Layer docs, August 2026.
 * Chain 195 is the OLD deprecated testnet. The live one is 1952.
 */
export const NETWORKS = {
  mainnet: {
    id: 196,
    hexId: "0xc4",
    name: "X Layer",
    currency: "OKB",
    rpc: "https://rpc.xlayer.tech",
    explorer: "https://www.okx.com/web3/explorer/xlayer",
  },
  testnet: {
    id: 1952,
    hexId: "0x7a0",
    name: "X Layer testnet",
    currency: "OKB",
    rpc: "https://testrpc.xlayer.tech/terigon",
    explorer: "https://www.okx.com/web3/explorer/xlayer-test",
  },
} as const;

// Defaults to testnet because that is where the live deployment is. Set
// NEXT_PUBLIC_NETWORK=mainnet once the contracts are on chain 196.
const target = process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? NETWORKS.mainnet : NETWORKS.testnet;

export const CHAIN = {
  ...target,
  rpc: process.env.NEXT_PUBLIC_RPC_URL ?? target.rpc,
};

export type Addresses = {
  dealManager: string;
  vault: string;
  usdt: string;
  /**
   * Block the protocol was deployed at. Event scans start here.
   *
   * This is not cosmetic. X Layer is past 37 million blocks, and scanning from 0 is either
   * rejected outright by public RPCs or takes minutes. Everything the UI needs was emitted
   * after deployment, so anything earlier is wasted work.
   */
  deployBlock: number;
};

/**
 * Live X Layer testnet deployment, used when no env vars are set.
 *
 * These are public contract addresses, so baking them in is safe and means the site works
 * the moment it is hosted, with no dashboard configuration. Env vars still win, and the
 * Settings dialog overrides both at runtime.
 */
const TESTNET_DEPLOYMENT = {
  dealManager: "0x0f9bF65cb7f2549EA41012A9D692986bE633d52F",
  vault: "0x0D410fbc0942919F0ab8a55B1fbbFF5E9dc3D3fa",
  usdt: "0x1105B9D43Cea1d046123D3BE0440B3424e183024",
  deployBlock: 38351260,
};

/**
 * On mainnet, falling back to a testnet value is worse than failing.
 *
 * `facts.ts` already refuses to build a mainnet bundle without the five core contract
 * addresses, but it never covered these two, and they fail quietly rather than loudly:
 *
 *   - `usdt` would fall back to the testnet MockUSDT address. On chain 196 that address is
 *     not this project's token, so every approve and deposit would be aimed at whatever
 *     else happens to live there.
 *   - `deployBlock` would fall back to a testnet block number. Event scans would start in
 *     the wrong place on a different chain, so the Loans tab would look empty rather than
 *     broken, which is the failure mode that wastes the most time.
 *
 * Both are build-time throws for the same reason the deploy script refuses chain 196
 * without confirmation: a warning nobody reads is not a control.
 */
const IS_MAINNET_BUILD = process.env.NEXT_PUBLIC_NETWORK === "mainnet";

if (IS_MAINNET_BUILD) {
  const missing: string[] = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_USDT ?? "")) {
    missing.push("NEXT_PUBLIC_USDT");
  }
  if (!Number.isFinite(Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK)) ||
      Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK) <= 0) {
    missing.push("NEXT_PUBLIC_DEPLOY_BLOCK");
  }
  if (missing.length > 0) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK=mainnet but ${missing.join(" and ")} is unset, so the build would ` +
        `silently use testnet values on chain 196. Set them from script/deploy-mainnet.sh output.`
    );
  }
}

export const DEFAULT_ADDRESSES: Addresses = {
  dealManager: process.env.NEXT_PUBLIC_DEAL_MANAGER || TESTNET_DEPLOYMENT.dealManager,
  vault: process.env.NEXT_PUBLIC_VAULT || TESTNET_DEPLOYMENT.vault,
  usdt: process.env.NEXT_PUBLIC_USDT || TESTNET_DEPLOYMENT.usdt,
  deployBlock: Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || TESTNET_DEPLOYMENT.deployBlock),
};

/**
 * Deal ids that can be derived rather than discovered.
 *
 * THE ROOT CAUSE THIS FIXES. The Loans tab found deals by scanning DealFunded events, so it
 * inherited every weakness of `eth_getLogs` on a public endpoint: rate limits, dropped windows,
 * and an empty array returned instead of an error. `getDeal` has never once failed, because a
 * single contract read is not the same kind of request.
 *
 * The seed script derives its deal ids from fixed strings, so they are knowable without asking
 * anyone. Deriving them here means the demo loans render from three plain reads, with no log
 * query at all. `getDeal` returns status None for an id that does not exist, so this is safe
 * against any deployment that was seeded differently: those ids are simply skipped.
 *
 * Log scanning still runs, and still finds deals nobody could have predicted. It is now an
 * enhancement rather than the thing everything depends on.
 */
export const SEEDED_DEAL_IDS = ["seed:live", "seed:repaid", "seed:defaulted"].map((s) => ethers.id(s));

/** USDT is 6 decimals, not 18. */
export const USDT_DECIMALS = 6;

export const ABI = {
  dealManager: [
    "function getDeal(bytes32) view returns (tuple(address borrower,address adapter,address underwriter,uint256 principal,uint256 dueAmount,uint256 avalLocked,uint256 repaid,uint64 maturity,uint64 gracePeriod,uint16 pdBps,uint8 status,bool defaulted))",
    "function registry() view returns (address)",
    "function reputation() view returns (address)",
    "function vault() view returns (address)",
    "function firstLossBps() view returns (uint16)",
    "function paused() view returns (bool)",
    "function repay(bytes32 dealId, uint256 amount)",
    "function settle(bytes32 dealId)",
    /*
     * Funding, from the browser. The tuples must match DealParams and
     * AvalAttestation.Attestation field for field: one out of order and every call reverts with
     * TermsMismatch, which says nothing useful to whoever clicked the button.
     */
    "function fundDeal(tuple(bytes32 dealId,address borrower,address adapter,uint256 principal,uint16 discountBps,uint64 maturity,uint64 gracePeriod) p, tuple(bytes32 dealId,bytes32 termsHash,address underwriter,uint16 pdBps,uint16 pdUpperBps,uint16 advanceRateBps,bytes32 modelCommit,bytes32 featureHash,bytes32 rationaleCID,uint64 issuedAt,uint64 expiresAt) a, bytes signature)",
    "event DealFunded(bytes32 indexed dealId, address indexed borrower, address indexed underwriter, uint256 principal, uint256 dueAmount, uint256 avalLocked, uint16 pdBps)",
    "event AttestationAnchored(bytes32 indexed dealId, address indexed underwriter, uint16 pdBps, uint16 pdUpperBps, uint16 advanceRateBps, bytes32 modelCommit, bytes32 featureHash, bytes32 rationaleCID)",
    "event Settled(bytes32 indexed dealId, bool defaulted, uint256 repaid, uint256 slashed, uint256 feePaid, uint256 feeForfeited)",
  ],
  vault: [
    /*
     * Which DealManager this vault will accept deployTo from. Read so the app can tell the
     * difference between "no loans have been made" and "you are scanning a DealManager this
     * vault has never heard of", which look identical on screen and have nothing in common.
     */
    "function dealManager() view returns (address)",
    /*
     * The token this vault actually holds. deployments/1952.json never recorded the USDT
     * address, so the one in this file was copied across by hand and can silently go stale
     * after a redeploy. Reading it from the vault means the app can catch that rather than
     * mint into a token nothing else uses.
     */
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function deployedAssets() view returns (uint256)",
    "function idleAssets() view returns (uint256)",
    "function utilizationBps() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function convertToAssets(uint256) view returns (uint256)",
    "function maxRedeem(address) view returns (uint256)",
    "function paused() view returns (bool)",
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  ],
  reputation: [
    "function getRecord(address) view returns (tuple(uint256 sumSquaredError,uint256 principalUnderwritten,uint256 totalSlashed,uint256 feesForfeited,uint64 predictions,uint64 defaults))",
    "function brierScore(address) view returns (uint256)",
    "function realisedDefaultRateBps(address) view returns (uint256)",
  ],
  adapter: [
    // A borrower is a hex address on chain, which tells a reader nothing. The adapter stores
    // a human label for each obligor, so the deal list can show "Demo protocol revenue"
    // instead of 0x27a3...E011. Reading it is two calls and worth every millisecond.
    "function dealObligor(bytes32) view returns (bytes32)",
    "function obligors(bytes32) view returns (bool registered, uint64 registeredAt, bytes32 sourceRef, string label)",
  ],
  registry: [
    "function getUnderwriter(address) view returns (tuple(bool active,uint32 modelVersion,uint64 registeredAt,bytes32 modelCommit,uint256 bondTotal,uint256 bondLocked,uint256 withdrawRequested,uint64 withdrawUnlockAt))",
    "function minBond() view returns (uint256)",
    "function availableBond(address) view returns (uint256)",
    // Registration is a plain external call with no privileged role: anyone with the bond
    // token can become an underwriter. That is the point, so the UI exposes it.
    "function register(bytes32 modelCommit, uint256 amount)",
    "function topUp(uint256 amount)",
  ],
  erc20: [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    /**
     * Testnet only. MockUSDT leaves mint unrestricted so anyone can get tokens to try the
     * app with. Real USDT has no such function, which is why the UI only ever offers this
     * off mainnet: calling it on chain 196 would revert with nothing useful to say.
     */
    "function mint(address to, uint256 amount)",
  ],
};

/* -------------------------------------------------------------- chain access */

/**
 * Every event this contract emitted in a range, in ONE pass, partitioned by event name.
 *
 * Three separate filtered scans over the same range is three times the requests for the same
 * bytes, and issuing them in parallel triples the burst a public RPC sees at once. That is how
 * a deal list ends up empty on a chain that plainly has deals on it: the scan trips a rate
 * limit, the error is caught somewhere upstream, and the interface says "no loans yet" about a
 * hundred thousand USDT of live lending.
 *
 * One unfiltered scan by address, decoded locally, costs a third of the requests and cannot
 * disagree with itself about which blocks it covered.
 */
export async function queryAllEvents(
  contract: ethers.Contract,
  fromBlock: number,
  toBlock: number,
  chunk = 4_000,
  onProgress?: (grouped: Record<string, ethers.LogDescription[]>) => void
): Promise<Record<string, ethers.LogDescription[]>> {
  const provider = contract.runner?.provider;
  if (!provider) throw new Error("contract has no provider");

  const address = await contract.getAddress();
  const events = contract.interface.fragments.filter((f) => f.type === "event") as ethers.EventFragment[];
  const topics = [events.map((e) => e.topicHash)]; // one query, any of our events

  const grouped: Record<string, ethers.LogDescription[]> = {};

  /*
   * Walk BACKWARDS from the head, and report progress as we go.
   *
   * Forwards-and-all-or-nothing was the wrong shape twice over. A public endpoint rate limits
   * partway through a 160,000 block scan, the whole thing throws, and a page that had already
   * found every loan shows none of them. And the loans a reader wants are the recent ones, which
   * a forward scan finds last.
   *
   * Backwards with progress means the newest loan appears almost immediately and a scan that
   * dies halfway still leaves a useful list. Smaller windows too: 4,000 blocks is well inside
   * what every endpoint tested will answer, and the cost of more requests is worth never
   * tripping the limit that loses everything.
   *
   * A single query with all three topics in one array is an OR, so this is one third of the
   * requests the per-event version made.
   */
  let end = toBlock;
  while (end >= fromBlock) {
    const start = Math.max(fromBlock, end - chunk + 1);
    try {
      const logs = await provider.getLogs({ address, fromBlock: start, toBlock: end, topics });
      for (const log of logs) {
        try {
          const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) (grouped[parsed.name] ??= []).push(parsed);
        } catch {
          /* an event this build does not know about */
        }
      }
      if (logs.length > 0) onProgress?.(grouped);
      end = start - 1;
    } catch (err) {
      // Halve and retry the same window. Give up on this window only when it is a single block,
      // and even then keep what we already have rather than discarding the whole scan.
      if (chunk <= 1) throw err;
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }

  return grouped;
}

/** Resolve promises in small batches so a large deployment does not hammer the RPC. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ formatting */

export function fmtUsdt(v: bigint | number | undefined | null, dp = 2): string {
  if (v === undefined || v === null) return "-";
  const n = Number(v) / 10 ** USDT_DECIMALS;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtCompact(v: bigint | number | undefined | null): string {
  if (v === undefined || v === null) return "-";
  const n = Number(v) / 10 ** USDT_DECIMALS;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

export function toUnits(input: string): bigint {
  const cleaned = (input || "0").replace(/,/g, "").trim();
  if (!cleaned || Number.isNaN(Number(cleaned))) return 0n;
  const [whole, frac = ""] = cleaned.split(".");
  const padded = (frac + "0".repeat(USDT_DECIMALS)).slice(0, USDT_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDT_DECIMALS) + BigInt(padded || "0");
}

export function fmtPct(bps: bigint | number | undefined | null, dp = 2): string {
  if (bps === undefined || bps === null) return "-";
  return (Number(bps) / 100).toFixed(dp) + "%";
}

export const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "-");
export const shortHash = (h?: string, n = 10) => (h ? `${h.slice(0, n)}...` : "-");

export function daysUntil(ts: number): string {
  const d = (ts - Date.now() / 1000) / 86400;
  if (d < 0) return `${Math.abs(d).toFixed(0)}d overdue`;
  if (d < 1) return "due today";
  return `${d.toFixed(0)}d left`;
}

/**
 * Plain-English reading of a Brier score.
 * The raw number is meaningless to anyone who has not seen one, and the whole point of the
 * leaderboard is that a non-specialist can tell good from bad at a glance.
 */
export function brierLabel(score: number, samples: number): { label: string; tone: Tone } {
  if (!samples) return { label: "No track record yet", tone: "muted" };
  if (score < 0.05) return { label: "Excellent", tone: "good" };
  if (score < 0.15) return { label: "Good", tone: "good" };
  if (score < 0.3) return { label: "Mixed", tone: "warn" };
  return { label: "Poor", tone: "bad" };
}

export type Tone = "good" | "warn" | "bad" | "live" | "muted";

export type SettleableDeal = {
  settled: boolean;
  repaid?: bigint;
  dueAmount?: bigint;
  maturity?: number;
  gracePeriod?: number;
};

export function dealStatus(d: SettleableDeal & { defaulted: boolean }): { label: string; tone: Tone } {
  if (d.settled) return d.defaulted ? { label: "Defaulted", tone: "bad" } : { label: "Repaid", tone: "good" };
  return isSettleable(d) ? { label: "Ready to settle", tone: "warn" } : { label: "Active", tone: "live" };
}

/**
 * Can `settle(dealId)` be called right now without reverting?
 *
 * Mirrors DealManager.settle exactly:
 *
 *   paidInFull = repaid >= dueAmount
 *   pastGrace  = block.timestamp > maturity + gracePeriod
 *   revert NotYetSettleable if (!paidInFull && !pastGrace)
 *
 * The `paidInFull` half matters and is easy to miss. A loan repaid early is settleable
 * IMMEDIATELY, before maturity. Checking only the clock would leave a borrower who repaid on
 * time unable to close their own loan, with the underwriter's collateral locked behind it for
 * no reason.
 *
 * Kept here rather than inline so the button, the status pill and the explanatory copy all
 * agree. Three separate versions of this condition would eventually disagree, and the one
 * that drifted would be the one wiring up a button that reverts.
 *
 * Settlement is permissionless. The contract reads its own state to decide the outcome and
 * takes no outcome argument, so a caller can only ever be early, which reverts, or correct.
 * Nobody can settle a loan the wrong way.
 */
export function isSettleable(d: SettleableDeal): boolean {
  if (d.settled) return false;

  // Repaid in full: settleable now, no time condition at all.
  if (d.dueAmount !== undefined && d.repaid !== undefined && d.repaid >= d.dueAmount) return true;

  if (!d.maturity) return false;

  /**
   * Browser clock against chain clock. `block.timestamp` is set by the sequencer and the
   * user's machine can be seconds off in either direction, so a strict comparison can offer
   * a button one second early that then reverts with NotYetSettleable. Erring late costs a
   * few seconds; erring early shows a failed transaction to someone who did nothing wrong.
   */
  const CLOCK_SKEW_MARGIN_SECONDS = 30;
  return Date.now() / 1000 > d.maturity + (d.gracePeriod ?? 0) + CLOCK_SKEW_MARGIN_SECONDS;
}

/**
 * Status is a word, not a lozenge.
 *
 * A pill around a one-word label is pure packaging: it adds a border, a fill and a radius to
 * say something the word already said, and a column of them is the house style of every
 * dashboard nobody designed. A loan book prints the status in the column and moves on.
 *
 * So the only variable is how loud the word is, and that tracks exactly one thing: how much
 * the row still wants from you.
 *
 *   Ready to settle  amber, because it is the one row asking a human to act
 *   Active           bright, still running, nothing to do yet
 *   Repaid           dim, closed, finished
 *   Defaulted        the ink red, closed, and somebody's money moved
 *
 * Nothing rests on hue alone: the words differ, so this reads the same to someone who cannot
 * separate red from green.
 */
export const toneClass: Record<Tone, string> = {
  good: "text-muted-foreground",
  warn: "text-primary",
  bad: "text-destructive",
  live: "text-foreground/80",
  muted: "text-muted-foreground/70",
};

/* ------------------------------------------------------------------ chain types */

export type Deal = {
  dealId: string;
  borrower: string;
  underwriter: string;
  borrowerName: string;
  principal: bigint;
  dueAmount: bigint;
  avalLocked: bigint;
  repaid: bigint;
  pdBps: number;
  pdUpperBps: number;
  advanceRateBps: number;
  maturity: number;
  /** Seconds after maturity before settlement is allowed. Needed to know if settle() will revert. */
  gracePeriod: number;
  modelCommit: string;
  featureHash: string;
  rationaleCID: string;
  settled: boolean;
  defaulted: boolean;
  slashed: bigint;
  feePaid: bigint;
  feeForfeited: bigint;
};

export type Underwriter = {
  address: string;
  name: string;
  brier: number;
  predictions: number;
  defaults: number;
  principalUnderwritten: bigint;
  totalSlashed: bigint;
  feesForfeited: bigint;
  defaultRateBps: bigint;
  bondTotal: bigint;
  bondLocked: bigint;
  modelVersion: number;
};

/**
 * Turn a wallet or node error into something a reader can act on.
 *
 * ethers wraps the useful part in several hundred characters of JSON-RPC envelope, and the app
 * was slicing the first 140 of it - which is reliably the least informative 140. The revert
 * reason and the recognisable codes live deeper, so they are pulled out by name.
 */
export function explainTxError(err: unknown): string {
  const e = err as {
    code?: string | number;
    shortMessage?: string;
    reason?: string;
    info?: { error?: { message?: string } };
    message?: string;
  };

  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) {
    return "You rejected the request in your wallet. Nothing was sent.";
  }
  if (e?.code === "INSUFFICIENT_FUNDS") {
    return "Not enough OKB to pay for gas. Top up from the X Layer faucet and try again.";
  }
  if (e?.code === "CALL_EXCEPTION" || e?.code === "UNPREDICTABLE_GAS_LIMIT") {
    const why = e.reason ?? e.shortMessage ?? "the contract rejected it";
    return `The transaction would fail, so your wallet was never asked to sign: ${why}.`;
  }
  if (e?.code === "NETWORK_ERROR" || e?.code === "TIMEOUT") {
    return "The network did not answer. Reload, or set your own RPC endpoint under Settings.";
  }

  const best = e?.reason ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message;
  return best ? best.slice(0, 220) : "Something went wrong and the wallet reported no reason.";
}
