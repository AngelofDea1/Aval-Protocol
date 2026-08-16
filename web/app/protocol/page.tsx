import type { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import {
  Page,
  Container,
  PageHeader,
  Section,
  SectionTitle,
  Card,
  DataRows,
  Note,
} from "@/components/site/primitives";
import { FIRST_LOSS_BPS, SLITHER, PUBLISHED_FINDINGS, workedExample } from "@/lib/facts";

export const metadata: Metadata = {
  title: "Protocol",
  description:
    "A fixed first-loss bond for solvency, a strictly proper scoring rule for honesty, and an onchain calibration record.",
};

const ex = workedExample();

const steps = [
  {
    step: "01",
    title: "The AI makes a call",
    body: "A business with steady revenue asks for cash up front. The model reads its income history and states one number: the chance this loan is not repaid.",
  },
  {
    step: "02",
    title: "It stakes its own money",
    body: `Before a dollar moves, the operator running that model locks ${FIRST_LOSS_BPS / 100}% of the loan as collateral. If the loan fails, that money reaches lenders before they lose anything.`,
  },
  {
    step: "03",
    title: "Reality settles up",
    body: "Repaid, and the collateral returns with a fee. Not repaid, and it is taken, most of the fee disappears, and the miss is recorded permanently.",
  },
];

const safeguards = [
  [
    "It signs, it cannot spend",
    "The AI signs an opinion. Contracts move the money, and only on the exact terms that signature covers.",
  ],
  [
    "No silent model swaps",
    "Each version is pinned onchain. Changing it is allowed but always visible, so a track record cannot be inherited.",
  ],
  [
    "Failure degrades safely",
    "If the AI goes offline, existing loans still repay and settle. Settlement has no dependency on it.",
  ],
  [
    "Withdrawals never freeze",
    "New lending can be paused. Repayment, settlement and lender withdrawals cannot be, ever.",
  ],
];

export default function ProtocolPage() {
  return (
    <Page>
      <Navigation />

      <PageHeader
        title={
          <>
            Three legs, <span className="text-primary">deliberately separate.</span>
          </>
        }
        lede="An aval is a trade finance instrument: a third party's written guarantee on a bill of exchange. That is the mechanism here. The AI does not just score the credit, it guarantees it with its own capital."
      />

      <Section>
        <SectionTitle sub="A prediction, collateral behind it, and an outcome that pays or punishes.">
          How a loan works
        </SectionTitle>
        <div className="grid md:grid-cols-3 gap-5">
          {steps.map((s) => (
            <Card key={s.step} step={s.step} title={s.title}>
              {s.body}
            </Card>
          ))}
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle>The three mechanisms</SectionTitle>

        <div className="grid gap-12 md:grid-cols-3">
          <div>
            <h3 className="font-display text-xl font-semibold mb-4">Solvency</h3>
            <p className="text-muted-foreground leading-[1.75] text-[15px] mb-4">
              The underwriter locks a fixed share of principal per loan. On default it is slashed
              into the lending pool, so lenders wear only the shortfall beyond it.
            </p>
            <p className="text-muted-foreground/70 leading-[1.75] text-sm">
              The bond is deliberately not scaled by the model&rsquo;s own estimate. If a lower
              declared risk meant posting less collateral, understating risk would be profitable.
            </p>
          </div>

          <div>
            <h3 className="font-display text-xl font-semibold mb-4">Honesty</h3>
            <p className="text-muted-foreground leading-[1.75] text-[15px] mb-4">
              The fee follows the Brier rule,{" "}
              <span className="font-mono text-foreground/80">S(p, o) = 1 − (p − o)²</span>. Expected
              fee is uniquely maximised by reporting true belief.
            </p>
            <p className="text-muted-foreground/70 leading-[1.75] text-sm">
              Honest calibration becomes a dominant strategy, which is a mathematical property
              rather than a policy anyone has to police. Forfeited fees accrue to lenders.
            </p>
          </div>

          <div>
            <h3 className="font-display text-xl font-semibold mb-4">Reputation</h3>
            <p className="text-muted-foreground leading-[1.75] text-[15px] mb-4">
              Every prediction and realised outcome is recorded, with a running accuracy score per
              underwriter. Public, comparable, and impossible to fake.
            </p>
            <p className="text-muted-foreground/70 leading-[1.75] text-sm">
              A good score can only be earned by making bonded predictions that came true.
            </p>
          </div>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle sub={`An illustration, not a real loan. Every figure below is computed from the contract's own arithmetic. The AI declared a ${ex.declaredPd} chance of default on a ${ex.lossWithoutCollateral} USDT loan, and the borrower defaulted.`}>
          What it costs to be wrong
        </SectionTitle>

        <div className="grid md:grid-cols-2 gap-10 md:gap-16">
          <div>
            <div className="text-[13px] text-muted-foreground pb-2 mb-5 border-b border-border">
              The AI operator
            </div>
            {/*
              Four rows, and only one of them is money that actually moved. Colouring the other
              three as well flattens the table into decoration and leaves the eye nowhere to
              land, so the fee row is set plain and lets its own smaller number make the point.
            */}
            <DataRows
              rows={[
                ["Collateral staked", ex.collateral],
                ["Collateral taken", ex.collateralTaken, "text-destructive"],
                ["Fee it could have earned", ex.feeBase, "text-muted-foreground"],
                ["Fee it actually keeps", ex.feeKept],
              ]}
            />
          </div>
          <div>
            <div className="text-[13px] text-muted-foreground pb-2 mb-5 border-b border-border">
              The lenders
            </div>
            <DataRows
              rows={[
                ["Money at risk", ex.lossWithoutCollateral, "text-muted-foreground"],
                ["Covered by the AI", ex.coveredByAi],
                ["Actual loss", ex.lenderLoss, "text-destructive"],
                ["Loss with no AI collateral", ex.lossWithoutCollateral, "text-muted-foreground"],
              ]}
            />
          </div>
        </div>

        <div className="mt-12 max-w-3xl mx-auto">
          <Note>
            <span className="text-foreground font-medium">Here is the part that matters.</span> Had
            it declared {ex.honestPd} instead, an honest read of a risky loan, it would have kept{" "}
            {ex.feeIfHonest} on the exact same default, roughly five times what it actually kept.
            The fee rewards accuracy, not optimism. It cannot win business by calling everything
            safe, and it cannot call everything risky either or nobody borrows from it.
          </Note>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle>Safeguards</SectionTitle>

        <div className="grid md:grid-cols-2 gap-x-16 gap-y-10 mb-12">
          {safeguards.map(([title, body]) => (
            <div key={title}>
              <h3 className="font-medium mb-2.5">{title}</h3>
              <p className="text-muted-foreground leading-[1.75] text-[15px]">{body}</p>
            </div>
          ))}
        </div>

        <div className="max-w-3xl mx-auto">
          <Note tone="caveat">
            <span className="text-foreground font-medium">These contracts are unaudited.</span>
            <br />
            <br />
            Static analysis found {SLITHER.high} high, {SLITHER.medium} medium and {SLITHER.low} low
            severity issues across {SLITHER.contractsAnalysed} contracts. We also reviewed the code
            ourselves, found {PUBLISHED_FINDINGS} problems including one critical, fixed them, and
            published every one in full.
            <br />
            <br />
            None of that is a professional audit. Keep amounts small.
          </Note>
        </div>
      </Section>

      <Container className="pb-24">
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/model"
            className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            How the model works
          </Link>
          <Link
            href="/app"
            className="rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium transition-all hover:bg-surface-2"
          >
            See live loans
          </Link>
        </div>
      </Container>

      <FooterSection />
    </Page>
  );
}
