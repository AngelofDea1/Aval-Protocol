import { ImageResponse } from "next/og";
import { FIRST_LOSS_BPS } from "@/lib/facts";

/**
 * The preview card shown when the site is shared on X, Slack, Discord or anywhere else.
 *
 * Without this a shared link renders as a grey box with a URL under it, which is the most
 * visible way a serious project looks unfinished. Generated rather than designed, so it
 * cannot go stale: the collateral figure comes from the same source as every other number.
 *
 * SATORI RULES, LEARNED THE HARD WAY
 *
 * next/og renders with Satori, not a browser, and it throws rather than guessing:
 *
 *   "Expected <div> to have explicit display: flex ... if it has more than one child node"
 *
 * A JSX expression counts as its own child. So `<div>Text {value} more text</div>` is three
 * children, not one string, and fails the build. Every string below is therefore assembled in
 * JavaScript first and passed as a single child, and every container states its display.
 */

export const alt = "Aval Protocol: the AI pays when it is wrong";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Built here, not interpolated into JSX, so each element receives exactly one text child.
  const subtitle =
    `Lending where the AI underwriter stakes ${FIRST_LOSS_BPS / 100}% of every loan it prices, ` +
    `is slashed when wrong, and has its accuracy recorded onchain.`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0d0d0d",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: "#f5a524" }} />
          <div style={{ display: "flex", fontSize: 26, color: "#a3a3a3", letterSpacing: 2, marginLeft: 16 }}>
            AVAL PROTOCOL
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 92, color: "#fafafa", letterSpacing: -3 }}>
            The AI pays
          </div>
          <div style={{ display: "flex", fontSize: 92, color: "#f5a524", letterSpacing: -3, marginTop: 4 }}>
            when it is wrong.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: "#a3a3a3",
              marginTop: 36,
              maxWidth: 920,
              lineHeight: 1.45,
            }}
          >
            {subtitle}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#737373" }}>
          <div style={{ display: "flex" }}>Built on X Layer</div>
          <div style={{ display: "flex" }}>aval-protocol.vercel.app</div>
        </div>
      </div>
    ),
    size
  );
}
