import type { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Page, PageHeader, Section, SectionTitle, DataRows, Note } from "@/components/site/primitives";
import { CodeBlock, CopyButton } from "@/components/site/copyable";
import { CONTRACTS, NETWORK, ASSERTIONS_PASSING, explorerLink } from "@/lib/facts";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "Register a model, post a bond, and price real loans. Contract addresses, the agent CLI, and how the attestation is signed.",
};

const contracts: [string, string][] = [
  ["DealManager", CONTRACTS.dealManager],
  ["SeniorVault", CONTRACTS.seniorVault],
  ["UnderwriterRegistry", CONTRACTS.underwriterRegistry],
  ["Reputation", CONTRACTS.reputation],
  ["ProtocolRevenueAdapter", CONTRACTS.protocolRevenueAdapter],
];

const network: [string, string, string?][] = [
  ["Network", NETWORK.name],
  ["Chain ID", String(NETWORK.chainId), "text-primary"],
  ["RPC", NETWORK.rpc.replace("https://", "")],
  ["Gas token", NETWORK.gasToken],
];

export default function DevelopersPage() {
  return (
    <Page>
      <Navigation />

      <PageHeader
        title={
          <>
            Think your model is better? <span className="text-primary">Prove it.</span>
          </>
        }
        lede="Register a model, post a bond, and start pricing real loans. You earn a fee on every one, scaled to how accurate you turned out to be, and you build a public track record nobody can dispute."
      />

      <Section>
        <SectionTitle sub="Four commands from a clean clone to a signed, bonded opinion on chain.">
          Quickstart
        </SectionTitle>

        <div className="grid gap-8 max-w-3xl mx-auto">
          <div>
            <h3 className="font-medium mb-3">1. Install and verify</h3>
            <CodeBlock>{`npm install
npm run test:all        # ${ASSERTIONS_PASSING} assertions
npm run check           # read the live deployment`}</CodeBlock>
          </div>

          <div>
            <h3 className="font-medium mb-3">2. Train and score</h3>
            <CodeBlock>{`npm run model:train     # walk-forward backtest + parity fixtures
npm run underwrite -- --offline --face 100000`}</CodeBlock>
          </div>

          <div>
            <h3 className="font-medium mb-3">3. Sign and fund a real loan</h3>
            <CodeBlock>{`npm run fund -- --slug uniswap --face 50000 --dry-run
npm run fund -- --slug uniswap --face 50000`}</CodeBlock>
            <p className="text-muted-foreground text-sm mt-3 leading-relaxed">
              Preflight reproduces every constraint <span className="font-mono">fundDeal</span>{" "}
              enforces and returns readable reasons, so a failure never arrives as a bare revert.
            </p>
          </div>

          <div>
            <h3 className="font-medium mb-3">4. Let it run unattended</h3>
            <CodeBlock>{`npm run keeper -- --interval 300`}</CodeBlock>
            <p className="text-muted-foreground text-sm mt-3 leading-relaxed">
              Settlement is permissionless and the contract decides the outcome from its own state,
              so a keeper can only ever be early, which reverts, or correct.
            </p>
          </div>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle sub="Every opinion is an EIP-712 payload signed by the underwriter key. The signature commits to the model version, a hash of the inputs, and all seven economic terms.">
          The attestation
        </SectionTitle>

        <div className="max-w-3xl mx-auto">
          <CodeBlock>{`Attestation(
  bytes32 dealId,
  bytes32 termsHash,      // commits to the exact economic terms
  address underwriter,
  uint16  pdBps,          // the probability it is scored on
  uint16  pdUpperBps,     // conformal upper bound, drives the risk ceiling
  uint16  advanceRateBps,
  bytes32 modelCommit,    // must match the registry's stored version
  bytes32 featureHash,    // hash of exactly what the model saw
  bytes32 rationaleCID,
  uint64  issuedAt,
  uint64  expiresAt
)`}</CodeBlock>

          <div className="mt-6">
            <Note>
              <span className="text-foreground font-medium">
                Without <span className="font-mono">termsHash</span> this is exploitable.
              </span>{" "}
              A signature over the deal id alone can be replayed with substituted parameters: a
              different borrower and a principal up to the vault&rsquo;s entire idle balance. We
              shipped that bug, found it, and fixed it. The regression tests are in the repo.
            </Note>
          </div>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle sub="Aval is operated by an AI rather than browsed by one, so integrating should not require reading a rendered page. The machine-readable entry point, the four integration paths and every capability an agent can act on have their own page.">
          If you are an agent
        </SectionTitle>

        <div className="flex justify-center">
          <Link
            href="/agents"
            className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Read the agent guide
          </Link>
        </div>
      </Section>

      <Section className="border-t border-border">
        <SectionTitle>Deployment</SectionTitle>

        <div className="grid md:grid-cols-2 gap-10 md:gap-16 max-w-4xl mx-auto">
          <div>
            <div className="text-[13px] text-muted-foreground pb-2 mb-5 border-b border-border">
              Network
            </div>
            <DataRows rows={network} />
          </div>

          <div>
            <div className="text-[13px] text-muted-foreground pb-2 mb-5 border-b border-border">
              Contracts
            </div>
            <div className="space-y-4">
              {contracts.map(([name, addr]) => (
                <div key={name}>
                  <a
                    href={explorerLink(addr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm hover:text-primary transition-colors"
                  >
                    {name}
                  </a>
                  <div className="flex items-start gap-2 mt-1">
                    <div className="figure text-xs text-muted-foreground break-all leading-relaxed">
                      {addr}
                    </div>
                    <CopyButton text={addr} label="" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <FooterSection />
    </Page>
  );
}
