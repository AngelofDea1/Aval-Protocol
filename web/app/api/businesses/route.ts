import { NextResponse } from "next/server";

/**
 * The list of businesses a visitor can ask the AI to price.
 *
 * Typing a lowercase slug into a blank box is a developer's interface. A borrower should see
 * "Uniswap", not "uniswap", and should be able to look through what is available rather than
 * guess at a name and hope. So this route publishes the roster and the app renders it as a
 * searchable list.
 *
 * Nothing here is cached to disk and nothing is stored. It is one upstream call, reshaped.
 */

export const runtime = "nodejs";
/** One hour. The roster changes when a protocol starts reporting fees, not by the minute. */
export const revalidate = 3600;

export type Business = {
  /** What a human sees. "Uniswap", not "uniswap". */
  name: string;
  /** What the pricing model is given. */
  slug: string;
  /** Trailing 24h fees in USD, used only to sort the useful ones to the top. */
  recentFees: number | null;
  /** The human page for this business's revenue, never the JSON endpoint. */
  page: string;
};

/**
 * Businesses confirmed to return a usable revenue series.
 *
 * This is the floor, not the list. If the upstream roster is unreachable or arrives in a
 * shape this code does not recognise, the picker still works and still offers something that
 * definitely prices, rather than presenting an empty box and an error.
 */
const KNOWN: Business[] = [
  { name: "Uniswap", slug: "uniswap", recentFees: null, page: "https://defillama.com/protocol/uniswap" },
  { name: "Aave", slug: "aave", recentFees: null, page: "https://defillama.com/protocol/aave" },
  { name: "Lido", slug: "lido", recentFees: null, page: "https://defillama.com/protocol/lido" },
  { name: "Curve DEX", slug: "curve-dex", recentFees: null, page: "https://defillama.com/protocol/curve-dex" },
];

/** Fall back to a slug only when the upstream gives no display name. */
function titleise(slug: string) {
  return slug
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Reshape the upstream roster.
 *
 * Written the same way `normaliseFeeSeries` is: read defensively, accept the shapes that are
 * plausible, and return nothing rather than something wrong. A malformed entry that slipped
 * through as a business nobody can price is worse than a shorter list.
 */
function normalise(payload: unknown): Business[] {
  const root = payload as { protocols?: unknown } | unknown[];
  const rows = Array.isArray(root) ? root : Array.isArray(root?.protocols) ? root.protocols : null;
  if (!rows) return [];

  const out = new Map<string, Business>();

  for (const raw of rows as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;

    const slug = [raw.slug, raw.module, raw.defillamaId]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => /^[a-z0-9][a-z0-9._-]*$/i.test(v));
    if (!slug) continue;

    const name = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : titleise(slug);

    const fees = Number(raw.total24h ?? raw.dailyFees ?? NaN);

    // Deduplicate on slug, preferring the entry that reports revenue: the same protocol can
    // appear once per chain, and four rows called Uniswap is not a list, it is a mess.
    const existing = out.get(slug);
    if (existing && !(Number.isFinite(fees) && (existing.recentFees ?? -1) < fees)) continue;

    out.set(slug, {
      name,
      slug,
      recentFees: Number.isFinite(fees) ? fees : null,
      page: `https://defillama.com/protocol/${encodeURIComponent(slug)}`,
    });
  }

  return [...out.values()];
}

export async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch("https://api.llama.fi/overview/fees", {
      signal: controller.signal,
      headers: { accept: "application/json" },
      next: { revalidate },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const parsed = normalise(await res.json());
    if (parsed.length === 0) throw new Error("roster parsed but held no usable entries");

    // Most revenue first, then alphabetical for everything with no figure, so the top of the
    // list is the businesses somebody would plausibly want and the tail is still navigable.
    parsed.sort((a, b) => (b.recentFees ?? -1) - (a.recentFees ?? -1) || a.name.localeCompare(b.name));

    // Keep the four verified names present even if upstream drops or renames one.
    for (const k of KNOWN) if (!parsed.some((p) => p.slug === k.slug)) parsed.push(k);

    return NextResponse.json(
      { businesses: parsed, count: parsed.length, complete: true },
      { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    // Degrade rather than fail. A short list that works beats an error where a list should be.
    return NextResponse.json({
      businesses: KNOWN,
      count: KNOWN.length,
      complete: false,
      note: `Showing a verified subset: the full roster was unavailable (${
        err instanceof Error ? err.message : "unknown error"
      }). Any business with public revenue can still be typed in directly.`,
    });
  } finally {
    clearTimeout(timer);
  }
}
