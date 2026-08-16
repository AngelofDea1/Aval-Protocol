import type { Metadata } from "next";

/**
 * The app itself is a client component, so it cannot export metadata. Without this layout the
 * browser tab on /app falls back to the site-wide default and every open tab says the same
 * thing, which is a small detail that reads as unfinished the moment anyone has two tabs open.
 */
export const metadata: Metadata = {
  title: "App",
  description:
    "Lend, get priced by the AI, browse every loan the protocol has made, and compare underwriters on their realised accuracy.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}
