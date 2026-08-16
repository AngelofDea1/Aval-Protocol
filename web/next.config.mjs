import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Agent discovery headers.
 *
 * Every response from this site carries an RFC 8288 Link header naming the machine-readable
 * manifest, so an agent that reads response headers finds it without parsing any HTML. That
 * includes a bare HEAD request against the home page.
 *
 * This lives in config rather than in proxy.ts on purpose. It is a constant, and static
 * headers declared here are applied by the server to every matching route, including
 * prerendered and cached responses that a proxy passthrough does not reliably decorate.
 * proxy.ts is kept for the one genuinely dynamic thing: rewriting the /.well-known path.
 */
const AGENT_MANIFEST_HEADERS = [
  {
    key: 'Link',
    value: [
      '</api/agent>; rel="alternate"; type="application/json"; title="Aval Protocol agent manifest"',
      '</llms.txt>; rel="alternate"; type="text/plain"; title="Aval Protocol for language models"',
    ].join(', '),
  },
  // Blunter signal for anything that does not parse structured Link headers.
  { key: 'X-Agent-Manifest', value: '/api/agent' },
]

/**
 * There is a package-lock.json at the repo root (for the contracts and agent) and another
 * here (for the web app). Next infers a workspace root from lockfiles and picked the repo
 * root, which is wrong: this directory has its own dependencies and its own node_modules.
 *
 * Pinning it silences the warning on every boot and, more importantly, stops Next resolving
 * modules from the wrong tree.
 */
const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Only pin the root locally.
   *
   * Vercel sets `outputFileTracingRoot` to its own build directory, and Next refuses to run
   * with the two pointing at different places:
   *
   *   "Both outputFileTracingRoot and turbopack.root are set, but they must have the same value"
   *
   * The setting exists to stop Next inferring the repo root from the two lockfiles when
   * building on this machine. On Vercel the root directory is already `web`, so there is
   * nothing to disambiguate and nothing to set.
   */
  ...(process.env.VERCEL ? {} : { turbopack: { root: here } }),
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    // ':path*' matches zero or more segments, so this covers '/' as well as every sub-route.
    return [{ source: '/:path*', headers: AGENT_MANIFEST_HEADERS }]
  },
}

export default nextConfig
