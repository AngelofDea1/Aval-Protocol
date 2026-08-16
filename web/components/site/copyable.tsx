"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Anything a developer will need to paste somewhere else.
 *
 * Contract addresses, shell commands and an EIP-712 type definition are all things a reader
 * will want in their clipboard, and asking them to select forty hex characters by hand is the
 * kind of small hostility that makes a site feel unfinished.
 *
 * Deliberately no toast: the icon swaps to a tick for a moment and swaps back. Confirmation
 * belongs next to the thing you clicked, not at the other end of the screen.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked, e.g. an insecure origin: the text is still selectable */
        }
      }}
      aria-label={copied ? "Copied" : label}
      className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:border-muted-foreground/40"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * A code block with a copy button in the corner.
 *
 * The button sits inside the block rather than above it, so it is obvious what it copies when
 * a page has several in a row.
 */
export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative group">
      <pre className="rounded-lg border border-border bg-surface p-5 pr-16 overflow-x-auto">
        <code className="font-mono text-[13px] leading-relaxed text-foreground/85">{children}</code>
      </pre>
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <CopyButton text={children} />
      </div>
    </div>
  );
}
