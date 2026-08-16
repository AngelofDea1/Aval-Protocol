import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Page, PageHeader, Section, Note } from "@/components/site/primitives";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What this site stores, what it does not, and what is public because it is onchain.",
};

/**
 * Describes what the application actually does. Every claim below is checkable in the source:
 * there is no analytics package, no backend, and the only storage is a localStorage entry
 * holding contract addresses.
 */
export default function PrivacyPage() {
  return (
    <Page>
      <Navigation />

      <PageHeader
        title="Privacy policy"
        lede="Short, because this site collects almost nothing. Last updated 16 August 2026."
      />

      <Section>
        <div className="max-w-2xl mx-auto space-y-12">
          <Note>
            <span className="text-foreground font-medium">The short version.</span> No account, no
            tracking, no analytics, and no database. Your wallet address and your transactions are
            public because they are on a public blockchain, which is true of every blockchain
            application and is not something this site chooses.
          </Note>

          <section>
            <h2 className="font-display text-xl font-semibold mb-4">What we do not collect</h2>
            <p className="text-muted-foreground leading-[1.8] mb-4">
              We do not run analytics, advertising or session-recording software. We do not set
              tracking cookies. We do not ask for your name, email address or any other personal
              information, because there is no account to create.
            </p>
            <p className="text-muted-foreground leading-[1.8] mb-4">
              Everything you see about the protocol, including balances, loans and underwriter
              records, is read straight from the blockchain by your own browser. None of it passes
              through us and none of it is stored.
            </p>
            <p className="text-muted-foreground leading-[1.8]">
              There is one exception, and it is worth stating precisely. When you use{" "}
              <span className="text-foreground">Price it</span> on the Borrow tab, the business
              name and the amount you typed are sent to a small endpoint on this site, which
              fetches that business&rsquo;s public revenue history and runs the credit model. It
              keeps no record of the request, writes nothing to disk, and has no database to write
              to. It exists because the revenue source cannot be called directly from a browser.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold mb-4">
              What is stored in your browser
            </h2>
            <p className="text-muted-foreground leading-[1.8] mb-4">
              One entry in your browser&rsquo;s local storage, holding the contract addresses and
              network endpoint the app is pointed at. It never leaves your device, and clearing your
              browser data removes it.
            </p>
            <p className="text-muted-foreground leading-[1.8]">
              Nothing about your wallet, balances or activity is stored by this site.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold mb-4">What is public anyway</h2>
            <p className="text-muted-foreground leading-[1.8] mb-4">
              Blockchains are public by design. Your wallet address, your deposits, your loans and
              their outcomes are visible to anyone, permanently, and cannot be deleted by us or by
              you. That is a property of the network, not a decision this site made.
            </p>
            <p className="text-muted-foreground leading-[1.8]">
              If you would rather your activity not be linked to you, use an address that is not
              associated with your identity.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold mb-4">Third parties</h2>
            <p className="text-muted-foreground leading-[1.8] mb-4">
              Loading this site fetches a font from Fontshare, and reading blockchain data sends
              requests to a public RPC endpoint. Asking for a price sends a request to DefiLlama
              for that business&rsquo;s public revenue history. All three can see your IP address,
              as any web request can. None of them receives anything else from us.
            </p>
            <p className="text-muted-foreground leading-[1.8]">
              You can point the app at a different RPC endpoint, including your own, from the
              settings inside the app.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold mb-4">Your wallet</h2>
            <p className="text-muted-foreground leading-[1.8]">
              Connecting a wallet shares your public address with this page so it can display your
              balances. It does not give the site access to your funds. Every transaction requires
              your explicit approval in your own wallet, and we never see your private keys.
            </p>
          </section>
        </div>
      </Section>

      <FooterSection />
    </Page>
  );
}
