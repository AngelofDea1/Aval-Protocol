import Link from "next/link";
import { CONTRACTS, explorerLink } from "@/lib/facts";

/**
 * Read from facts.ts, never hardcoded.
 *
 * This file used to hold its own copy of the DealManager address and its own explorer URL.
 * After the redeploy both were stale, so the footer's "DealManager" link pointed at a dead
 * contract while every other page was correct. The address-sync script did not catch it
 * because it only rewrites files it knows about, and nobody had told it about this one.
 *
 * Importing removes the class of bug rather than the instance.
 */

const columns = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/protocol" },
      { label: "The AI", href: "/model" },
      { label: "Developers", href: "/developers" },
      // Points at the page that explains the endpoints, not at 16KB of raw JSON. A person
      // clicking a navigation link expects a page; the machine-readable payload is one click
      // further in, where someone who wants it will look.
      { label: "For agents", href: "/agents" },
    ],
  },
  {
    title: "App",
    links: [
      { label: "Lend", href: "/app?tab=lend" },
      { label: "Borrow", href: "/app?tab=borrow" },
      { label: "Loans", href: "/app?tab=loans" },
      { label: "Model leaderboard", href: "/app?tab=models" },
    ],
  },
  {
    title: "Onchain",
    links: [
      { label: "DealManager", href: explorerLink(CONTRACTS.dealManager), external: true },
      { label: "X Layer", href: "https://www.okx.com/xlayer", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of service", href: "/terms" },
      { label: "Privacy policy", href: "/privacy" },
    ],
  },
];

export function FooterSection() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-16">
        <div className="grid gap-12 md:grid-cols-[1.5fr_repeat(4,1fr)]">
          <div>
            <div className="flex items-center gap-2 font-display font-semibold text-lg tracking-tight mb-3">
              <img src="/logo.png" alt="Aval Protocol" className="h-6 w-auto object-contain rounded-md" />
              Aval
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-xs">
              Lending where the AI underwriter stakes its own capital on every decision it makes.
              Built on X Layer.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-[13px] text-foreground/80 mb-4">
                {col.title}
              </h4>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {"external" in l && l.external ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 pt-8 border-t border-border flex flex-wrap justify-between gap-4 text-xs text-muted-foreground/60">
          <span>Unaudited software. Nothing here is financial advice.</span>
          <span className="figure">X Layer · gas in OKB</span>
        </div>
      </div>
    </footer>
  );
}
