import React from "react";

/**
 * Shared layout pieces so every page has the same rhythm.
 *
 * Without these each page drifts into its own spacing and heading sizes, which is the
 * fastest way to make a site look assembled rather than designed.
 */

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex flex-col bg-background text-foreground">{children}</div>;
}

export function Container({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`max-w-[1200px] mx-auto w-full px-6 md:px-8 ${className}`}>{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: string;
}) {
  return (
    <Container className="pt-14 pb-14 md:pt-20 md:pb-16 border-b border-border text-center">
      {/*
        Small grey capitals with wide letter-spacing above every heading is the single most
        recognisable tell of a template. It is set in sentence case here, at reading size, with
        a short rule instead of the letter-spacing doing the signalling.
      */}
      {eyebrow && (
        <div className="flex items-center justify-center gap-3 mb-5">
          <span className="w-6 h-px bg-primary/60" />
          <span className="text-[13px] text-primary">{eyebrow}</span>
          <span className="w-6 h-px bg-primary/60" />
        </div>
      )}
      <h1 className="font-display text-[clamp(2.25rem,5vw,3.5rem)] font-semibold tracking-[-0.03em] leading-[1.08] max-w-3xl mx-auto">
        {title}
      </h1>
      {lede && (
        <p className="mt-6 text-lg text-muted-foreground leading-[1.75] max-w-2xl mx-auto">{lede}</p>
      )}
    </Container>
  );
}

export function Section({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`py-20 md:py-28 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-12 md:mb-16 text-center">
      <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] leading-tight">
        {children}
      </h2>
      {sub && <p className="mt-4 text-muted-foreground leading-[1.75] max-w-2xl mx-auto">{sub}</p>}
    </div>
  );
}

/**
 * Figures render in Geist Sans, not the display face.
 *
 * General Sans draws a slashed zero. That is a deliberate feature of the typeface and it
 * looks wrong on a headline number, so numerals use the body font, whose zero is a plain
 * two-contour oval. `.tabular` also switches off any slashed-zero stylistic set a fallback
 * font might apply.
 */
export function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div>
      <div
        className={`font-sans text-[clamp(1.75rem,3vw,2.5rem)] font-semibold tracking-[-0.02em] tabular ${
          accent ? "text-primary" : ""
        }`}
      >
        {value}
      </div>
      <div className="text-sm text-muted-foreground mt-1.5">{label}</div>
    </div>
  );
}

export function Card({
  title,
  children,
  step,
}: {
  title: string;
  children: React.ReactNode;
  step?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-7">
      {step && <div className="figure text-xs text-primary mb-5">{step}</div>}
      <h3 className="font-display text-xl font-semibold tracking-tight mb-3">{title}</h3>
      <div className="text-muted-foreground leading-relaxed text-[15px]">{children}</div>
    </div>
  );
}

/**
 * Three tones, and the distinction matters.
 *
 * Red used to carry every caveat on the site, including "here are our limitations, stated
 * honestly". That is a semantic error: red means you could lose money or something is broken,
 * and spending it on disclosures both alarms the reader for no reason and blunts the colour
 * for the one place it genuinely belongs. On a site where red also marks a slashed bond and a
 * defaulted loan, that dilution is expensive.
 *
 *   default  supporting detail
 *   caveat   an honest limitation the reader should register, but not an alarm
 *   warn     real risk of losing money
 */
export function Note({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "caveat" | "warn";
}) {
  /*
   * "warn" is the box that tells you the software is unaudited and you can lose everything.
   * It used to be a red panel, which is exactly the treatment a site uses for a cookie nag,
   * so a reader learns to skip it. A plain panel with a weighted rule down the left edge is
   * read rather than dismissed, and the sentence inside is doing the frightening already.
   */
  const tones = {
    default: "border-border bg-surface text-muted-foreground",
    caveat: "border-muted-foreground/25 bg-surface-2 text-foreground/75",
    warn: "border-border bg-surface-2 text-foreground/80",
  } as const;

  return <div className={`rounded-lg border p-5 text-[15px] leading-relaxed ${tones[tone]}`}>{children}</div>;
}

/** Two-column figure/value list, used for the worked example and spec tables. */
export function DataRows({ rows }: { rows: [string, string, string?][] }) {
  return (
    <div className="figure text-sm">
      {rows.map(([k, v, tone]) => (
        <div
          key={k}
          className="flex justify-between gap-6 py-3.5 border-b border-border last:border-0"
        >
          <span className="text-muted-foreground font-sans">{k}</span>
          <span className={tone ?? "text-foreground"}>{v}</span>
        </div>
      ))}
    </div>
  );
}
