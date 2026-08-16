import type { MetadataRoute } from "next";

/**
 * robots.txt is the first thing most crawlers and many agents fetch, which makes it the
 * cheapest place to advertise the machine-readable entry point.
 *
 * Everything here is public: public contracts, published security findings, and a protocol
 * whose entire argument is that its record can be checked by anyone. There is nothing to
 * disallow, and pretending otherwise would contradict the product.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    // Absolute URLs are required here, so they are derived from the deployment origin.
    sitemap: `${origin()}/sitemap.xml`,
    host: origin(),
  };
}

/**
 * Vercel sets VERCEL_URL without a scheme. NEXT_PUBLIC_SITE_URL wins if set, so a custom
 * domain does not require a code change.
 */
function origin(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
