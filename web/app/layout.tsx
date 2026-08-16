import React from "react";
import type { Metadata } from "next";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Aval Protocol",
    template: "%s · Aval Protocol",
  },
  description:
    "Lending where the AI underwriter stakes its own capital on every decision. Wrong calls cost it real money, and its accuracy is recorded onchain permanently.",
  openGraph: {
    title: "Aval Protocol",
    description: "The AI pays when it is wrong.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/*
          Discovery for autonomous agents. An agent that lands on any page can find the
          machine-readable manifest from the document head without scraping the rendering.
        */}
        <link rel="alternate" type="application/json" href="/api/agent" title="Aval Protocol agent manifest" />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="Aval Protocol for language models" />
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased bg-background text-foreground">{children}</body>
    </html>
  );
}
