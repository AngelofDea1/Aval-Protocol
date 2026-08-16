import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { Page, PageHeader, Section, SectionTitle } from "@/components/site/primitives";
import { CodeBlock } from "@/components/site/copyable";
import { AGENT_MANIFEST } from "@/lib/agent-manifest";

export const metadata: Metadata = {
  title: "Agent Manifest",
  description: "The machine-readable entry point to Aval Protocol.",
};

export default function AgentManifestPage() {
  return (
    <Page>
      <Navigation />

      <PageHeader
        title={
          <>
            Agent <span className="text-primary">Manifest</span>
          </>
        }
        lede="This is the exact JSON payload served at /api/agent. It defines the chain, the contract addresses, the EIP-712 schema, and every capability an agent can act on."
      />

      <Section>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-foreground">manifest.json</h2>
            <div className="text-sm text-muted-foreground font-mono bg-surface-2 px-2.5 py-1 rounded border border-border">
              /api/agent
            </div>
          </div>
          
          <CodeBlock>
            {JSON.stringify(AGENT_MANIFEST, null, 2)}
          </CodeBlock>
        </div>
      </Section>

      <FooterSection />
    </Page>
  );
}
