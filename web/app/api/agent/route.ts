import { AGENT_MANIFEST } from "@/lib/agent-manifest";

/**
 * GET /api/agent
 *
 * The machine-readable entry point to Aval. An autonomous agent fetches this to learn the
 * chain, the contract addresses, the attestation schema and the exact economic constraints
 * it must satisfy, without reading the repository or scraping a page.
 *
 * Read-only and unauthenticated, because it describes public contracts and grants nothing.
 * Every capability it lists is a call the agent makes itself with its own signer.
 *
 * CORS is wide open on purpose. A discovery document that a browser-based agent cannot fetch
 * has failed at the one job it has.
 */

export const dynamic = "force-static";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  /**
   * One hour. The manifest is derived from source constants and changes only on redeploy,
   * but the policy values it describes are owner-adjustable onchain, so it should not be
   * cached indefinitely. Every one of them carries the getter that returns the truth.
   */
  "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
};

export async function GET() {
  return new Response(JSON.stringify(AGENT_MANIFEST, null, 2), { headers: HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}
