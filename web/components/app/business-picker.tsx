"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";

/**
 * Choosing which business to price.
 *
 * This was a blank box with a lowercase placeholder and four suggestion chips, which asks the
 * visitor to already know what Aval can price and to type its internal slug correctly. That is
 * a developer's interface wearing a borrower's clothes.
 *
 * It is a list now: real names, searchable, scrollable. The slug still travels to the model,
 * because that is what the upstream revenue source keys on, but nobody has to see it or type
 * it. Free text is still accepted for anything not on the roster, so nothing that worked
 * before stops working.
 */

export type Business = {
  name: string;
  slug: string;
  recentFees: number | null;
  page: string;
};

const fmtFees = (n: number | null) => {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

export function BusinessPicker({
  value,
  onChange,
  onSubmit,
}: {
  /** The slug currently selected. */
  value: string;
  onChange: (slug: string, name?: string) => void;
  onSubmit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<Business[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/businesses")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setAll(Array.isArray(d.businesses) ? d.businesses : []);
        if (d.complete === false && typeof d.note === "string") setNote(d.note);
      })
      .catch(() => alive && setAll([]));
    return () => {
      alive = false;
    };
  }, []);

  // Close on an outside click. Without this the panel sits over the rest of the form and the
  // visitor has to guess that Escape dismisses it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = useMemo(
    () => all?.find((b) => b.slug.toLowerCase() === value.toLowerCase()) ?? null,
    [all, value]
  );

  const results = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 60);
    // Name matches first: someone typing "uni" means Uniswap, not a protocol with "uni"
    // buried in its slug.
    const starts = all.filter((b) => b.name.toLowerCase().startsWith(q));
    const contains = all.filter(
      (b) => !starts.includes(b) && (b.name.toLowerCase().includes(q) || b.slug.includes(q))
    );
    return [...starts, ...contains].slice(0, 60);
  }, [all, query]);

  const label = selected?.name ?? (value ? value : "");

  return (
    <div className="relative" ref={boxRef}>
      <label className="block text-xs text-muted-foreground mb-1.5">Business</label>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-11 px-3 rounded-md border border-input bg-surface-2 flex items-center justify-between gap-2 text-left transition-colors hover:border-muted-foreground/40"
      >
        <span className={label ? "text-foreground text-[15px]" : "text-muted-foreground text-[15px]"}>
          {label || "Choose a business"}
        </span>
        {all === null ? (
          <Loader2 className="w-4 h-4 shrink-0 text-muted-foreground animate-spin" />
        ) : (
          <ChevronDown
            className={`w-4 h-4 shrink-0 text-muted-foreground/70 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full rounded-xl border border-border bg-popover shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 border-b border-border">
            <Search className="w-4 h-4 shrink-0 text-muted-foreground/70" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter") {
                  const first = results[0];
                  if (first) {
                    onChange(first.slug, first.name);
                    setOpen(false);
                    setQuery("");
                  } else if (query.trim()) {
                    onChange(query.trim().toLowerCase());
                    setOpen(false);
                    setQuery("");
                  }
                }
              }}
              placeholder="Search, or type any business with public revenue"
              className="w-full h-11 bg-transparent outline-none text-[15px] placeholder:text-muted-foreground/60"
            />
          </div>

          <div className="max-h-72 overflow-y-auto">
            {all === null && (
              <div className="px-3 py-6 text-[13px] text-muted-foreground">Loading businesses…</div>
            )}

            {all !== null && results.length === 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!query.trim()) return;
                  onChange(query.trim().toLowerCase());
                  setOpen(false);
                  setQuery("");
                }}
                className="w-full text-left px-3 py-4 text-[13px] text-muted-foreground hover:bg-surface-2"
              >
                Nothing matches. Press Enter to try{" "}
                <span className="text-foreground">{query.trim() || "…"}</span> anyway.
              </button>
            )}

            {results.map((b) => {
              const fees = fmtFees(b.recentFees);
              const isSelected = b.slug.toLowerCase() === value.toLowerCase();
              return (
                <button
                  key={b.slug}
                  type="button"
                  onClick={() => {
                    onChange(b.slug, b.name);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`w-full flex items-baseline justify-between gap-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${
                    isSelected ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="text-[14px] text-foreground truncate">{b.name}</span>
                  {fees && (
                    <span className="figure text-[11px] text-muted-foreground/70 shrink-0">
                      {fees} <span className="font-sans">a day</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {note && (
            <div className="px-3 py-2.5 border-t border-border text-[11px] text-muted-foreground/70 leading-relaxed">
              {note}
            </div>
          )}
        </div>
      )}

      {/* Enter on the closed control prices whatever is selected, matching the amount field. */}
      <button type="button" className="sr-only" onClick={onSubmit} aria-hidden tabIndex={-1} />
    </div>
  );
}
