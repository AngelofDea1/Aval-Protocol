import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Page, Container, Section, Stat } from "@/components/site/primitives";
import { FIRST_LOSS_BPS, ASSERTIONS_PASSING, SLITHER, PUBLISHED_FINDINGS } from "@/lib/facts";

const roles = [
  {
    title: "Lend",
    who: "You have USDT and want yield",
    body: "Deposit into the pool and your money is lent out as loans are approved. The AI's collateral absorbs the first losses before you feel anything. Withdrawals can never be paused.",
    href: "/app?tab=lend",
    cta: "Start lending",
  },
  {
    title: "Borrow",
    who: "You have revenue and need cash now",
    // Says exactly what the app does. It prices you for free and in public; a real loan
    // needs an underwriter to sign and bond it, and claiming otherwise would be the kind of
    // unbacked promise this protocol exists to price.
    body: "Name your business and the AI reads its real revenue history, then tells you how much it would advance and at what cost. Free, instant, no wallet needed. No equity sold and no crypto collateral posted.",
    href: "/app?tab=borrow",
    cta: "Get priced",
  },
  {
    title: "Underwrite",
    who: "You have a model and want to prove it",
    // Registration really is open to anyone and really is in the app, so this can say so.
    // Pricing loans needs the agent process, because it signs; the app does not pretend
    // otherwise.
    body: "Post a bond and register in the app, with no approval step and no allowlist. Every loan you price is scored against what actually happened, and your bond is slashed when you are wrong.",
    href: "/app?tab=models",
    cta: "Register a model",
  },
];

export default function Home() {
  return (
    <Page>
      <Navigation />

      <Container className="pt-24 pb-24 md:pt-36 md:pb-32 text-center">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-[clamp(2.75rem,7vw,4.75rem)] font-semibold tracking-[-0.035em] leading-[1.03]">
            The AI pays
            <br />
            <span className="text-primary">when it is wrong.</span>
          </h1>

          <div className="mt-10 space-y-5 max-w-xl mx-auto">
            <p className="text-lg text-hero-sub/90 leading-[1.75]">
              Businesses borrow against revenue they have already earned. An AI decides who gets a
              loan and at what price.
            </p>
            <p className="text-lg text-hero-sub/90 leading-[1.75]">
              Before any money moves, the operator running that AI locks up its own capital behind
              the decision. If the loan defaults, that capital goes to the lenders first, and the
              miss is recorded onchain permanently.
            </p>
          </div>

          <div className="mt-12 flex flex-wrap gap-3 justify-center">
            <Link
              href="/app"
              className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 active:scale-[0.98]"
            >
              Open app
            </Link>
            <Link
              href="/protocol"
              className="rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium transition-all hover:bg-surface-2 active:scale-[0.98]"
            >
              How it works
            </Link>
          </div>
        </div>
      </Container>

      <div className="border-y border-border bg-surface/40">
        <Container className="py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
            <Stat value={`${FIRST_LOSS_BPS / 100}%`} label="of every loan staked by the AI" accent />
            <Stat value={String(ASSERTIONS_PASSING)} label="automated checks the code has to pass" />
            <Stat
              value={String(SLITHER.high + SLITHER.medium + SLITHER.low)}
              label="security flaws found by automated analysis"
            />
            <Stat value={String(PUBLISHED_FINDINGS)} label="bugs we found in our own code and published" />
          </div>
        </Container>
      </div>

      <Section>
        <div className="mb-14 max-w-2xl mx-auto text-center">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] leading-tight">
            Three ways to use it.
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-5">
          {roles.map((r) => (
            <div
              key={r.title}
              className="flex flex-col rounded-lg border border-border bg-surface p-7"
            >
              <h3 className="font-display text-2xl font-semibold tracking-tight mb-2">{r.title}</h3>
              <p className="text-primary text-sm mb-6">{r.who}</p>
              <p className="text-muted-foreground leading-[1.7] text-[15px] flex-1 mb-8">{r.body}</p>
              <Link
                href={r.href}
                className="inline-flex w-fit items-center rounded-md border border-border bg-surface-2 px-5 py-2.5 text-sm font-medium transition-colors hover:border-muted-foreground/40"
              >
                {r.cta}
              </Link>
            </div>
          ))}
        </div>
      </Section>

      <FooterSection />
    </Page>
  );
}
