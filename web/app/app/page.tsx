"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import Link from "next/link";
import { FooterSection } from "@/components/landing/footer-section";
import { SITE_LINKS } from "@/components/landing/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BusinessPicker } from "@/components/app/business-picker";
import { WalletPicker } from "@/components/app/wallet-picker";
import {
  discoverWallets,
  getProvider,
  rememberWallet,
  rememberedRdns,
  setProvider,
  type WalletOption,
} from "@/lib/wallet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Settings,
  Wallet,
} from "lucide-react";
import {
  ABI,
  Addresses,
  CHAIN,
  NETWORKS,
  USDT_DECIMALS,
  DEFAULT_ADDRESSES,
  Deal,
  Underwriter,
  brierLabel,
  dealStatus,
  daysUntil,
  fmtCompact,
  fmtPct,
  fmtUsdt,
  isSettleable,
  mapLimit,
  queryAllEvents,
  shortAddr,
  shortHash,
  toUnits,
  toneClass,
  explainTxError,
  SEEDED_DEAL_IDS,
} from "@/lib/aval";

type Tab = "lend" | "borrow" | "loans" | "models";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "lend", label: "Lend", blurb: "Deposit USDT and earn interest from loans the AI approves." },
  { id: "borrow", label: "Borrow", blurb: "Get cash now against revenue your business has already earned." },
  { id: "loans", label: "Loans", blurb: "Every loan the protocol has made, and how each one turned out." },
  { id: "models", label: "Models", blurb: "Which AI underwriters have actually been accurate, measured in money." },
];

/* ------------------------------------------------------------------ helpers */

/**
 * Below this, treat the wallet as out of gas.
 *
 * 0.001 OKB. Settlement is the heaviest action on this page at roughly 450k gas, and this
 * covers it many times over on X Layer. The point is not precision, it is catching the
 * common case of a wallet holding exactly nothing before the user clicks something that
 * cannot possibly succeed.
 */
const MIN_GAS_WEI = 10n ** 15n;

/** Shape returned by /api/price. */
type Quote = {
  slug: string;
  requested: number;
  dataPoints: number;
  historyDays: number;
  source: string;
  pdBps: number;
  pdUpperBps: number;
  advanceRateBps: number;
  discountBps: number;
  breakevenBps: number;
  principal: number;
  fundable: boolean;
  rejectedBecause: string | null;
  contributions: { feature: string; direction: string; weight: number }[];
  /** Human name and readable page, so nothing links a visitor at raw JSON. */
  sourceName?: string;
  sourcePage?: string;
  modelVersion: string;
  disclaimer: string;
};

/**
 * Move the wallet onto the right chain, adding the network first if it does not know it.
 *
 * A wallet that has never seen X Layer answers `wallet_switchEthereumChain` with 4902, which
 * is the standard "unrecognised chain" code. Telling the user to go and add a network by hand
 * at that point is how a working product feels broken, so add it for them: `params` here is
 * everything a wallet needs to create the entry itself.
 *
 * Shared by connect and by every write path, because a user can change networks at any point
 * after connecting and the app has no way to stop them.
 */
async function switchToChain(eth: ethers.Eip1193Provider): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hexId }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902 && code !== -32603) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN.hexId,
          chainName: CHAIN.name,
          nativeCurrency: { name: CHAIN.currency, symbol: CHAIN.currency, decimals: 18 },
          rpcUrls: [CHAIN.rpc],
          blockExplorerUrls: [CHAIN.explorer],
        },
      ],
    });
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="p-5 bg-surface/60">
      <div className="text-xs text-muted-foreground">{label}</div>
      {/* font-sans, not the display face: General Sans slashes its zero. */}
      <div className="text-2xl font-sans font-semibold mt-1.5 tracking-[-0.02em] tabular">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground/60 mt-1">{hint}</div>}
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone: keyof typeof toneClass }) {
  return <span className={`text-[13px] whitespace-nowrap ${toneClass[tone]}`}>{label}</span>;
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground/70">{k}</div>
      <div className="figure text-xs mt-1 break-all text-foreground/70">{v}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ the app */

export default function AppPage() {
  const [tab, setTab] = useState<Tab>("lend");
  const [addresses, setAddresses] = useState<Addresses>(DEFAULT_ADDRESSES);
  const [rpc, setRpc] = useState(CHAIN.rpc);

  const [account, setAccount] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);

  /** Read from DealManager.registry() so it can never point at a registry the protocol ignores. */
  const [registryAddr, setRegistryAddr] = useState<string>("");
  const [minBond, setMinBond] = useState<bigint>(0n);
  const [bondAmount, setBondAmount] = useState("");
  const [modelCommit, setModelCommit] = useState("");

  /** Live pricing, on the Borrow tab. Null until the borrower asks for a quote. */
  const [quoteSlug, setQuoteSlug] = useState("uniswap");
  const [quoteName, setQuoteName] = useState<string | null>("Uniswap");
  const [walletChoices, setWalletChoices] = useState<WalletOption[] | null>(null);
  /** Block range the last scan actually covered, so an empty list can say where it looked. */
  const [scanned, setScanned] = useState<{ from: number; to: number } | null>(null);
  /** The DealManager the vault actually accepts, for the mismatch warning. */
  const [vaultDealManager, setVaultDealManager] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);
  /** Hash of a transaction currently confirming, so the wait has something to show. */
  const [pendingTx, setPendingTx] = useState<string | null>(null);
  /**
   * Reading the chain, as opposed to the user doing something.
   *
   * These shared one `busy` string, so every button on the page went dead for the length of a
   * loan scan - which is seconds, and runs on mount and after every transaction. That is the
   * "I cannot tap anything after it refreshes" behaviour: nothing was broken, the page was
   * disabling itself while it read. A background read must never block a deliberate action.
   */
  const [loading, setLoading] = useState(false);
  /** The AI's signed offer, once it has agreed to underwrite. */
  const [offer, setOffer] = useState<null | {
    dealParams: { dealId: string; borrower: string; adapter: string; principal: string; discountBps: number; maturity: number; gracePeriod: number };
    attestation: Record<string, string | number>;
    signature: string;
    summary: { youReceive: number; youRepay: number; aiStakes: number; termMinutes: number; pdBps: number; expiresAt: number };
  }>(null);
  const [quoteFace, setQuoteFace] = useState("500000");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string>("");

  /**
   * Empty until the chain answers. NOT sample data.
   *
   * This used to start with three invented loans and two invented underwriters, so the first
   * thing a visitor saw was fiction, labelled in a banner most people would not read. On a
   * protocol whose entire claim is that its numbers can be verified, shipping placeholder
   * loans is the one thing it cannot afford to do.
   */
  const [stats, setStats] = useState({
    tvl: 0n, deployed: 0n, idle: 0n, utilBps: 0n, firstLossBps: 0n, paused: false, apyBps: 0n,
  });
  const [deals, setDeals] = useState<Deal[]>([]);
  const [models, setModels] = useState<Underwriter[]>([]);
  const [live, setLive] = useState(false);
  /** Distinguishes "still loading" from "loaded, and there is genuinely nothing here". */
  const [loadFailed, setLoadFailed] = useState(false);

  /** `gas` is the native OKB balance. Without it no button on this page can do anything. */
  const [position, setPosition] = useState({ shares: 0n, assets: 0n, walletUsdt: 0n, gas: 0n });
  const [amount, setAmount] = useState("");
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [showTech, setShowTech] = useState<Record<string, boolean>>({});

  const configured = Boolean(addresses.dealManager && addresses.vault);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("aval.cfg") : null;
    if (saved) {
      try {
        const c = JSON.parse(saved);
        if (c.rpc) setRpc(c.rpc);
        /**
         * Merge, never replace. A config written by an older build can be missing a field
         * that exists now, and assigning it wholesale leaves that field undefined forever,
         * with no way for the user to tell. An undefined USDT address in particular makes
         * every token action fail while the rest of the page looks perfectly healthy.
         */
        if (c.addresses) setAddresses({ ...DEFAULT_ADDRESSES, ...c.addresses });
      } catch {
        /* ignore malformed config */
      }
    }
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.some((x) => x.id === t)) setTab(t);
  }, []);

  /**
   * Progress messages clear themselves. Failures do not.
   *
   * Everything used to vanish after five seconds, so a transaction that failed during gas
   * estimation - which never opens the wallet at all - flashed an error and then left the
   * reader looking at a page that appeared to have done nothing. An error that removes itself
   * before it is read is worse than no error.
   */
  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    if (!bad) setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 5000);
  }, []);

  /* --------------------------------------------------------------- wallet */

  /**
   * Connect to a chosen provider, then get it onto the right chain.
   *
   * Split out from `connect` so the wallet picker can call it directly with the provider the
   * user selected, rather than the picker having to write to shared state and hope the next
   * read sees it.
   */
  const connectWith = useCallback(
    async (eth: ReturnType<typeof getProvider>) => {
      if (!eth) {
        return notify("No wallet found. Install OKX Wallet, MetaMask, or another browser wallet.", true);
      }
      try {
        setBusy("connect");
        const provider = new ethers.BrowserProvider(eth, "any");
        const accs = await provider.send("eth_requestAccounts", []);
        setAccount(accs[0]);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== CHAIN.id) {
          try {
            await switchToChain(eth);
            notify(`Wallet connected and switched to ${CHAIN.name}.`);
            return;
          } catch {
            notify(`Could not switch to ${CHAIN.name}. Change networks in your wallet, then retry.`, true);
            return;
          }
        }
        notify("Wallet connected.");
      } catch {
        notify("Connection cancelled.", true);
      } finally {
        setBusy("");
      }
    },
    [notify]
  );

  /**
   * Ask which wallet, but only when the answer is not obvious.
   *
   * One wallet installed, or one already remembered from a previous visit: connect straight
   * away. Two or more and no memory: show the picker, because silently taking whichever wallet
   * won the race for `window.ethereum` connects the user as an address they did not choose.
   */
  const connect = useCallback(async () => {
    const wallets = await discoverWallets();

    /*
     * The guard here was `!getProvider()`, which never fired.
     *
     * getProvider() falls back to window.ethereum, and with any wallet installed that is a
     * truthy object, so the picker was unreachable and the app went straight back to taking
     * whichever wallet won the injection race. The question is not "do we have a provider",
     * it is "has the person actually chosen one" - which is what rememberedRdns answers.
     */
    const remembered = rememberedRdns();
    const known = remembered ? wallets.find((w) => w.rdns === remembered) : undefined;

    if (known) setProvider(known.provider);
    else if (wallets.length === 1) setProvider(wallets[0].provider);
    else if (wallets.length > 1) {
      setWalletChoices(wallets);
      return;
    }

    await connectWith(getProvider());
  }, [connectWith]);

  /**
   * Reconnect silently, and follow the wallet when the user changes something.
   *
   * Two separate faults this fixes.
   *
   * First, the app only ever learned the account from `eth_requestAccounts`, which prompts.
   * So after any page reload the header said "Connect wallet" even though the wallet was
   * already authorised, and a deposit form sat there refusing to work for no visible reason.
   * `eth_accounts` returns the already-granted account without prompting.
   *
   * Second, nothing listened for changes. Switch account in MetaMask and the page kept
   * showing the old address and the old balance, while any transaction you then sent came
   * from the new one. That is the worst kind of wrong: the interface and the wallet quietly
   * disagreeing about whose money is at stake.
   */
  useEffect(() => {
    type EventfulProvider = ethers.Eip1193Provider & {
      on?: (event: string, handler: (...args: never[]) => void) => void;
      removeListener?: (event: string, handler: (...args: never[]) => void) => void;
    };
    const onAccounts = ((accs: string[]) => {
      if (!Array.isArray(accs) || accs.length === 0) {
        setAccount("");
        setPosition({ shares: 0n, assets: 0n, walletUsdt: 0n, gas: 0n });
        notify("Wallet disconnected.");
        return;
      }
      setAccount(accs[0]);
      notify(`Switched to ${shortAddr(accs[0])}.`);
    }) as (...args: never[]) => void;

    const onChain = (() => {
      // Reload rather than patch state. A chain change invalidates every balance, every
      // contract read and the deal list at once, and reloading is the only way to be certain
      // nothing from the previous chain is left on screen being read as current.
      window.location.reload();
    }) as (...args: never[]) => void;

    /*
     * Discovery has to finish before a provider is read.
     *
     * EIP-6963 announcements arrive on the event loop, so calling getProvider() synchronously
     * on mount finds an empty registry and falls back to window.ethereum. That silently
     * discards the wallet the user picked last visit, which is the whole point of remembering
     * it. So: discover, then attach.
     */
    let eth: EventfulProvider | undefined;
    let cancelled = false;

    void discoverWallets().then(() => {
      if (cancelled) return;
      eth = getProvider() as EventfulProvider | undefined;
      if (!eth) return;

      // Already authorised? Pick it up without prompting.
      eth
        .request({ method: "eth_accounts" })
        .then((accs) => {
          const list = accs as unknown as string[];
          if (!cancelled && Array.isArray(list) && list.length) setAccount(list[0]);
        })
        .catch(() => {
          /* a wallet that refuses eth_accounts is simply treated as disconnected */
        });

      eth.on?.("accountsChanged", onAccounts);
      eth.on?.("chainChanged", onChain);
    });

    return () => {
      cancelled = true;
      eth?.removeListener?.("accountsChanged", onAccounts);
      eth?.removeListener?.("chainChanged", onChain);
    };
  }, [notify]);

  /* ----------------------------------------------------------- chain reads */

  /*
   * Only the newest scan is allowed to write state.
   *
   * refresh() has six callers and no guard, and a full log scan takes seconds. Two overlapping
   * runs used to race: whichever finished last won, so a stale scan could overwrite a fresh
   * one, and because `busy` is a single shared string the first to finish cleared the spinner
   * for both, leaving a page that looked idle while it was still working. A token means a
   * superseded run finishes quietly and changes nothing.
   */
  const refreshRun = useRef(0);

  /**
   * Read a set of deals by id.
   *
   * Every field comes from getDeal, a plain contract call, so a deal known only by id renders
   * exactly like one just discovered. Event data is used only where it adds something getDeal
   * does not carry: the conformal upper bound, the model commit, the settlement split.
   */
  const buildDeals = useCallback(
    async (
      ids: string[],
      events: Record<string, ethers.LogDescription[]>,
      dm: ethers.Contract,
      provider: ethers.JsonRpcProvider
    ): Promise<Deal[]> => {
      const anchorBy = Object.fromEntries((events.AttestationAnchored ?? []).map((l) => [l.args.dealId, l.args]));
      const settleBy = Object.fromEntries((events.Settled ?? []).map((l) => [l.args.dealId, l.args]));
      /*
       * Read each deal independently. mapLimit resolves through Promise.all, so a single
       * getDeal that throws used to reject the whole batch, empty the list, and set the failure
       * flag - one unreadable id costing every readable one. Nulls are filtered out below.
       */
      const rows = await mapLimit(ids, 8, async (id): Promise<Deal | null> => {
       try {
        /*
         * Everything below comes from getDeal, a plain contract read, so a deal known only from
         * the cache renders exactly like one just discovered. The DealFunded log is used only
         * where it adds something getDeal does not carry.
         */
        const fundedLog = (events.DealFunded ?? []).find((l) => l.args.dealId === id);
        const args = (fundedLog?.args ?? {}) as Record<string, unknown>;
        const c = await dm.getDeal(id);
        const a = anchorBy[id];
        const s = settleBy[id];

        // The borrower is an address; the adapter knows its human name. Best effort: a deal
        // funded through an adapter that has no label still renders, just with the address.
        let borrowerName = shortAddr(c.borrower);
        try {
          const adapter = new ethers.Contract(c.adapter, ABI.adapter, provider);
          const obligorId = await adapter.dealObligor(id);
          if (obligorId && obligorId !== ethers.ZeroHash) {
            const ob = await adapter.obligors(obligorId);
            if (ob?.label) borrowerName = ob.label;
          }
        } catch {
          /* no adapter label available; the address is still shown */
        }
        return {
          dealId: id,
          borrower: c.borrower,
          underwriter: (args.underwriter as string | undefined) ?? c.underwriter,
          borrowerName,
          principal: c.principal,
          dueAmount: c.dueAmount,
          avalLocked: c.avalLocked,
          repaid: c.repaid,
          pdBps: Number(c.pdBps),
          pdUpperBps: Number(a?.pdUpperBps ?? 0),
          /*
           * The attestation event carries the advance rate, and a deal read by id has no event.
           * Rather than show 0.00%, which reads as "the AI advanced nothing", derive it from
           * figures getDeal does return: principal over the face it was advanced against, which
           * is principal plus the discount. Exact to the basis point.
           */
          advanceRateBps:
            Number(a?.advanceRateBps ?? 0) ||
            (c.dueAmount > 0n ? Number((c.principal * 10_000n) / c.dueAmount) : 0),
          maturity: Number(c.maturity),
          gracePeriod: Number(c.gracePeriod),
          modelCommit: a?.modelCommit ?? "",
          featureHash: a?.featureHash ?? "",
          rationaleCID: a?.rationaleCID ?? "",
          /*
           * Status 2 is Settled in the contract, so a deal reads as settled whether or not we
           * managed to see its Settled event. Without this, a loan discovered by id would render
           * as still running forever, and the Settle button would be offered on a closed deal.
           */
          settled: Number(c.status) === 2 || Boolean(s),
          defaulted: Boolean(c.defaulted) || Boolean(s?.defaulted),
          slashed: s?.slashed ?? 0n,
          feePaid: s?.feePaid ?? 0n,
          feeForfeited: s?.feeForfeited ?? 0n,
        };
       } catch {
         return null; // unreadable id: skip it, keep the rest
       }
      });
      return rows.filter((d): d is Deal => d !== null);
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!configured) return;
    const run = ++refreshRun.current;
    const current = () => run === refreshRun.current;
    try {
      setLoading(true);
      setLoadFailed(false);
      const provider = new ethers.JsonRpcProvider(rpc);
      const dm = new ethers.Contract(addresses.dealManager, ABI.dealManager, provider);
      const [regAddr, repAddr, vaultAddr] = await Promise.all([dm.registry(), dm.reputation(), dm.vault()]);
      const vault = new ethers.Contract(vaultAddr, ABI.vault, provider);
      const reputation = new ethers.Contract(repAddr, ABI.reputation, provider);
      const registry = new ethers.Contract(regAddr, ABI.registry, provider);
      // Held so the underwriter panel can offer registration without re-deriving it. The
      // registry address is read from the DealManager rather than configured, so it cannot
      // point somewhere the protocol does not actually use.
      if (current()) setRegistryAddr(regAddr);
      registry.minBond().then(setMinBond).catch(() => {});

      const [tvl, deployed, idle, utilBps, firstLossBps, paused] = await Promise.all([
        vault.totalAssets(),
        vault.deployedAssets(),
        vault.idleAssets(),
        vault.utilizationBps(),
        dm.firstLossBps(),
        dm.paused(),
      ]);
      if (current()) setStats({ tvl, deployed, idle, utilBps, firstLossBps, paused, apyBps: 0n });
      // Real state is on screen from this point. Flipping `live` only after the deals and
      // reputation loops meant one failed downstream read left genuine numbers flying a
      // "sample data" warning.
      if (current()) setLive(true);

      // Scan from the deployment block, in adaptive chunks. Scanning from 0 on a chain with
      // 37M+ blocks is rejected by most public RPCs.
      const head = await provider.getBlockNumber();
      const from = addresses.deployBlock || 0;
      if (current()) setScanned({ from, to: head });

      /*
       * Remember which deals we have already discovered, and where the scan got to.
       *
       * Log discovery is the fragile part: it is the only thing here that needs a public
       * endpoint to answer many requests in a row, and it is the only thing that fails. But a
       * deal id never changes once found, so there is no reason to rediscover it on every visit.
       *
       * The cache holds the ids and the block the last successful scan reached. A later visit
       * scans only the blocks since then, which is usually a handful of windows rather than
       * forty, and the loans it already knows about render immediately from getDeal - which is a
       * plain contract read, and those have never been the problem.
       *
       * Consequence that matters: the scan has to succeed once, ever. After that a rate-limited
       * endpoint costs you newly funded loans, not the whole list.
       */
      const CACHE_KEY = `aval.deals.v2.${addresses.dealManager.toLowerCase()}`;
      // Start from the ids that need no discovery, then add anything cached or scanned.
      let knownIds: string[] = [...SEEDED_DEAL_IDS];
      // Remove anything written by a previous cache format.
      try {
        localStorage.removeItem(`aval.deals.${addresses.dealManager.toLowerCase()}`);
      } catch {
        /* nothing to clean up */
      }
      let scanFrom = from;
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const c = JSON.parse(raw) as { ids?: string[]; scannedTo?: number };
          // Only accept things that actually look like a deal id. A malformed entry from an
          // older build would otherwise be handed to getDeal on every single load, forever.
          const valid = (c.ids ?? []).filter((x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x));
          knownIds = [...new Set([...knownIds, ...valid])];
          // Overlap by a few thousand blocks: a reorg or a partial write should not lose a deal.
          if (typeof c.scannedTo === "number" && c.scannedTo > from) scanFrom = Math.max(from, c.scannedTo - 5_000);
        }
      } catch {
        /* unreadable cache is not worth failing over; scan the whole range */
      }

      // One pass over the contract's whole log history, decoded locally, instead of three
      // parallel filtered scans over the same range. See queryAllEvents.
      /*
       * Before scanning, check the vault is even pointed at this DealManager.
       *
       * A vault reporting deployed assets while its DealManager emits no DealFunded events is
       * not a chain that lost your loans; it is a frontend reading the wrong contract. That
       * has exactly one honest answer and it is not "no loans yet".
       */
      try {
        const wired: string = await vault.dealManager();
        if (current()) setVaultDealManager(wired);
      } catch {
        /* older vault without the getter: skip the check rather than fail the load */
      }

      /*
       * Render everything we can already name, then stop waiting.
       *
       * Reading four deals by id is four contract calls and takes about a second. Discovering
       * new ones is a walk over a hundred and sixty thousand blocks and takes the best part of a
       * minute on a public endpoint. Doing them in that order behind one spinner meant the page
       * sat on "Reading the chain" for the length of the slow one while the fast one had
       * finished immediately.
       *
       * So the known deals paint first and the loading state ends there. Discovery continues
       * afterwards and merges whatever it finds, which is usually nothing new. If it fails, the
       * list that is already on screen is untouched.
       */
      /*
       * Anything funded recently, in one small query, with no wallet needed.
       *
       * A loan made minutes ago is a few hundred blocks old. Asking for the last twenty
       * thousand blocks is one request over a narrow range, which every endpoint answers - it
       * is the hundred-and-sixty-thousand-block sweep that gets refused, not the idea of
       * reading logs.
       *
       * This is what makes a loan appear for someone who has not connected a wallet, cleared
       * their site data, or is looking at a browser that never funded it. Between this, the
       * derived seed ids and the per-wallet lookup, everything a demo needs is found without
       * the full sweep succeeding even once.
       */
      const RECENT_WINDOW = 20_000;
      try {
        const recentLogs = await provider.getLogs({
          address: addresses.dealManager,
          fromBlock: Math.max(from, head - RECENT_WINDOW),
          toBlock: head,
          topics: [dm.interface.getEvent("DealFunded")!.topicHash],
        });
        for (const log of recentLogs) {
          const parsed = dm.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) knownIds.push(parsed.args.dealId as string);
        }
        knownIds = [...new Set(knownIds)];
      } catch {
        /* even a narrow window can be refused; the other paths still stand */
      }

      /*
       * Find the connected wallet's own loans in a single request.
       *
       * DealFunded indexes the borrower, so filtering on it is enormously selective: the node
       * walks its index rather than every log in the range, and the answer is a handful of
       * entries instead of thousands. Endpoints that throttle a forty-window sweep answer this
       * one comfortably.
       *
       * This is what makes a loan you took out visible again after clearing site data. The
       * broad scan is still the only way to see OTHER people's loans, and it still runs, but
       * yours no longer depend on it.
       */
      if (account) {
        try {
          const topics = [
            dm.interface.getEvent("DealFunded")!.topicHash,
            null,
            ethers.zeroPadValue(account.toLowerCase(), 32),
          ];
          const mineLogs = await provider.getLogs({
            address: addresses.dealManager,
            fromBlock: from,
            toBlock: head,
            topics,
          });
          for (const log of mineLogs) {
            const parsed = dm.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) knownIds.push(parsed.args.dealId as string);
          }
          knownIds = [...new Set(knownIds)];
        } catch {
          /* even this can be refused; the broad scan below is the fallback */
        }
      }

      if (knownIds.length > 0) {
        const first = await buildDeals(knownIds, {}, dm, provider);
        if (current()) {
          setDeals(first.filter((d) => d.principal > 0n));
          setLoading(false);
        }
      }

      const events = await queryAllEvents(dm, scanFrom, head);
      const scannedIds = (events.DealFunded ?? []).map((l) => l.args.dealId as string);
      const allIds = [...new Set([...knownIds, ...scannedIds])];
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ids: allIds, scannedTo: head }));
      } catch {
        /* private browsing; the next visit simply scans again */
      }

      const funded = events.DealFunded ?? [];
      const anchorBy = Object.fromEntries((events.AttestationAnchored ?? []).map((l) => [l.args.dealId, l.args]));
      const settleBy = Object.fromEntries((events.Settled ?? []).map((l) => [l.args.dealId, l.args]));

      // Bounded concurrency rather than one-at-a-time: fast on a big deployment, and still
      // polite enough not to trip rate limits.
      const nextDeals = await buildDeals(allIds, events, dm, provider);
      /*
       * Status None means no such deal here. Seeded ids are derived optimistically, so a
       * deployment that was seeded differently simply has none of them, and a row of zeroes
       * would be worse than no row.
       */
      const realDeals = nextDeals.filter((d) => d.principal > 0n);
      if (current()) setDeals(realDeals);

      const uniq = [...new Set(funded.map((l) => l.args.underwriter as string))];
      const nextModels: Underwriter[] = await mapLimit(uniq, 4, async (address) => {
        const [rec, score, dr, u] = await Promise.all([
          reputation.getRecord(address),
          reputation.brierScore(address),
          reputation.realisedDefaultRateBps(address),
          registry.getUnderwriter(address),
        ]);
        return {
          address,
          name: shortAddr(address),
          brier: Number(score) / 1e18,
          predictions: Number(rec.predictions),
          defaults: Number(rec.defaults),
          principalUnderwritten: rec.principalUnderwritten,
          totalSlashed: rec.totalSlashed,
          feesForfeited: rec.feesForfeited,
          defaultRateBps: dr,
          bondTotal: u.bondTotal,
          bondLocked: u.bondLocked,
          modelVersion: Number(u.modelVersion),
        };
      });
      if (current()) setModels(nextModels);
      if (current()) setLive(true);
      if (current()) notify(`Loaded ${nextDeals.length} loans from ${CHAIN.name}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed to read the chain";
      if (current()) setLoadFailed(true);
      notify(msg, true);
    } finally {
      if (current()) setLoading(false);
    }
  }, [configured, rpc, addresses, account, notify, buildDeals]);

  useEffect(() => {
    if (configured) void refresh();
  }, [configured, refresh]);

  const loadPosition = useCallback(async () => {
    if (!configured || !account) return;
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const vault = new ethers.Contract(addresses.vault, ABI.vault, provider);
      const shares = await vault.balanceOf(account);
      const assets = shares > 0n ? await vault.convertToAssets(shares) : 0n;
      let walletUsdt = 0n;
      if (addresses.usdt) {
        const usdt = new ethers.Contract(addresses.usdt, ABI.erc20, provider);
        walletUsdt = await usdt.balanceOf(account);
      }
      // Native balance. Every button here sends a transaction, so with no gas the whole page
      // is decorative and the user deserves to be told that up front rather than after a
      // wallet throws something unreadable at them.
      const gas = await provider.getBalance(account);
      setPosition({ shares, assets, walletUsdt, gas });
    } catch {
      /* position is best effort */
    }
  }, [configured, account, rpc, addresses]);

  useEffect(() => {
    void loadPosition();
  }, [loadPosition]);

  /* ---------------------------------------------------------------- writes */

  /**
   * Get a signer, having first made sure the wallet is actually on the right chain.
   *
   * THIS IS NOT OPTIONAL PLUMBING. Without it a wallet left on Ethereum, or any other
   * network, sends every transaction to the wrong place. Some wallets reject it with a
   * message nobody can act on, some let it through and it simply fails, and in both cases
   * the app looks broken while being entirely correct.
   *
   * Rather than telling the user to go and change a setting, ask the wallet to switch. If it
   * has never heard of X Layer it answers 4902, and then we add the network for them. Both
   * are standard EIP-3326 / EIP-3085 calls that every major wallet implements.
   */
  /**
   * A provider that notices a confirmation promptly.
   *
   * ethers v6 polls eth_getTransactionReceipt every 4000ms by default. X Layer produces blocks
   * in about two seconds, so the default spends most of the wait doing nothing: a transaction
   * that landed almost immediately is reported four to eight seconds later, and with a slow
   * wallet endpoint it compounds. One second is the difference between "instant" and "is this
   * broken".
   */
  const browserProvider = (eth: NonNullable<ReturnType<typeof getProvider>>) => {
    const p = new ethers.BrowserProvider(eth, "any");
    p.pollingInterval = 1_000;
    return p;
  };

  const withSigner = useCallback(async () => {
    const eth = getProvider();
    if (!eth) throw new Error("No wallet found. Install a wallet extension, then reload.");

    const provider = browserProvider(eth);
    const current = await provider.getNetwork();

    if (Number(current.chainId) !== CHAIN.id) {
      notify(`Switching your wallet to ${CHAIN.name}.`);
      await switchToChain(eth);
      // The provider caches the network it saw at construction, so build a fresh one.
      return browserProvider(eth).getSigner();
    }

    return provider.getSigner();
  }, [notify]);

  /**
   * Send a transaction and say so the moment it is broadcast.
   *
   * Every write here used to await tx.wait() behind a spinner and nothing else, so the reader
   * had no idea whether the transaction existed. The signature is accepted, the wallet closes,
   * and then several silent seconds pass. Announcing the hash immediately turns that into a
   * wait with a visible cause, and gives them something to open on the explorer.
   */
  /**
   * Work out the gas limit ourselves, using the endpoint we know answers.
   *
   * Left alone, ethers estimates through the wallet's provider. That is the request that hangs
   * when a wallet's own endpoint is unhealthy, and it hangs BEFORE the signature prompt, so the
   * user sees nothing at all. Estimating against this app's RPC and passing an explicit
   * gasLimit means the wallet is only ever asked to sign, never to estimate.
   *
   * A failed estimate is not fatal here: it is returned as undefined and ethers falls back to
   * its own estimation, so the worst case is the behaviour we had before rather than a blocked
   * button. The 25% headroom covers the difference between a simulated and a mined block.
   */
  const sendPopulatedTx = useCallback(
    async (
      signer: any,
      to: string,
      data: string
    ): Promise<any> => {
      const read = new ethers.JsonRpcProvider(rpc);
      const from = await signer.getAddress();
      const tx: any = { to, data, from, chainId: CHAIN.id };
      
      const [nonce, feeData, gasLimit] = await Promise.all([
        read.getTransactionCount(from, "latest"),
        read.getFeeData(),
        read.estimateGas(tx)
      ]);
      
      tx.nonce = nonce;
      tx.gasLimit = (gasLimit * 125n) / 100n;
      if (feeData.maxFeePerGas) {
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else {
        tx.gasPrice = feeData.gasPrice;
      }
      
      return signer.sendTransaction(tx);
    },
    [rpc]
  );


  const confirmTx = useCallback(
    async (label: string, send: () => Promise<any>) => {
      /*
       * A wallet that never answers must not look like a wallet that is thinking.
       *
       * ethers calls eth_estimateGas before it asks anyone to sign, and on a write that request
       * goes through the WALLET's own endpoint rather than the one this app reads from. If the
       * wallet's X Layer endpoint is slow or down, estimation never returns: no popup appears,
       * no error is thrown, and the button spins forever. That is indistinguishable from a
       * broken app and it is what "nothing popped up in OKX" actually is.
       *
       * So the send is raced against a deadline. Forty-five seconds is far longer than any
       * healthy wallet needs and far shorter than forever.
       */
      const SEND_TIMEOUT_MS = 45_000;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tx = await Promise.race([
        send(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Your wallet never responded. It usually means the wallet's own network " +
                    "endpoint is not answering. Switch networks in the wallet and back, or set " +
                    "your own RPC under Settings, then try again. Nothing was sent."
                )
              ),
            SEND_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(timer));

      setPendingTx(tx.hash);
      notify(`${label} sent. Waiting for ${CHAIN.name} to confirm.`);
      try {
        return await tx.wait();
      } finally {
        setPendingTx(null);
      }
    },
    [notify]
  );

  const deposit = useCallback(async () => {
    const value = toUnits(amount);
    if (value <= 0n) return notify("Enter an amount first.", true);
    try {
      setBusy("deposit");
      const signer = await withSigner();
      const me = await signer.getAddress();
      const readUsdt = new ethers.Contract(addresses.usdt, ABI.erc20, new ethers.JsonRpcProvider(rpc));
      const allowance: bigint = await readUsdt.allowance(me, addresses.vault);
      const usdt = new ethers.Contract(addresses.usdt, ABI.erc20, signer);
      if (allowance < value) {
        notify("Approving USDT, confirm in your wallet.");
        const data = usdt.interface.encodeFunctionData("approve", [addresses.vault, value]);
        await confirmTx("Approval", () => sendPopulatedTx(signer, addresses.usdt, data));
      }
      const vault = new ethers.Contract(addresses.vault, ABI.vault, signer);
      notify("Depositing, confirm in your wallet.");
      const data = vault.interface.encodeFunctionData("deposit", [value, me]);
      await confirmTx("Deposit", () => sendPopulatedTx(signer, addresses.vault, data));
      notify("Deposit confirmed.");
      setAmount("");
      await Promise.all([refresh(), loadPosition()]);
    } catch (e) {
      notify(explainTxError(e), true);
    } finally {
      setBusy("");
    }
  }, [amount, addresses, withSigner, notify, confirmTx, sendPopulatedTx, refresh, loadPosition]);

  const withdraw = useCallback(async () => {
    try {
      setBusy("withdraw");
      const signer = await withSigner();
      const me = await signer.getAddress();
      const readVault = new ethers.Contract(addresses.vault, ABI.vault, new ethers.JsonRpcProvider(rpc));
      const vault = new ethers.Contract(addresses.vault, ABI.vault, signer);
      const maxShares: bigint = await readVault.maxRedeem(me);
      const shares = amount ? (toUnits(amount) * position.shares) / (position.assets || 1n) : maxShares;
      const use = shares > maxShares ? maxShares : shares;
      if (use <= 0n) return notify("Nothing to withdraw.", true);
      notify("Withdrawing, confirm in your wallet.");
      const data = vault.interface.encodeFunctionData("redeem", [use, me, me]);
      await confirmTx("Withdrawal", () => sendPopulatedTx(signer, addresses.vault, data));
      notify("Withdrawal confirmed.");
      setAmount("");
      await Promise.all([refresh(), loadPosition()]);
    } catch (e) {
      notify(explainTxError(e), true);
    } finally {
      setBusy("");
    }
  }, [amount, addresses, position, withSigner, notify, confirmTx, sendPopulatedTx, refresh, loadPosition]);

  const repay = useCallback(
    async (deal: Deal) => {
      try {
        setBusy("repay-" + deal.dealId);
        const signer = await withSigner();
        const me = await signer.getAddress();
        const owed = deal.dueAmount - deal.repaid;
        const readUsdt = new ethers.Contract(addresses.usdt, ABI.erc20, new ethers.JsonRpcProvider(rpc));
        const allowance: bigint = await readUsdt.allowance(me, addresses.dealManager);
        const usdt = new ethers.Contract(addresses.usdt, ABI.erc20, signer);
        if (allowance < owed) {
          notify("Approving USDT, confirm in your wallet.");
          const data = usdt.interface.encodeFunctionData("approve", [addresses.dealManager, owed]);
          await confirmTx("Approval", () => sendPopulatedTx(signer, addresses.usdt, data));
        }
        const dm = new ethers.Contract(addresses.dealManager, ABI.dealManager, signer);
        notify("Repaying, confirm in your wallet.");
        const data = dm.interface.encodeFunctionData("repay", [deal.dealId, owed]);
        await confirmTx("Repayment", () => sendPopulatedTx(signer, addresses.dealManager, data));
        notify("Repayment confirmed.");
        await refresh();
      } catch (e) {
        notify(explainTxError(e), true);
      } finally {
        setBusy("");
      }
    },
    [addresses, withSigner, notify, confirmTx, sendPopulatedTx, refresh]
  );

  /**
   * Become an underwriter.
   *
   * `register` is a plain external call: no allowlist, no owner approval, no privileged role.
   * Anyone who posts a bond can price loans and appear on the leaderboard, and a protocol
   * whose whole claim is "compete on realised calibration" cannot then hide the entry point
   * behind a shell script.
   *
   * Registering is only half the job. Actually pricing a loan means signing an EIP-712
   * attestation with this key, which happens in the agent process, not in a browser. The
   * panel says so rather than implying a button that does not exist.
   */
  const registerUnderwriter = useCallback(async () => {
    const commit = modelCommit.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(commit)) {
      return notify("Model commit must be a 32-byte hex hash, starting 0x.", true);
    }
    const amount = toUnits(bondAmount);
    if (amount < minBond) {
      return notify(`Bond must be at least ${fmtUsdt(minBond)} USDT.`, true);
    }
    try {
      setBusy("register");
      const signer = await withSigner();
      const me = await signer.getAddress();
      const readUsdt = new ethers.Contract(addresses.usdt, ABI.erc20, new ethers.JsonRpcProvider(rpc));
      const allowance: bigint = await readUsdt.allowance(me, registryAddr);
      const usdt = new ethers.Contract(addresses.usdt, ABI.erc20, signer);
      if (allowance < amount) {
        notify("Approving your bond, confirm in your wallet.");
        const data = usdt.interface.encodeFunctionData("approve", [registryAddr, amount]);
        await confirmTx("Approval", () => sendPopulatedTx(signer, addresses.usdt, data));
      }
      const registry = new ethers.Contract(registryAddr, ABI.registry, signer);
      notify("Registering, confirm in your wallet.");
      const data = registry.interface.encodeFunctionData("register", [commit, amount]);
      await confirmTx("Registration", () => sendPopulatedTx(signer, registryAddr, data));
      notify("Registered. Your bond is posted and you are on the leaderboard.");
      setBondAmount("");
      setModelCommit("");
      await Promise.all([refresh(), loadPosition()]);
    } catch (e) {
      notify(explainTxError(e), true);
    } finally {
      setBusy("");
    }
  }, [modelCommit, bondAmount, minBond, addresses, registryAddr, withSigner, notify, confirmTx, sendPopulatedTx, refresh, loadPosition]);

  /**
   * Ask the AI what it thinks of a business.
   *
   * No wallet, no gas, no signature. This is the model reading a real revenue history and
   * saying what it would offer, which is the one thing a borrower actually wants to know
   * before doing anything else. Producing a real loan still requires an underwriter to sign
   * and bond it, and the result says so.
   */
  const getQuote = useCallback(async () => {
    const slug = quoteSlug.trim().toLowerCase();
    if (!slug) return setQuoteError("Enter a business name first.");
    try {
      setBusy("quote");
      setQuoteError("");
      setQuote(null);
      const face = Math.max(1, Math.round(Number(quoteFace.replace(/,/g, "")) || 0));
      const res = await fetch(`/api/price?slug=${encodeURIComponent(slug)}&face=${face}`);
      const data = await res.json();
      if (!res.ok) {
        setQuoteError(data?.error ?? "Could not price that business.");
        return;
      }
      setQuote(data as Quote);
    } catch {
      setQuoteError("Could not reach the pricing service. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }, [quoteSlug, quoteFace]);

  /**
   * Get test USDT, without leaving the page.
   *
   * The pool is already funded, so nothing about the demo needs this. It exists because
   * someone who connects a fresh wallet to try lending otherwise sees a zero balance and a
   * deposit button that cannot work, with no explanation and no way forward. Telling them to
   * go and run a shell script is not an answer for a product.
   *
   * Testnet only, and gated on the chain id rather than on a flag someone could forget to
   * flip. Real USDT has no mint function.
   */
  const mintTestUsdt = useCallback(async () => {
    try {
      setBusy("mint");
      const signer = await withSigner();
      const me = await signer.getAddress();
      /*
       * Confirm this is the token the protocol actually uses before minting into it.
       *
       * deployments/1952.json never recorded the USDT address, so the one in the build was
       * copied by hand. If a redeploy produced a new MockUSDT, minting still succeeds and the
       * balance still shows, but the vault will not accept it and every deposit fails for a
       * reason nothing on screen explains.
       */
      const readVault = new ethers.Contract(addresses.vault, ABI.vault, new ethers.JsonRpcProvider(rpc));
      try {
        const wanted: string = await readVault.asset();
        if (wanted.toLowerCase() !== addresses.usdt.toLowerCase()) {
          return notify(
            `The pool holds ${shortAddr(wanted)}, not the ${shortAddr(addresses.usdt)} this app is set to. Fix the USDT address under Settings first.`,
            true
          );
        }
      } catch {
        /* an older vault without asset(): proceed rather than block */
      }

      const usdt = new ethers.Contract(addresses.usdt, ABI.erc20, signer);
      const amount = 10_000n * 10n ** BigInt(USDT_DECIMALS);

      // Fully populate against our own endpoint, then hand the wallet a signature request only.
      const data = usdt.interface.encodeFunctionData("mint", [me, amount]);

      notify("Requesting the mint. Approve it in your wallet.");
      await confirmTx("Mint", () => sendPopulatedTx(signer, addresses.usdt, data));
      notify("Done. 10,000 test USDT is in your wallet.");
      await loadPosition();
    } catch (e) {
      notify(explainTxError(e), true);
    } finally {
      setBusy("");
    }
  }, [addresses, withSigner, notify, confirmTx, sendPopulatedTx, loadPosition]);

  /**
   * Close out a matured loan.
   *
   * Deliberately available to anyone, because the contract makes it safe to be. `settle()`
   * takes no outcome argument: it reads repaid against dueAmount and decides for itself. A
   * caller can therefore only be early, which reverts, or correct. Nobody can settle a loan
   * the wrong way, so there is no reason to hide this behind a privileged role, and hiding it
   * would contradict the claim that the protocol keeps running with no operator.
   *
   * This is also the moment the whole protocol exists to produce. If the borrower did not
   * repay, confirming this transaction takes the AI's own collateral and pays it to lenders.
   */
  const settle = useCallback(
    async (deal: Deal) => {
      try {
        setBusy("settle-" + deal.dealId);
        const signer = await withSigner();
        const dm = new ethers.Contract(addresses.dealManager, ABI.dealManager, signer);

        // Same reasoning as the faucet, and it matters more here: this is the transaction the
        // whole protocol is about, and a silent hang on it is the worst moment to have one.
        const data = dm.interface.encodeFunctionData("settle", [deal.dealId]);

        notify("Settling, confirm in your wallet.");
        await confirmTx("Settlement", () => sendPopulatedTx(signer, addresses.dealManager, data));
        const repaidInFull = deal.repaid >= deal.dueAmount;
        notify(
          repaidInFull
            ? "Settled. The loan was repaid, so the AI got its collateral back and earned its fee."
            : "Settled. The loan defaulted, so the AI's collateral was slashed to the lenders."
        );
        await Promise.all([refresh(), loadPosition()]);
      } catch (e) {
        notify(explainTxError(e), true);
      } finally {
        setBusy("");
      }
    },
    [addresses, withSigner, notify, confirmTx, sendPopulatedTx, refresh, loadPosition]
  );

  /* ------------------------------------------------------------ borrowing */

  /**
   * Take the loan out.
   *
   * Two steps, and the split is the point. First the AI is asked to underwrite: it prices the
   * business, checks its own free bond against the chain, and signs an EIP-712 attestation
   * accepting liability. Only then does the borrower sign anything, and what they submit carries
   * the AI's signature with it. `fundDeal` verifies that signature, locks the AI's collateral,
   * and moves the principal - so the money and the liability move in the same transaction.
   *
   * The offer is held in state between the two steps rather than funded immediately, because a
   * person is entitled to read what they are agreeing to before their wallet opens.
   */
  const requestOffer = useCallback(async () => {
    if (!account) return notify("Connect a wallet first: the loan is paid to it.", true);
    const face = Number(quoteFace);
    if (!Number.isFinite(face) || face <= 0) return notify("Enter an amount first.", true);
    try {
      setBusy("offer");
      setOffer(null);
      const res = await fetch("/api/underwrite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: quoteSlug.trim().toLowerCase(), face, borrower: account }),
      });
      const data = await res.json();
      if (!res.ok) return notify(data?.error ?? "The AI would not underwrite this.", true);
      setOffer(data);
      notify("The AI has signed an offer. Read it, then fund it.");
    } catch {
      notify("Could not reach the underwriter. Try again.", true);
    } finally {
      setBusy("");
    }
  }, [account, quoteSlug, quoteFace, notify]);

  const fundOffer = useCallback(async () => {
    if (!offer) return;
    if (offer.summary.expiresAt * 1000 < Date.now()) {
      setOffer(null);
      return notify("That offer expired. Ask the AI again.", true);
    }
    try {
      setBusy("fund");
      const signer = await withSigner();
      const dm = new ethers.Contract(addresses.dealManager, ABI.dealManager, signer);

      const p = { ...offer.dealParams, principal: BigInt(offer.dealParams.principal) };
      const a = offer.attestation;

      const data = dm.interface.encodeFunctionData("fundDeal", [p, a, offer.signature]);

      notify("Funding the loan. Approve it in your wallet.");
      await confirmTx("Loan", () => sendPopulatedTx(signer, addresses.dealManager, data));

      /*
       * Write the id down the moment it exists. The browser knows it, so waiting to rediscover
       * it through a log scan would be choosing the fragile path over the certain one.
       */
      try {
        const k = `aval.deals.${addresses.dealManager.toLowerCase()}`;
        const c = JSON.parse(localStorage.getItem(k) ?? "{}");
        const ids: string[] = Array.isArray(c.ids) ? c.ids : [];
        localStorage.setItem(k, JSON.stringify({ ...c, ids: [...new Set([...ids, offer.dealParams.dealId])] }));
      } catch {
        /* the scan will find it eventually */
      }

      notify(`Done. ${offer.summary.youReceive.toLocaleString("en-US")} USDT is in your wallet.`);
      setOffer(null);
      setTab("loans");
      await Promise.all([refresh(), loadPosition()]);
    } catch (e) {
      notify(explainTxError(e), true);
    } finally {
      setBusy("");
    }
  }, [offer, addresses, withSigner, notify, confirmTx, sendPopulatedTx, refresh, loadPosition]);


  const saveConfig = useCallback(
    (next: Addresses, nextRpc: string) => {
      setAddresses(next);
      setRpc(nextRpc);
      localStorage.setItem("aval.cfg", JSON.stringify({ addresses: next, rpc: nextRpc }));
      notify("Settings saved.");
    },
    [notify]
  );

  const myLoans = useMemo(
    () => deals.filter((d) => account && d.borrower.toLowerCase() === account.toLowerCase()),
    [deals, account]
  );

  /* ----------------------------------------------------------------- view */

  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground">
      {/* header */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border">
        {/*
          Deliberately the same shape as components/landing/navigation.tsx: same max width,
          same padding, same logo treatment, same link styling. The app used to have its own
          header with a different wordmark and a "Back to site" link, which made it read as a
          separate product bolted on rather than the same one.
        */}
        <nav className="max-w-[1200px] mx-auto w-full py-5 px-6 md:px-8 flex items-center justify-between gap-6">
          <Link href="/" className="font-display font-semibold text-lg tracking-tight shrink-0">
            Aval
          </Link>

          <div className="hidden md:flex items-center gap-8">
            {SITE_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {l.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <SettingsDialog addresses={addresses} rpc={rpc} onSave={saveConfig} />
            {/*
              Once connected the button had nothing left to do: clicking it re-ran a connect
              that was already done. The useful action at that point is getting the address
              out, to paste into an explorer or a faucet, and a truncated address on screen
              cannot be selected by hand. So it copies.
            */}
            {/*
              A quiet sign that a read is in flight. It replaces the old behaviour of disabling
              everything, which communicated the same thing by making the page look broken.
            */}
            {loading && (
              <span className="hidden sm:flex items-center gap-1.5 text-[12px] text-muted-foreground mr-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Reading the chain
              </span>
            )}

            {account ? (
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(account);
                    setCopiedAddr(true);
                    setTimeout(() => setCopiedAddr(false), 1600);
                  } catch {
                    // Clipboard is blocked on insecure origins. Say so rather than appear dead.
                    notify("Could not copy. Select the address from the explorer link instead.", true);
                  }
                }}
                size="sm"
                title={account}
                aria-label={copiedAddr ? "Address copied" : `Copy address ${account}`}
                className="rounded-full h-9 px-4 bg-secondary text-foreground hover:bg-secondary/80"
              >
                {copiedAddr ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span className="figure">{copiedAddr ? "Copied" : shortAddr(account)}</span>
              </Button>
            ) : (
              <Button
                onClick={connect}
                size="sm"
                className="rounded-full h-9 px-4 bg-primary text-primary-foreground hover:brightness-110"
                disabled={busy === "connect"}
              >
                {busy === "connect" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Wallet className="w-4 h-4" />
                )}
                Connect wallet
              </Button>
            )}
          </div>
        </nav>
      </header>

      {!live && (
        <div className="bg-foreground/[0.06] border-b border-border">
          <div className="max-w-[1300px] mx-auto px-6 py-2.5 text-[13px] text-foreground/80 flex items-center gap-2 flex-wrap">
            {loadFailed ? (
              <>
                <span className="font-medium">Could not reach the network.</span>
                <span className="text-muted-foreground">
                  Nothing is shown rather than something invented. Reload to try again.
                </span>
              </>
            ) : (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-muted-foreground">Reading the chain…</span>
              </>
            )}
          </div>
        </div>
      )}

      {/*
        Out of gas. Shown before anything is clicked, because every action on this page is a
        transaction and a wallet with no OKB fails with a message most people cannot read.
        Deliberately above the fold and not dismissible: it is the reason nothing will work.
      */}
      {account && configured && position.gas < MIN_GAS_WEI && (
        <div className="bg-primary/[0.08] border-b border-primary/25">
          <div className="max-w-[1300px] mx-auto px-6 py-3 text-[13px] flex items-center gap-x-2 gap-y-1 flex-wrap">
            <span className="font-medium text-foreground">
              This wallet has no {CHAIN.currency} for gas.
            </span>
            <span className="text-foreground/70">
              Every action here is a transaction, so nothing will work until you have some.
            </span>
            <a
              href="https://web3.okx.com/xlayer/faucet"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:brightness-110"
            >
              Get {CHAIN.currency} from the faucet
            </a>
            <span className="text-muted-foreground">
              (free, {CHAIN.name}, capped at 0.2 per day)
            </span>
          </div>
        </div>
      )}

      <div className="max-w-[1300px] mx-auto px-6 py-10">
        {/* pool summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-secondary border border-border rounded-2xl overflow-hidden mb-10">
          <Stat label="Total in the pool" value={`${fmtCompact(stats.tvl)} USDT`} hint="deposited by lenders" />
          <Stat label="Currently lent out" value={`${fmtCompact(stats.deployed)} USDT`} hint={`${fmtPct(stats.utilBps, 1)} in use`} />
          <Stat label="Available now" value={`${fmtCompact(stats.idle)} USDT`} hint="ready to lend or withdraw" />
          <Stat
            label="AI stakes per loan"
            value={fmtPct(stats.firstLossBps, 0)}
            hint="absorbed before lenders lose"
          />
        </div>

        {/* tabs */}
        <div className="flex gap-1 p-1 bg-surface-2 border border-border rounded-full w-fit mb-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 h-9 rounded-full text-sm font-medium transition-all ${
                tab === t.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-[15px] mb-8 max-w-2xl">{TABS.find((t) => t.id === tab)?.blurb}</p>

        {/* ------------------------------------------------------------ lend */}
        {tab === "lend" && (
          <div className="grid lg:grid-cols-[1fr_380px] gap-6 items-start">
            <div className="rounded-2xl border border-border overflow-hidden">
              <div className="p-6 border-b border-border">
                <h2 className="text-2xl font-display">What you get</h2>
                <p className="text-muted-foreground text-[15px] mt-2 leading-relaxed">
                  Your USDT is lent to businesses against revenue they have already earned. Every
                  loan is priced by an AI that stakes {fmtPct(stats.firstLossBps, 0)} of the amount
                  as collateral. If a loan fails, that collateral pays you first, and you only lose
                  whatever is left after it runs out.
                </p>
              </div>
              <div className="grid sm:grid-cols-3 gap-px bg-secondary">
                <div className="bg-background p-5">
                  <div className="text-xs text-muted-foreground">You deposit</div>
                  <div className="text-lg font-display mt-1">USDT</div>
                </div>
                <div className="bg-background p-5">
                  <div className="text-xs text-muted-foreground">You receive</div>
                  <div className="text-lg font-display mt-1">Pool shares</div>
                </div>
                <div className="bg-background p-5">
                  <div className="text-xs text-muted-foreground">You can exit</div>
                  <div className="text-lg font-display mt-1">Any time</div>
                </div>
              </div>
              <div className="p-6 border-t border-border text-[14px] text-muted-foreground leading-relaxed">
                Withdrawals are never pausable. Even if new lending is halted, your exit stays open.
              </div>
            </div>

            <div className="rounded-2xl border border-border p-6">
              <h3 className="text-lg font-display mb-1">Your position</h3>
              <div className="text-3xl font-sans font-semibold mt-3 tracking-[-0.02em] tabular">
                {account ? `${fmtUsdt(position.assets)} USDT` : "-"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {account ? `${fmtUsdt(position.shares)} shares` : "Connect your wallet to see this"}
              </div>

              <div className="mt-6 space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Amount</span>
                  {account && (
                    <button
                      className="hover:text-foreground transition-colors"
                      onClick={() => setAmount(String(Number(position.walletUsdt) / 1e6))}
                    >
                      Wallet: {fmtUsdt(position.walletUsdt)} USDT
                    </button>
                  )}
                </div>
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="h-12 text-lg figure bg-surface-2 border-input"
                />
                <Button
                  onClick={account ? deposit : connect}
                  disabled={busy === "connect" || (!configured && Boolean(account))}
                  className="w-full h-11 rounded-full bg-primary text-primary-foreground hover:brightness-110"
                >
                  {busy === "deposit" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {account ? "Deposit USDT" : "Connect wallet to deposit"}
                </Button>
                <Button
                  onClick={withdraw}
                  variant="outline"
                  disabled={!account || busy === "withdraw" || !configured}
                  className="w-full h-11 rounded-full bg-transparent border-input hover:bg-secondary hover:text-foreground"
                >
                  {busy === "withdraw" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Withdraw
                </Button>
                {/*
                  Only offered on a test network, and only when the wallet is actually empty,
                  so it does not clutter the panel for anyone who already has a balance.
                */}
                {account && configured && CHAIN.id !== NETWORKS.mainnet.id && position.walletUsdt === 0n && (
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4 mt-4">
                    <p className="text-[13px] leading-relaxed text-foreground/70 mb-3">
                      <span className="text-foreground font-medium">No USDT in this wallet.</span> This
                      is a test network, so the USDT here is a test token with no value. Get some
                      and try depositing.
                    </p>
                    <Button
                      onClick={mintTestUsdt}
                      disabled={busy === "quote"}
                      size="sm"
                      className="rounded-full bg-primary text-primary-foreground hover:brightness-110"
                    >
                      {busy === "mint" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                      Get 10,000 test USDT
                    </Button>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground/60 leading-relaxed pt-1">
                  Leave the amount blank when withdrawing to take out everything.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------- borrow */}
        {tab === "borrow" && (
          <div className="space-y-6">
            {/*
              The AI, actually working, on a business the visitor chooses. No wallet and no
              gas, because nothing is signed here. This is the model's opinion; a real loan
              needs an underwriter to sign it and lock its own collateral behind it.
            */}
            <div className="rounded-2xl border border-border p-6">
              <h3 className="text-lg font-display mb-1">Ask the AI what it thinks</h3>
              <p className="text-muted-foreground text-[14px] leading-relaxed mb-5 max-w-2xl">
                Pick a business and say how much you want. The AI reads that business&rsquo;s real
                revenue history and tells you what it would lend, at what price, and how much of
                its own money it will put behind the decision.
              </p>

              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[220px]">
                  <BusinessPicker
                    value={quoteSlug}
                    onChange={(slug, name) => {
                      setQuoteSlug(slug);
                      setQuoteName(name ?? null);
                    }}
                    onSubmit={getQuote}
                  />
                </div>
                <div className="w-44">
                  <label className="block text-xs text-muted-foreground mb-1.5">Amount wanted (USDT)</label>
                  <Input
                    value={quoteFace}
                    onChange={(e) => setQuoteFace(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && getQuote()}
                    inputMode="decimal"
                    className="h-11 figure bg-surface-2 border-input"
                  />
                </div>
                <Button
                  onClick={getQuote}
                  disabled={busy === "quote"}
                  className="h-11 px-6 rounded-full bg-primary text-primary-foreground hover:brightness-110"
                >
                  {busy === "quote" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                  Price it
                </Button>
              </div>

              {/* The suggestion chips are gone: the picker is the list now, and a row of four
                  lowercase slugs under a searchable roster was the old interface hanging on. */}

              {quoteError && (
                <div className="mt-5 rounded-xl border border-border bg-surface-2 p-4 text-[14px] text-foreground/75">
                  {quoteError}
                </div>
              )}

              {quote && (
                <div className="mt-6">
                  {/*
                    The verdict used to be a green panel or a red one. It says "The AI would
                    lend against this" in plain English, which is a stronger signal than any
                    fill, so the panel is neutral and a rule down the left edge marks it -
                    amber when there is an offer on the table, plain when there is not.
                  */}
                  <div
                    className="rounded-xl border border-border bg-surface p-5"
                  >
                    <p className="text-[15px] leading-relaxed text-foreground/80">
                      {quote.fundable ? (
                        <>
                          <span className="text-foreground font-medium">
                            The AI would lend against this.
                          </span>{" "}
                          It read {quote.dataPoints} days of revenue, about{" "}
                          {Math.round(quote.dataPoints / 365)} years, and put the chance of not being
                          repaid at <span className="text-foreground">{fmtPct(quote.pdBps)}</span>.
                        </>
                      ) : (
                        <>
                          <span className="text-foreground font-medium">The AI would refuse this.</span>{" "}
                          {quote.rejectedBecause}
                        </>
                      )}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-secondary border border-border rounded-xl overflow-hidden mt-5">
                    <Stat label="Chance of default" value={fmtPct(quote.pdBps)} hint="the AI is graded on this later" />
                    <Stat label="Worst case it allows" value={fmtPct(quote.pdUpperBps)} hint="the protocol refuses above 30%" />
                    <Stat
                      label="It would advance"
                      value={`${(quote.advanceRateBps / 100).toFixed(0)}%`}
                      hint={`${quote.principal.toLocaleString("en-US")} USDT`}
                    />
                    <Stat label="Cost of the money" value={fmtPct(quote.discountBps)} hint={`covers the risk at ${fmtPct(quote.breakevenBps)}`} />
                  </div>

                  {/*
                    This was four red and green lozenges in a column, which told you the sign
                    and nothing else. It is a tornado chart now: the bar sits left of the centre
                    line for an input that argues in the borrower's favour and right of it for
                    one that argues against, and its length is that input's pull relative to the
                    strongest in the set.
                    Direction reads three ways at once - side, brightness, and the words - so
                    nothing here depends on telling two hues apart.
                  */}
                  {quote.contributions.length > 0 && (
                    <div className="mt-6">
                      <div className="flex items-baseline justify-between mb-3">
                        <div className="text-[13px] text-muted-foreground">
                          What drove the decision
                        </div>
                        <div className="text-[11px] text-muted-foreground/60">
                          Biggest influence first
                        </div>
                      </div>
                      <ul>
                        {quote.contributions.map((c) => {
                          const raises = c.direction !== "Lowers risk";
                          return (
                            <li
                              key={c.feature}
                              className="flex items-center gap-4 py-2.5 border-b border-border last:border-0"
                            >
                              <span className="text-[14px] text-foreground/85 flex-1 min-w-0 truncate">
                                {c.feature}
                              </span>

                              <div className="relative h-1.5 w-24 shrink-0" aria-hidden>
                                <span className="absolute inset-y-[-3px] left-1/2 w-px bg-border" />
                                <span
                                  className={`absolute inset-y-0 rounded-[1px] ${
                                    raises ? "left-1/2 bg-foreground/55" : "right-1/2 bg-foreground/25"
                                  }`}
                                  style={{ width: `${Math.max(4, c.weight * 50)}%` }}
                                />
                              </div>

                              <span
                                className={`text-[11px] w-[74px] text-right shrink-0 ${
                                  raises ? "text-foreground/70" : "text-muted-foreground/70"
                                }`}
                              >
                                {c.direction}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* This linked to the raw JSON endpoint, so "check it yourself" opened a wall
                      of unformatted numbers. It points at the readable revenue page now, with
                      the endpoint offered separately for anyone who actually wants the feed. */}
                  {/*
                    The tab used to end here, on a price and nothing else. A quote with no way to
                    accept it reads as a broken product rather than a calculator, because nothing
                    on screen says which one it is.
                  */}
                  {quote.fundable && (
                    <div className="mt-6 rounded-xl border border-border bg-surface p-5">
                      {!offer ? (
                        <>
                          <div className="text-[15px] text-foreground/85 mb-1">Take this loan</div>
                          <p className="text-[13px] text-muted-foreground leading-relaxed mb-4">
                            The AI will sign an offer accepting liability for it, then you fund it
                            from your own wallet. Its collateral locks in the same transaction that
                            pays you.
                          </p>
                          <Button
                            onClick={requestOffer}
                            disabled={busy === "offer" || !account}
                            className="rounded-full h-11 px-6 bg-primary text-primary-foreground hover:brightness-110"
                          >
                            {busy === "offer" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                            {account ? "Ask the AI to underwrite it" : "Connect a wallet to borrow"}
                          </Button>
                        </>
                      ) : (
                        <>
                          <div className="text-[15px] text-foreground mb-3">
                            The AI has signed this offer.
                          </div>
                          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 text-[14px] mb-4">
                            {[
                              ["You receive now", `${offer.summary.youReceive.toLocaleString("en-US")} USDT`],
                              ["You repay", `${offer.summary.youRepay.toLocaleString("en-US")} USDT`],
                              ["Due in", `${offer.summary.termMinutes} minutes`],
                              ["The AI stakes", `${offer.summary.aiStakes.toLocaleString("en-US")} USDT`],
                            ].map(([k, v]) => (
                              <div key={k} className="flex justify-between gap-4 border-b border-border py-1.5">
                                <span className="text-muted-foreground">{k}</span>
                                <span className="figure">{v}</span>
                              </div>
                            ))}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Button
                              onClick={fundOffer}
                              disabled={busy === "fund"}
                              className="rounded-full h-11 px-6 bg-primary text-primary-foreground hover:brightness-110"
                            >
                              {busy === "fund" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                              Borrow {offer.summary.youReceive.toLocaleString("en-US")} USDT
                            </Button>
                            <button
                              onClick={() => setOffer(null)}
                              className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              Discard
                            </button>
                          </div>
                          <p className="text-[12px] text-muted-foreground/70 mt-4 leading-relaxed">
                            Short term on purpose, so you can watch it mature and settle in one
                            sitting. Repay it under Loans, or leave it and the AI gets slashed.
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  <p className="text-[12px] text-muted-foreground/70 mt-5 leading-relaxed">
                    {quote.disclaimer} Model {quote.modelVersion}, scored against{" "}
                    <a
                      href={quote.sourcePage ?? quote.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {quoteName ?? quote.sourceName ?? "this business"}&rsquo;s published revenue
                    </a>
                    , which you can open and check yourself
                    {quote.sourcePage && (
                      <>
                        {" "}
                        (
                        <a
                          href={quote.source}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-muted-foreground"
                        >
                          raw feed
                        </a>
                        )
                      </>
                    )}
                    .
                  </p>
                </div>
              )}
            </div>

            <div className="grid md:grid-cols-3 gap-px bg-secondary border border-border rounded-2xl overflow-hidden">
              {[
                { n: "01", t: "You have revenue", d: "Steady income your business already earns, onchain or off." },
                { n: "02", t: "The AI prices it", d: "It reads your history and stakes its own money on the call." },
                { n: "03", t: "You repay later", d: "Settle by the due date, in full or in parts." },
              ].map((s) => (
                <div key={s.n} className="bg-background p-6">
                  <div className="figure text-xs text-muted-foreground/70 mb-4">{s.n}</div>
                  <div className="text-lg font-display mb-2">{s.t}</div>
                  <p className="text-muted-foreground text-[14px] leading-relaxed">{s.d}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-border p-6">
              <h3 className="text-lg font-display mb-2">Your loans</h3>
              {!account ? (
                <div className="py-10 text-center">
                  <p className="text-muted-foreground text-[15px] mb-5">Connect your wallet to see loans made to you.</p>
                  <Button onClick={connect} className="rounded-full bg-primary text-primary-foreground hover:brightness-110 h-10 px-6">
                    <Wallet className="w-4 h-4" /> Connect wallet
                  </Button>
                </div>
              ) : myLoans.length === 0 ? (
                <p className="text-muted-foreground text-[15px] py-8">
                  No loans against this address yet. Borrowing opens once an underwriter has priced
                  your revenue.
                </p>
              ) : (
                <div className="space-y-3">
                  {myLoans.map((d) => (
                    <div key={d.dealId} className="flex flex-wrap items-center gap-4 p-4 rounded-xl bg-surface border border-border">
                      <div className="flex-1 min-w-[180px]">
                        <div className="text-[15px]">{fmtUsdt(d.principal)} USDT borrowed</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {fmtUsdt(d.dueAmount - d.repaid)} USDT still owed / {daysUntil(d.maturity)}
                        </div>
                      </div>
                      <Pill {...dealStatus(d)} />
                      {!d.settled && (
                        <Button
                          onClick={() => repay(d)}
                          disabled={busy === "deposit" || !configured}
                          size="sm"
                          className="rounded-full bg-primary text-primary-foreground hover:brightness-110"
                        >
                          {busy === "repay-" + d.dealId ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                          Repay in full
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ----------------------------------------------------------- loans */}
        {tab === "loans" && (
          <div className="rounded-2xl border border-border overflow-hidden">
            {deals.length === 0 ? (
              /*
                Three different situations used to render the same four words. A failed scan
                looked exactly like a protocol nobody has borrowed from, which is the most
                misleading thing this page could do: the pool stats above it load first and
                keep showing real money, so the reader concludes the lending is fake rather
                than that a request failed.
              */
              <div className="p-12 text-center max-w-md mx-auto">
                {loadFailed ? (
                  <>
                    <div className="text-foreground mb-2">Could not read the loan history.</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      The pool figures above came through, so the network is reachable and this
                      is the log scan failing, usually a rate limit on the public endpoint. Try
                      again, or set your own RPC under Settings.
                    </p>
                  </>
                ) : !live ? (
                  <div className="text-muted-foreground">Reading the chain\u2026</div>
                ) : vaultDealManager &&
                  vaultDealManager.toLowerCase() !== addresses.dealManager.toLowerCase() ? (
                  <>
                    <div className="text-foreground mb-2">Reading the wrong contract.</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      The pool accepts loans from{" "}
                      <span className="figure">{shortAddr(vaultDealManager)}</span>, but this app
                      is set to <span className="figure">{shortAddr(addresses.dealManager)}</span>.
                      That is why the list is empty while the pool shows money lent out. Fix the
                      DealManager address under Settings.
                    </p>
                  </>
                ) : stats.deployed > 0n && !loadFailed ? (
                  /*
                    This combination is impossible, and saying so is more useful than any
                    guess. SeniorVault.deployTo is onlyDealManager, and DealManager.fundDeal
                    emits DealFunded on the very next line, so assets cannot be deployed
                    without a funding event existing. An empty list beside a non-zero
                    "currently lent out" therefore proves the endpoint did not return the
                    logs, rather than that nobody has borrowed.
                  */
                  <>
                    <div className="text-foreground mb-2">The loan history did not load.</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      The pool reports{" "}
                      <span className="figure">{fmtUsdt(stats.deployed)}</span> USDT lent out, so
                      loans exist on this deployment. They are read by id, which needs no log
                      query, so this is unusual. Reload once; if it persists, set your own RPC
                      endpoint under Settings.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-foreground mb-2">No loans yet.</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      Nothing has been funded through this deployment.
                      {scanned && (
                        <>
                          {" "}
                          Scanned blocks{" "}
                          <span className="figure">{scanned.from.toLocaleString("en-US")}</span> to{" "}
                          <span className="figure">{scanned.to.toLocaleString("en-US")}</span>.
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
            ) : (
              deals.map((d) => {
                const st = dealStatus(d);
                const open = openDeal === d.dealId;
                return (
                  <div key={d.dealId} className="border-b border-border last:border-0">
                    <button
                      onClick={() => setOpenDeal(open ? null : d.dealId)}
                      className="w-full text-left p-5 hover:bg-surface-2 transition-colors flex flex-wrap items-center gap-4"
                    >
                      <div className="flex-1 min-w-[200px]">
                        <div className="text-[15px]">{d.borrowerName}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 figure">{shortHash(d.dealId)}</div>
                      </div>
                      <div className="text-right">
                        <div className="figure text-[15px]">{fmtUsdt(d.principal)}</div>
                        <div className="text-[11px] text-muted-foreground/70">USDT lent</div>
                      </div>
                      <div className="text-right w-28">
                        <div className="figure text-[15px]">{fmtPct(d.pdBps)}</div>
                        <div className="text-[11px] text-muted-foreground/70">AI risk call</div>
                      </div>
                      <div className="text-right w-32">
                        <div className="figure text-[15px]">{fmtUsdt(d.avalLocked)}</div>
                        <div className="text-[11px] text-muted-foreground/70">AI staked</div>
                      </div>
                      <Pill {...st} />
                      <ChevronDown className={`w-4 h-4 text-muted-foreground/60 transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>

                    {open && (
                      <div className="px-5 pb-6 bg-surface/60">
                        {/*
                          The one place on the site that gets the red, and it gets it as a rule
                          down the edge rather than a wash across the panel: this is the sentence
                          where the model's own money left its hands.
                        */}
                        {d.settled && d.defaulted && (
                          <div className="rounded-xl border border-border bg-surface p-4 mb-5 text-[14px] leading-relaxed text-foreground/75">
                            <span className="text-foreground font-medium">The AI got this one wrong.</span>{" "}
                            It said there was a {fmtPct(d.pdBps)} chance of default. The loan
                            defaulted, so {fmtUsdt(d.slashed)} USDT of its own money went to the
                            lenders and it lost {fmtUsdt(d.feeForfeited)} USDT of its fee.
                          </div>
                        )}
                        {d.settled && !d.defaulted && (
                          <div className="rounded-xl border border-border bg-surface p-4 mb-5 text-[14px] leading-relaxed text-foreground/75">
                            <span className="text-foreground font-medium">Repaid in full.</span> The AI
                            got its {fmtUsdt(d.avalLocked)} USDT collateral back and earned{" "}
                            {fmtUsdt(d.feePaid)} USDT for the accuracy of its call.
                          </div>
                        )}
                        {!d.settled && !isSettleable(d) && (
                          <div className="rounded-xl border border-border bg-surface p-4 mb-5 text-[14px] leading-relaxed text-foreground/75">
                            <span className="text-foreground font-medium">Still running.</span>{" "}
                            {fmtUsdt(d.avalLocked)} USDT of the AI operator&apos;s own capital is
                            locked against this loan. {daysUntil(d.maturity)}.
                          </div>
                        )}

                        {/*
                          The payoff. A matured loan anyone can close, with the consequence
                          stated before they click rather than discovered afterwards.
                        */}
                        {isSettleable(d) && (
                          <div className="rounded-xl border border-primary/30 bg-primary/[0.07] p-4 mb-5">
                            <div className="text-[14px] leading-relaxed text-foreground/80">
                              <span className="text-foreground font-medium">This loan is ready to close.</span>{" "}
                              {d.repaid >= d.dueAmount ? (
                                <>
                                  It was repaid in full, so settling returns the AI&apos;s{" "}
                                  {fmtUsdt(d.avalLocked)} USDT collateral and pays its fee, scaled to
                                  how accurate the {fmtPct(d.pdBps)} call turned out to be.
                                </>
                              ) : (
                                <>
                                  The AI said there was a {fmtPct(d.pdBps)} chance this would default,
                                  and it was not repaid. Settling takes {fmtUsdt(d.avalLocked)} USDT of
                                  the AI operator&apos;s own money and pays it to the lenders, and
                                  writes the miss to its permanent record.
                                </>
                              )}
                            </div>
                            <div className="mt-4 flex flex-wrap items-center gap-3">
                              <Button
                                onClick={() => settle(d)}
                                disabled={busy.startsWith("settle-") || !configured || !live}
                                size="sm"
                                className="rounded-full bg-primary text-primary-foreground hover:brightness-110"
                              >
                                {busy === "settle-" + d.dealId ? (
                                  <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                                ) : null}
                                Settle this loan
                              </Button>
                              <span className="text-[12px] text-muted-foreground">
                                Anyone can do this. The contract decides the outcome from its own
                                state, so it cannot be settled the wrong way.
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-5">
                          <Field k="Amount owed back" v={`${fmtUsdt(d.dueAmount)} USDT`} />
                          <Field k="Repaid so far" v={`${fmtUsdt(d.repaid)} USDT`} />
                          <Field k="Advance rate" v={fmtPct(d.advanceRateBps)} />
                          <Field k="Underwriter" v={shortAddr(d.underwriter)} />
                        </div>

                        <button
                          onClick={() => setShowTech((s) => ({ ...s, [d.dealId]: !s[d.dealId] }))}
                          className="text-[13px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
                        >
                          {showTech[d.dealId] ? "Hide" : "Show"} technical details
                          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showTech[d.dealId] ? "rotate-180" : ""}`} />
                        </button>

                        {showTech[d.dealId] && (
                          <div className="mt-4 grid sm:grid-cols-2 gap-5 pt-4 border-t border-border">
                            <Field k="Loan id" v={d.dealId} />
                            <Field k="Borrower address" v={d.borrower} />
                            <Field k="Model version hash" v={d.modelCommit || "-"} />
                            <Field k="Hash of the inputs it saw" v={d.featureHash || "-"} />
                            <Field k="Written reasoning (IPFS)" v={d.rationaleCID || "-"} />
                            <Field k="Upper bound on risk" v={fmtPct(d.pdUpperBps)} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ---------------------------------------------------------- models */}
        {/*
          The third role, made reachable. Registration is permissionless in the contract, so
          hiding it behind a shell script would contradict the claim that anyone can compete.
        */}
        {tab === "models" && (
          <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] p-6 mb-6">
            <h3 className="text-lg font-display mb-1">Put your own model up against it</h3>
            <p className="text-muted-foreground text-[14px] leading-relaxed mb-5 max-w-2xl">
              Anyone can underwrite here. Post a bond, pin the version of the model you claim to
              run, and every loan you price is scored against what actually happened. There is no
              approval step and no allowlist.
            </p>

            {!account ? (
              <Button onClick={connect} className="rounded-full bg-primary text-primary-foreground hover:brightness-110 h-10 px-6">
                <Wallet className="w-4 h-4" /> Connect wallet to register
              </Button>
            ) : (
              <>
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[260px]">
                    <label className="block text-xs text-muted-foreground mb-1.5">
                      Model commit (hash of your weights and inference code)
                    </label>
                    <Input
                      value={modelCommit}
                      onChange={(e) => setModelCommit(e.target.value)}
                      placeholder="0x…"
                      className="h-11 figure text-[13px] bg-surface-2 border-input"
                    />
                  </div>
                  <div className="w-48">
                    <label className="block text-xs text-muted-foreground mb-1.5">
                      Bond (min {fmtUsdt(minBond)} USDT)
                    </label>
                    <Input
                      value={bondAmount}
                      onChange={(e) => setBondAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-11 figure bg-surface-2 border-input"
                    />
                  </div>
                  <Button
                    onClick={registerUnderwriter}
                    disabled={busy === "register" || !configured || !live || !registryAddr}
                    className="h-11 px-6 rounded-full bg-primary text-primary-foreground hover:brightness-110"
                  >
                    {busy === "register" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                    Register
                  </Button>
                </div>
                <p className="text-[12px] text-muted-foreground/70 mt-4 leading-relaxed max-w-2xl">
                  Registering posts your bond and puts you on this leaderboard. Pricing an actual
                  loan means signing an attestation with this key, which the agent process does,
                  not a web page: see <span className="font-mono">agent/src/fund.mjs</span>. Your
                  bond is slashed when a loan you priced is not repaid.
                </p>
              </>
            )}
          </div>
        )}

        {tab === "models" && models.length === 0 && (
          /*
            Without this the tab renders an empty div and the page just looks broken. The
            leaderboard is built from underwriters discovered in the deal history, so it is
            legitimately empty before any deal has been funded, and it is also what you see
            if the reputation reads fail. Say which.
          */
          <div className="rounded-2xl border border-border p-12 text-center">
            <p className="text-muted-foreground text-[15px]">
              {live
                ? "No underwriters have priced a loan yet. The leaderboard fills in as deals are funded and settled."
                : "Waiting for live data. The leaderboard is read from the chain, so it stays empty until that succeeds."}
            </p>
          </div>
        )}

        {tab === "models" && models.length > 0 && (
          <div className="space-y-4">
            {models.map((m) => {
              const label = brierLabel(m.brier, m.predictions);
              return (
                <div key={m.address} className="rounded-2xl border border-border p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                    <div>
                      <div className="text-xl font-display">{m.name}</div>
                      <div className="figure text-xs text-muted-foreground mt-1">
                        {shortAddr(m.address)} / model v{m.modelVersion}
                      </div>
                    </div>
                    <div className="text-right">
                      <Pill label={label.label} tone={label.tone} />
                      <div className="text-xs text-muted-foreground/70 mt-2">
                        based on {m.predictions} settled {m.predictions === 1 ? "loan" : "loans"}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-secondary border border-border rounded-xl overflow-hidden">
                    <Stat label="Total lent on its say-so" value={`${fmtCompact(m.principalUnderwritten)} USDT`} />
                    <Stat label="Loans that defaulted" value={fmtPct(m.defaultRateBps, 0)} />
                    <Stat label="Own money lost" value={`${fmtCompact(m.totalSlashed)} USDT`} hint="collateral taken from it" />
                    <Stat label="Fees given up" value={`${fmtCompact(m.feesForfeited)} USDT`} hint="forfeited for being wrong" />
                  </div>

                  <p className="text-[13px] text-muted-foreground/70 mt-4 leading-relaxed">
                    {/*
                      Was "Accuracy score 0.0016 where 0 is perfect", which reads backwards:
                      everyone expects accuracy to go up. It is a calibration error, so name it
                      that and the direction stops needing an explanation.
                    */}
                    Calibration error {m.brier.toFixed(4)}, where lower is better and zero is
                    perfect. One good call is not a track record, so read it next to the number
                    of loans.
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <FooterSection />

      {/*
        A confirming transaction is the one moment where the reader has committed money and
        the interface has nothing to say. A hash they can open removes the doubt about whether
        anything happened at all.
      */}
      {pendingTx && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-full border border-primary/30 bg-secondary text-foreground text-sm shadow-xl backdrop-blur-xl">
          <Loader2 className="w-4 h-4 shrink-0 animate-spin text-primary" />
          <span>Confirming on {CHAIN.name}</span>
          <a
            href={`${CHAIN.explorer}/tx/${pendingTx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="figure text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {shortHash(pendingTx)}
          </a>
        </div>
      )}

      {walletChoices && (
        <WalletPicker
          wallets={walletChoices}
          onCancel={() => setWalletChoices(null)}
          onPick={(w) => {
            setProvider(w.provider);
            rememberWallet(w.rdns);
            setWalletChoices(null);
            void connectWith(w.provider);
          }}
        />
      )}

      {/*
        Two shapes, because they have different jobs. Progress is a pill that clears itself.
        A failure stays until it is dismissed, so it needs room to wrap a full sentence and a
        way to close - a message that cannot be got rid of is its own kind of broken.
      */}
      {toast && (
        <div
          className={`fixed left-1/2 -translate-x-1/2 z-50 shadow-xl backdrop-blur-xl transition-all ${
            pendingTx ? "bottom-20" : "bottom-6"
          } ${
            toast.bad
              ? "max-w-lg w-[calc(100vw-3rem)] rounded-xl border border-border bg-secondary px-5 py-4"
              : "flex items-center gap-2.5 rounded-full border border-border bg-secondary px-5 py-3"
          }`}
        >
          {toast.bad ? (
            <div className="flex items-start gap-3">
              <p className="text-[14px] leading-relaxed text-foreground/85 flex-1">{toast.msg}</p>
              <button
                onClick={() => setToast(null)}
                aria-label="Dismiss"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-[13px] -mt-0.5"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary" />
              <span className="text-sm text-foreground">{toast.msg}</span>
            </>
          )}
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------- settings ui */

/**
 * Point the app at a different deployment.
 *
 * This earns its place for one reason above the others: when a public RPC starts refusing log
 * queries, and they do, the only fix that does not involve a redeploy is letting the reader
 * supply their own endpoint. The address fields matter less often but answer a fair question
 * about whether the frontend is welded to one server, and they are how this build gets pointed
 * at mainnet without being rebuilt.
 *
 * It used to accept anything. A single mistyped character in an address was saved to local
 * storage, every read then failed against a contract that does not exist, and there was no way
 * back except clearing site data - so the app looked permanently broken and the cause was
 * invisible. Addresses are validated now, and there is a way back.
 */
function SettingsDialog({
  addresses,
  rpc,
  onSave,
}: {
  addresses: Addresses;
  rpc: string;
  onSave: (a: Addresses, rpc: string) => void;
}) {
  const [draft, setDraft] = useState(addresses);
  const [draftRpc, setDraftRpc] = useState(rpc);
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    setDraft(addresses);
    setDraftRpc(rpc);
    setErrors([]);
  }, [addresses, rpc]);

  /** Checked before anything is written, so a typo cannot become a broken app. */
  const validate = (): string[] => {
    const bad: string[] = [];
    const addr = (label: string, v: string) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v.trim())) bad.push(`${label} is not a valid address`);
    };
    addr("DealManager", draft.dealManager);
    addr("Vault", draft.vault);
    addr("USDT", draft.usdt);
    if (!/^https?:\/\/.+/.test(draftRpc.trim())) bad.push("RPC endpoint must start with http:// or https://");
    if (!Number.isFinite(draft.deployBlock) || draft.deployBlock < 0) bad.push("Deployment block must be a number");
    return bad;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary">
          <Settings className="w-4 h-4" />
          <span className="sr-only">Settings</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Connection</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Nothing here is needed to use Aval. It exists so you can supply your own RPC
            endpoint when a public one is failing, and so this frontend can be pointed at any
            deployment rather than only ours.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {(
            [
              ["RPC endpoint", draftRpc, (v: string) => setDraftRpc(v), "https://..."],
              ["DealManager address", draft.dealManager, (v: string) => setDraft({ ...draft, dealManager: v }), "0x..."],
              ["Vault address", draft.vault, (v: string) => setDraft({ ...draft, vault: v }), "0x..."],
              ["USDT address", draft.usdt, (v: string) => setDraft({ ...draft, usdt: v }), "0x..."],
              [
                "Deployment block",
                String(draft.deployBlock || ""),
                (v: string) => setDraft({ ...draft, deployBlock: Number(v) || 0 }),
                "e.g. 37717524",
              ],
            ] as const
          ).map(([label, value, set, placeholder]) => (
            <div key={label}>
              <label className="text-xs text-muted-foreground">{label}</label>
              <Input
                value={value}
                onChange={(e) => set(e.target.value)}
                className="mt-1.5 figure text-xs bg-surface-2 border-input h-10"
                placeholder={placeholder}
              />
            </div>
          ))}

          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            The deployment block bounds how far back event scans go. Leaving it at zero makes
            the app scan the whole chain, which most public RPCs refuse.
          </p>

          {errors.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              {errors.map((e) => (
                <div key={e} className="text-[12px] text-foreground/80">
                  {e}
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={() => {
              const bad = validate();
              setErrors(bad);
              if (bad.length > 0) return;
              onSave({ ...draft, dealManager: draft.dealManager.trim(), vault: draft.vault.trim(), usdt: draft.usdt.trim() }, draftRpc.trim());
              setOpen(false);
            }}
            className="w-full rounded-full h-10 bg-primary text-primary-foreground hover:brightness-110"
          >
            Save and reload data <ArrowRight className="w-4 h-4" />
          </Button>

          {/* The way back. Without this, one bad character is permanent for that browser. */}
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(DEFAULT_ADDRESSES);
              setDraftRpc(CHAIN.rpc);
              setErrors([]);
              onSave(DEFAULT_ADDRESSES, CHAIN.rpc);
              setOpen(false);
            }}
            className="w-full h-9 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Reset to the live deployment
          </Button>

          <a
            href={CHAIN.explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors pt-1"
          >
            Open {CHAIN.name} explorer <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
