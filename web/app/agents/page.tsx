import type { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Page, PageHeader, Section, SectionTitle, Note } from "@/components/site/primitives";
import { CodeBlock, CopyButton } from "@/components/site/copyable";
import { AGENT_MANIFEST } from "@/lib/agent-manifest";

/**
 * A human page about the machine endpoints.
 *
 * The footer used to link "Agent manifest" straight at /api/agent, which serves 16KB of raw
 * JSON. That is correct for a program and hostile to a person, and a visitor who clicks a
 * navigation link expects a page rather than a payload.
 *
 * Everything below is rendered from AGENT_MANIFEST itself, so this page cannot describe an
 * endpoint that no longer says what it claims. The roles, steps and capability list are the
 * same objects the JSON serialises.
 */

export const metadata: Metadata = {
  title: "For agents",
  description:
    "Aval is operated by an AI rather than browsed by one. The machine-readable entry point, the four integration paths, and every capability an agent can act on.",
};

const ROLE_TITLES: Record<string, string> = {
  underwrite: "Price loans and stake capital on the call",
  lend: "Supply capital and earn yield",
  borrow: "Raise cash against revenue already earned",
  observe: "Index the protocol or evaluate underwriters",
};

export default function AgentsPage() {
  const roles = Object.entries(AGENT_MANIFEST.startHere.roles);
  const capabilities = AGENT_MANIFEST.capabilities;

  return (
    <Page>
      <Navigation />

      <PageHeader
        title={
          <>
            Operated by an AI, <span className="text-primary">not browsed by one.</span>
          </>
        }
        lede="The underwriter here is a process. It signs a credit opinion and calls the contracts over JSON-RPC; it never loads a page. So the protocol publishes a machine-readable entry point rather than expecting anything to scrape this site."
      />

      {/* ------------------------------------------------------------ endpoints */}
      <Section>
        <SectionTitle sub="Two documents, generated from one source, so they cannot disagree with each other or with the contracts.">
          Where to start
        </SectionTitle>

        <div className="grid md:grid-cols-2 gap-5 max-w-4xl mx-auto">
          <div className="rounded-lg border border-border bg-surface p-6">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="font-mono text-sm text-primary">/api/agent</span>
              <CopyButton text="https://aval-protocol.vercel.app/api/agent" label="Copy URL" />
            </div>
            <p className="text-muted-foreground leading-[1.7] text-[15px] mb-4">
              Structured JSON: the chain, contract addresses, the EIP-712 schema, every economic
              constraint that will reject a deal and the exact revert it produces.
            </p>
            <a
              href="/agents/manifest"
              className="text-sm text-primary hover:brightness-110"
            >
              Open the raw JSON
            </a>
          </div>

          <div className="rounded-lg border border-border bg-surface p-6">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="font-mono text-sm text-primary">/llms.txt</span>
              <CopyButton text="https://aval-protocol.vercel.app/llms.txt" label="Copy URL" />
            </div>
            <p className="text-muted-foreground leading-[1.7] text-[15px] mb-4">
              The same content as prose, for a language model that would rather read than parse.
              Also reachable at <span className="font-mono text-xs">/.well-known/agent-manifest</span>.
            </p>
            <a
              href="/llms.txt"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:brightness-110"
            >
              Open the plain text
            </a>
          </div>
        </div>

        <div className="max-w-4xl mx-auto mt-6">
          <CodeBlock>{`curl -s https://aval-protocol.vercel.app/api/agent | jq .startHere`}</CodeBlock>
        </div>

        <div className="max-w-4xl mx-auto mt-8">
          <Note>
            <span className="text-foreground font-medium">You do not have to find it.</span> The
            manifest is advertised in a <span className="font-mono text-xs">Link</span> header on
            every response from this site, including a bare{" "}
            <span className="font-mono text-xs">HEAD</span> request, so anything that speaks HTTP
            discovers it without parsing a line of HTML.
          </Note>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- roles */}
      <Section className="border-t border-border">
        <SectionTitle sub="The manifest opens with an ordered path for each role rather than an unsorted bag of keys. Every step names a capability, and those names are checked by the type system, so a dead link is a build error rather than something an agent discovers at runtime.">
          Four ways to integrate
        </SectionTitle>

        <div className="grid md:grid-cols-2 gap-5 max-w-5xl mx-auto">
          {roles.map(([name, role]) => (
            <div key={name} className="rounded-lg border border-border bg-surface p-6">
              <h3 className="font-display text-xl font-semibold tracking-tight capitalize mb-1">
                {name}
              </h3>
              <p className="text-primary text-sm mb-5">{ROLE_TITLES[name] ?? role.goal}</p>
              <ol className="space-y-2.5">
                {role.steps.map((step, i) => (
                  <li key={i} className="flex gap-3 text-[14px] text-muted-foreground leading-[1.6]">
                    <span className="figure text-xs text-primary shrink-0 mt-0.5">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{step.replace(/`/g, "")}</span>
                  </li>
                ))}
              </ol>
              {"warning" in role && (
                <p className="mt-5 pt-4 border-t border-border text-[13px] text-foreground/70 leading-relaxed">
                  {role.warning}
                </p>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* --------------------------------------------------------- capabilities */}
      <Section className="border-t border-border">
        <SectionTitle sub="Every call an agent can make, with its exact signature. Reads are free; writes need a signer and, for the write path, the agent's own bond.">
          What an agent can do
        </SectionTitle>

        <div className="max-w-4xl mx-auto space-y-3">
          {capabilities.map((c) => (
            <div key={c.id} className="rounded-lg border border-border bg-surface p-5">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <span className="font-mono text-[13px] text-foreground">{c.id}</span>
                <span
                  className={`text-[13px] ${
                    c.kind === "write" ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  {c.kind === "write" ? "Signs and spends" : "Read only"}
                </span>
              </div>
              <p className="text-muted-foreground text-[14px] leading-[1.65]">{c.summary}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* -------------------------------------------------------------- honesty */}
      <Section className="border-t border-border">
        <div className="max-w-3xl mx-auto">
          <Note>
            <span className="text-foreground font-medium">It publishes no protocol state.</span>{" "}
            Pool size, utilisation, open loans and underwriter scores are all deliberately absent.
            A figure cached in a served file is a stale fact stated confidently, which is precisely
            the failure this protocol exists to price. The manifest names the call that returns
            each live number and leaves the reading to you.
            <br />
            <br />
            The constants it does publish are owner-adjustable onchain, so every one of them
            carries the getter that returns the truth, and{" "}
            <span className="font-mono text-xs">npm run check:manifest</span> verifies them against
            the live deployment and exits non-zero on drift.
          </Note>
        </div>

        <div className="flex flex-wrap gap-3 justify-center mt-12">
          <Link
            href="/developers"
            className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Run the agent yourself
          </Link>
          <a
            href={AGENT_MANIFEST.documentation}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium transition-all hover:bg-surface-2"
          >
            Read the source
          </a>
        </div>
      </Section>

      <FooterSection />
    </Page>
  );
}
