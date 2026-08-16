import { AGENT_MANIFEST as M } from "@/lib/agent-manifest";

/**
 * GET /llms.txt
 *
 * The prose counterpart to /api/agent, following the llms.txt convention: a short, structured
 * document at a well-known path that a language model can read without parsing a rendered page.
 *
 * Generated from the same manifest rather than written by hand. A hand-written version would
 * drift from the JSON within a week, and two documents disagreeing about the first-loss
 * percentage is worse than having only one.
 */

export const dynamic = "force-static";

function render(): string {
  const p = M.policy;
  const usdt = M.contracts.asset;

  return `# Aval Protocol

> ${M.protocol.summary}

${M.protocol.agentRole}

Interface: ${M.protocol.interface}

Full machine-readable manifest, including the ABI signatures and every precondition: /api/agent

It is also served at /.well-known/agent-manifest, and advertised in the Link header of every
response from this site, so it can be found without parsing any HTML.

## Start here

${M.startHere.readThisFirst}

${Object.entries(M.startHere.roles)
  .map(
    ([role, r]) =>
      `### If you want to ${role}\n\n${r.goal}\n\n` +
      r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
      ("warning" in r ? `\n\nWarning: ${r.warning}` : "")
  )
  .join("\n\n")}

## Network

- ${M.network.name}, chain ID ${M.network.chainId}
- RPC: ${M.network.rpc}
- Gas token: ${M.network.gasToken}
- ${M.network.note}

## Contracts

- DealManager: ${M.contracts.dealManager}
- SeniorVault: ${M.contracts.seniorVault}
- UnderwriterRegistry: ${M.contracts.underwriterRegistry}
- Reputation: ${M.contracts.reputation}
- ProtocolRevenueAdapter: ${M.contracts.protocolRevenueAdapter}
- Asset: ${usdt.address} (${usdt.decimals} decimals, not 18)

Indexing starts at block ${M.contracts.deployBlock}.

## How the mechanism works

An underwriter registers a model, posts a bond, and signs an EIP-712 credit opinion stating
one number: the probability a loan is not repaid.

Collateral: ${M.incentives.collateral.rule} ${M.incentives.collateral.whyNotRiskScaled}

Fee: ${M.incentives.scoringRule.feeFormula}

${M.incentives.scoringRule.property}

${M.incentives.scoringRule.implication}

On default: ${M.incentives.onDefault}

## Constraints that will reject a deal

- First-loss bond required: ${p.firstLossBps.value / 100}% of principal (${p.firstLossBps.verifyWith})
- Maximum conformal upper bound on PD: ${p.maxPdUpperBps.value / 100}% (${p.maxPdUpperBps.verifyWith})
- Minimum principal: ${p.minPrincipal.value / 10 ** usdt.decimals}.00 of the asset, ie ${p.minPrincipal.value} in smallest units (${p.minPrincipal.verifyWith})
- Maximum term: ${p.maxTermSeconds.value / 86400} days (${p.maxTermSeconds.verifyWith})
- Maximum grace period: ${p.maxGraceSeconds.value / 86400} days (${p.maxGraceSeconds.verifyWith})
- Vault utilisation cap: ${p.maxUtilizationBps.value / 100}% (${p.maxUtilizationBps.verifyWith})
- Bond withdrawal cooldown: ${p.bondWithdrawCooldownSeconds.value / 86400} days (${p.bondWithdrawCooldownSeconds.verifyWith})

These are the deployed values. All of them are owner-adjustable, so verify with the call named
in brackets rather than trusting this file.

## Signing

EIP-712 domain: name "${M.attestation.domain.name}", version "${M.attestation.domain.version}",
chainId ${M.attestation.domain.chainId}, verifyingContract ${M.attestation.domain.verifyingContract}.

Type fields, in order:

${M.attestation.types.Attestation.map((f) => `  ${f.type} ${f.name}`).join("\n")}

${M.attestation.fieldOrderWarning}

termsHash = ${M.attestation.termsHash.computation}

Why it exists: ${M.attestation.termsHash.whyItExists}

Reference implementation: ${M.attestation.referenceImplementation}

## Live state

${M.liveState.principle}

${M.liveState.indexingHint}

## What is verifiable

- ${M.verification.assertionsPassing.value} assertions passing (${M.verification.assertionsPassing.reproduce}). ${M.verification.assertionsPassing.note}
- ${M.verification.foundryTests.value} Foundry tests (${M.verification.foundryTests.reproduce})
- Slither across ${M.verification.staticAnalysis.contractsAnalysed} contracts: ${M.verification.staticAnalysis.high} high, ${M.verification.staticAnalysis.medium} medium, ${M.verification.staticAnalysis.low} low
- ${M.verification.publishedFindings.value} security findings published in full in ${M.verification.publishedFindings.where}
- Confirm the deployment matches: ${M.verification.checkDeployment}

## Stated limitations

${M.model.honestLimitation}

${M.model.substitutable}

${M.status.warning}

Mainnet deployed: ${M.status.mainnet ? "yes" : "no"}. Audited: ${M.status.audited ? "yes" : "no"}.

## Pages

- /protocol: the mechanism, with a worked example computed from the contract's own arithmetic
- /model: the three model stages and the walk-forward results
- /developers: quickstart, attestation schema, contract addresses
- /app: live protocol state read directly from chain
- /api/agent: this document as structured JSON
`;
}

const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
};

export async function GET() {
  return new Response(render(), { headers: HEADERS });
}
