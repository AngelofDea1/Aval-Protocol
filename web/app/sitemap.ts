import type { MetadataRoute } from "next";

/**
 * Every page, enumerated. An agent that wants to understand Aval rather than transact with it
 * can walk this instead of guessing at URLs or following links out of rendered HTML.
 *
 * `/api/agent` and `/llms.txt` are deliberately absent: a sitemap describes pages, and those
 * two are documents about the pages. They are advertised in the Link header on every response
 * and at /.well-known/agent-manifest, which is where a machine should look for them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = origin();
  const now = new Date();

  const pages: [string, number][] = [
    ["", 1.0],
    ["/protocol", 0.9],
    ["/developers", 0.9],
    ["/agents", 0.9],
    ["/model", 0.8],
    ["/app", 0.8],
    ["/terms", 0.3],
    ["/privacy", 0.3],
  ];

  return pages.map(([path, priority]) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority,
  }));
}

function origin(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
