import type { ethers } from "ethers";

/**
 * Wallet discovery.
 *
 * Reading `window.ethereum` is the old way and it is a race. Every injected wallet writes to
 * that single property on page load, so with MetaMask and OKX Wallet both installed the app
 * silently gets whichever injected last. The user has no say, the header shows an address they
 * did not choose, and on a chain like X Layer, where OKX Wallet is the native choice, that is
 * very likely the wrong one.
 *
 * EIP-6963 fixes it. Wallets announce themselves on an event with a name, an icon and a
 * reverse-DNS id, so the app can list them and let the person pick. Every current wallet
 * supports it; `window.ethereum` stays as the fallback for anything that does not.
 */

export type Eip1193 = ethers.Eip1193Provider & {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type WalletOption = {
  /** Reverse-DNS id, e.g. "com.okex.wallet" or "io.metamask". Stable, so it is what we persist. */
  rdns: string;
  name: string;
  icon: string;
  provider: Eip1193;
};

type Eip6963Detail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
};

const STORAGE_KEY = "aval.wallet";

const found = new Map<string, WalletOption>();
let listening = false;

/**
 * Order the list so the wallet that belongs on this chain is first.
 *
 * Not a value judgement, just context: Aval runs on X Layer, X Layer is OKX's chain, and OKX
 * Wallet already has both networks configured, so it is the connection least likely to need a
 * network prompt at all.
 */
const PREFERRED = ["com.okex.wallet", "com.okx.wallet", "io.metamask"];

function rank(rdns: string) {
  const i = PREFERRED.indexOf(rdns.toLowerCase());
  return i === -1 ? PREFERRED.length : i;
}

function startListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;

  window.addEventListener("eip6963:announceProvider", (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    found.set(detail.info.rdns, {
      rdns: detail.info.rdns,
      name: detail.info.name,
      icon: detail.info.icon,
      provider: detail.provider,
    });
  });

  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * Every wallet that announced itself, best first.
 *
 * Announcements are synchronous but arrive on the event loop, so this waits a tick. Wallets
 * also re-announce on request, which is why the request event fires again here: a wallet
 * unlocked after first page load would otherwise never appear.
 */
export async function discoverWallets(waitMs = 120): Promise<WalletOption[]> {
  if (typeof window === "undefined") return [];
  startListening();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  return [...found.values()].sort((a, b) => rank(a.rdns) - rank(b.rdns) || a.name.localeCompare(b.name));
}

/** The wallet the user chose last time, if it is still installed. */
export function rememberedRdns(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberWallet(rdns: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, rdns);
  } catch {
    /* private browsing: the choice just will not persist, which is not worth an error */
  }
}

let chosen: Eip1193 | null = null;

export function setProvider(p: Eip1193) {
  chosen = p;
}

/**
 * The provider every call should use.
 *
 * Falls back through: an explicit choice this session, the remembered choice if that wallet is
 * still announcing, then `window.ethereum` for wallets that do not implement EIP-6963.
 */
export function getProvider(): Eip1193 | undefined {
  if (chosen) return chosen;

  const remembered = rememberedRdns();
  if (remembered && found.has(remembered)) {
    chosen = found.get(remembered)!.provider;
    return chosen;
  }

  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum;
}
