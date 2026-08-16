import { NextResponse, type NextRequest } from "next/server";

/**
 * Agent discovery.
 *
 * Formerly middleware.ts. Next 16 renamed the convention to `proxy`, on the reasoning that
 * "middleware" gets confused with the Express sense of the word, while this actually runs at
 * a network boundary in front of the app. Same behaviour, new name.
 *
 * THE PROBLEM THIS SOLVES
 *
 * An agent arriving at Aval lands wherever a link pointed it, usually the home page. Finding
 * the machine-readable manifest from there would otherwise mean fetching HTML, parsing it,
 * and spotting a <link rel="alternate"> in the head. That works only for an agent that
 * already knows to look, and it fails entirely for one that issues a HEAD request or reads
 * the page through a text extractor that discards the head.
 *
 * Three independent paths to the same document, because each one fails for a different
 * caller and no single convention has won:
 *
 *   1. Link header on every response      for anything that speaks HTTP
 *   2. /.well-known/agent-manifest        for anything following RFC 8615
 *   3. /llms.txt and robots.txt           for crawlers and language models
 *
 * Only the second one lives here. The Link header was originally set in this file too, and it
 * did not reach the response: this file runs, as the rewrite below proves, but decorating a
 * `NextResponse.next()` passthrough is not a reliable way to attach a constant header to
 * every route. It belongs in `headers()` in next.config.mjs, which is where it now is.
 *
 * The rule that came out of that: this file is for logic that depends on the request.
 * A constant is configuration.
 */

export function proxy(request: NextRequest) {
  /**
   * RFC 8615 well-known URI. Next's router ignores directories beginning with a dot, so this
   * is served by rewriting rather than by a route file. Rewrite, not redirect: an agent
   * following the convention gets the document on the first request instead of paying for a
   * round trip and having to follow a 3xx.
   */
  return NextResponse.rewrite(new URL("/api/agent", request.url));
}

export const config = {
  /**
   * Scoped to exactly the two paths that need rewriting. This previously ran on every request
   * in order to set a header it was not successfully setting, which is pure overhead on every
   * page load.
   */
  matcher: ["/.well-known/agent-manifest", "/.well-known/agent-manifest.json"],
};
