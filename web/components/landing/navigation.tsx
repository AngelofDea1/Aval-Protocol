"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * One page, one name, everywhere.
 *
 * "Protocol" and "Model" are the sort of labels that describe a codebase rather than tell a
 * visitor what they will find. "How it works" matches the hero button that points at the same
 * page, and "The AI" names the thing that actually makes this project different. It also
 * avoids colliding with the Models tab inside the app, which is the leaderboard.
 */
export const SITE_LINKS = [
  { href: "/protocol", label: "How it works" },
  { href: "/model", label: "The AI" },
  { href: "/agents", label: "For agents" },
  { href: "/developers", label: "Developers" },
];

export function Navigation({ transparent = false }: { transparent?: boolean }) {
  const pathname = usePathname();

  return (
    <header
      className={
        transparent
          ? "w-full relative z-50"
          : "w-full sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border"
      }
    >
      <nav className="max-w-[1200px] mx-auto w-full py-5 px-6 md:px-8 flex items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-2 font-display font-semibold text-lg tracking-tight shrink-0">
          <img src="/logo.png" alt="Aval Protocol" className="h-6 w-auto object-contain rounded-md" />
          Aval
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {SITE_LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`text-sm transition-colors ${
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <Link
          href="/app"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 active:scale-[0.98]"
        >
          Open app
        </Link>
      </nav>
    </header>
  );
}
