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
import { MODEL, PARITY_ASSERTIONS } from "@/lib/facts";

export const metadata: Metadata = {
  title: "The model",
  description:
    "Logistic regression, a bounded language-model overlay, and Venn-Abers calibration. Three stages, each bounded by the next.",
};

export default function ModelPage() {
  return (
    <Page>
      <Navigation />

      <PageHeader
        title={
          <>
            Three stages, each <span className="text-primary">bounded by the next.</span>
          </>
        }
        lede="Built so that no single stage can originate a loan the others would refuse. Training runs in Python, inference runs in JavaScript, and the two are pinned to each other by assertion."
      />

      <Section>
        <div className="grid md:grid-cols-3 gap-5">
          <Card step="01" title="Structural">
            Logistic regression over eight cashflow features: coverage, trend, volatility, drawdown,
            concentration, scale, obligor age and momentum. Seven carry weight. Drawdown fits to
            exactly zero here, which we report rather than quietly drop, because a feature the model
            ignores is a fact about the model. Gradient boosting was trained alongside and lost
            out-of-time, so the linear model ships.
          </Card>
          <Card step="02" title="Qualitative overlay">
            A language model reads unstructured context and returns an adjustment with written
            reasoning, clamped offchain to ±30% of the base probability. The contract enforces its
            own separate ceiling. If the model fails, underwriting proceeds structurally and the
            skip is recorded.
          </Card>
          <Card step="03" title="Calibration">
            A Venn-Abers probability interval, valid under exchangeability alone with no assumption
            that the model is well specified. The upper edge drives the risk ceiling, so uncertainty
            tightens underwriting rather than being discarded.
          </Card>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle sub="Evaluated walk-forward by decision time. Random k-fold on time-series data leaks the future into the past and produces flattering, meaningless numbers.">
          Measured, not asserted
        </SectionTitle>

        <div className="max-w-2xl mx-auto">
          <DataRows
            rows={[
              ["Walk-forward score, logistic", MODEL.brierLogistic.toFixed(4), "text-primary"],
              ["Walk-forward score, gradient boosting", MODEL.brierGradientBoosting.toFixed(4)],
              [
                "A constant predictor would score",
                MODEL.brierConstantPredictor.toFixed(4),
                "text-muted-foreground",
              ],
              ["Held-out AUC", MODEL.heldOutAuc.toFixed(3)],
              ["Mean calibration interval width", MODEL.meanIntervalWidth.toFixed(3)],
            ]}
          />
          <p className="text-muted-foreground/70 text-sm mt-5 leading-[1.75]">
            Lower is better on the first three. Beating the constant predictor is the bar that
            matters; a model that cannot is worse than guessing the average.
          </p>
        </div>

        <div className="mt-12 max-w-3xl mx-auto">
          <Note tone="caveat">
            <span className="text-foreground font-medium">Stated plainly.</span> The model is v0,
            trained on a {MODEL.trainedOn}. {MODEL.brierLogistic.toFixed(3)} against a{" "}
            {MODEL.baseRate.toFixed(3)} base rate is real signal, and it is modest.
            <br />
            <br />
            It has never seen a real default. This is not a claim about real-world accuracy, and the
            contribution here is the mechanism rather than the model.
          </Note>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle sub="Training happens in Python and inference in JavaScript. Nothing at runtime would catch a divergence, because a drifted feature still produces a plausible number, which then gets signed, bonded and acted on.">
          Why the parity tests exist
        </SectionTitle>

        <div className="grid md:grid-cols-2 gap-12 max-w-4xl mx-auto">
          <div>
            <h3 className="font-medium mb-2.5">
              {PARITY_ASSERTIONS} assertions at 1e-9 tolerance
            </h3>
            <p className="text-muted-foreground leading-[1.75] text-[15px]">
              Every feature and every calibration output is compared between the two
              implementations, including degenerate inputs such as empty and flat revenue series.
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-2.5">The artifact is version-checked</h3>
            <p className="text-muted-foreground leading-[1.75] text-[15px]">
              Loading a model whose feature order disagrees with the code throws immediately. That
              catches the worst case, which is coefficients silently applied to the wrong features.
            </p>
          </div>
        </div>
      </Section>

      <Container className="pb-24">
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/developers"
            className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Run your own model
          </Link>
          <Link
            href="/app?tab=models"
            className="rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium transition-all hover:bg-surface-2"
          >
            See the leaderboard
          </Link>
        </div>
      </Container>

      <FooterSection />
    </Page>
  );
}
