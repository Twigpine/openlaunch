import { ImageResponse } from "next/og";
import { loadOgFonts } from "@/lib/ogFonts";
import { getLaunchTotals } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { fmtUsd } from "@/lib/launchpad/math";
import { BRAND, BRAND_TLD, SITE_TITLE } from "@/lib/brand";

export const alt = SITE_TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const PAPER = "#FAFAF8";
const INK = "#0F172A";
const BODY = "#475569";
const MUTED = "#64748B";
const LINE = "#E7E5E4";
const BLUE = "#0052FF";
const UP = "#15803D";

function MarkSvg({ size: s }: { size: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill={BLUE} />
      <path fill="#FFFFFF" fillRule="evenodd" d="M10.5 13a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13ZM10.5 16.4a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 1 0 0-6.2Z" />
      <rect x="19.5" y="6" width="4.6" height="20" rx="1.4" fill="#FFFFFF" />
      <rect x="19.5" y="21.4" width="8.2" height="4.6" rx="1.4" fill="#FFFFFF" />
    </svg>
  );
}

export default async function OgImage() {
  const usd = await ethUsd();
  const [totals, fonts] = await Promise.all([getLaunchTotals(usd).catch(() => null), loadOgFonts()]);
  const stat = totals && totals.launches > 0 ? `${totals.launches} launches · ${fmtUsd(totals.volume_usd, { compact: true })} traded · $0 in fees, ever` : "no platform fee, ever";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: PAPER, display: "flex", flexDirection: "column", fontFamily: "Geist, sans-serif", position: "relative", overflow: "hidden", color: INK }}>
        <div style={{ position: "absolute", top: -320, left: -120, width: 900, height: 640, borderRadius: "50%", background: "radial-gradient(closest-side, #EAF0FF 0%, rgba(234,240,255,0) 100%)" }} />
        <div style={{ position: "absolute", right: -140, bottom: -260, width: 620, height: 620, borderRadius: "50%", border: `18px solid ${LINE}`, opacity: 0.7 }} />

        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "40px 64px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <MarkSvg size={46} />
            <span style={{ fontSize: 30, fontWeight: 700, display: "flex", letterSpacing: -0.5 }}>
              {BRAND}
              <span style={{ color: BLUE }}>{BRAND_TLD}</span>
            </span>
          </div>
          <span style={{ fontSize: 18, color: MUTED, fontFamily: "Geist, sans-serif" }}>{stat}</span>
        </div>

        {/* headline */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 64px" }}>
          <div style={{ fontFamily: "Geist, sans-serif", fontWeight: 700, fontSize: 86, lineHeight: 1.0, letterSpacing: -3, display: "flex", flexDirection: "column" }}>
            <span style={{ display: "flex" }}>
              Launch a token.&nbsp;<span style={{ color: BLUE }}>Free.</span>
            </span>
          </div>
          <div style={{ marginTop: 22, fontSize: 30, color: BODY, display: "flex", alignItems: "center", gap: 14, fontWeight: 500 }}>
            <span>Open source</span>
            <span style={{ color: LINE }}>·</span>
            <span>Base</span>
            <span style={{ color: LINE }}>·</span>
            <span>Robinhood Chain</span>
            <span style={{ color: LINE }}>·</span>
            <span>Arc</span>
          </div>
          <span style={{ marginTop: 18, fontSize: 24, color: MUTED, maxWidth: 880, lineHeight: 1.4 }}>
            One transaction deploys your token and locks 100% of supply as Uniswap v4 liquidity forever. Nobody can pull it. We take nothing.
          </span>
        </div>

        {/* chips */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 64px 44px" }}>
          <div style={{ display: "flex", gap: 12 }}>
            {[
              ["0% platform fee", UP, "#ECFDF3", "#bbf7d0"],
              ["liquidity locked forever", BODY, "#fff", LINE],
              ["no owner, no admin", BODY, "#fff", LINE],
            ].map(([t, c, bg, b]) => (
              <span key={t} style={{ display: "flex", alignItems: "center", height: 42, padding: "0 18px", borderRadius: 999, border: `1px solid ${b}`, background: bg, color: c, fontSize: 19, fontWeight: 600, whiteSpace: "nowrap" }}>
                {t}
              </span>
            ))}
          </div>
          {/* call to action */}
          <span style={{ display: "flex", alignItems: "center", height: 52, padding: "0 26px", borderRadius: 999, background: BLUE, color: "#fff", fontSize: 22, fontWeight: 700, whiteSpace: "nowrap" }}>
            Launch a token →
          </span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
