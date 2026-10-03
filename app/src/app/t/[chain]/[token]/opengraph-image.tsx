import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import { loadOgFonts } from "@/lib/ogFonts";
import { getLaunch } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";
import { shapeCard } from "@/lib/launchpad/ogcard";
import { nowMs } from "@/lib/launchpad/time";
import { isChainKey } from "@/lib/chainPublic";
import { BRAND, BRAND_TLD } from "@/lib/brand";
import { isOwnImageUrl } from "@/lib/launchpad/images";
import { imagePublicBase, readImage } from "@/lib/launchpad/imageStore";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GITLAWB_LOGO_BG, GITLAWB_LOGO_PATH } from "@/lib/launchpad/gitlawb";
import { MUSEWORLD_BLUE, MUSEWORLD_LOGO_PATH } from "@/lib/launchpad/museworld";

/** Brand logos from public/, inlined once per process each (satori needs a data URL or absolute URL). */
const brandLogos = new Map<string, Promise<string | null>>();
function logoDataUrl(publicPath: string): Promise<string | null> {
  let p = brandLogos.get(publicPath);
  if (!p) {
    p = readFile(path.join(process.cwd(), "public", publicPath))
      .then((b) => `data:image/png;base64,${b.toString("base64")}`)
      .catch(() => null);
    brandLogos.set(publicPath, p);
  }
  return p;
}

export const alt = "token on openlaunch.lol";
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
const DOWN = "#DC2626";

/**
 * Per-token share card. Never fetches an arbitrary user-supplied image URL server-side
 * (no SSRF surface). The ONE exception is a logo on our own image bucket — uploaded through
 * /api/launch/image, re-encoded by us, key shape checked by isOwnImageUrl — read from the store
 * and embedded as a PNG data URL. Anything else falls back to the initial on a deterministic gradient tile.
 */
async function ownLogo(url: string | null): Promise<string | null> {
  const base = imagePublicBase();
  if (!isOwnImageUrl(url, base)) return null;
  try {
    // read straight from the store (no HTTP hop) and hand satori a PNG: it cannot decode WebP
    const key = (url as string).slice((base as string).replace(/\/+$/, "").length + 1);
    const buf = await readImage(key);
    if (!buf) return null;
    const png = await sharp(buf).resize(220, 220).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

function hueOf(addr: string): number {
  let h = 0;
  for (let i = 2; i < Math.min(addr.length, 18); i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}

export default async function TokenOg({ params }: { params: Promise<{ chain: string; token: string }> }) {
  const { chain, token } = await params;
  const [usd, fonts] = await Promise.all([ethUsd(), loadOgFonts()]);
  const l = isChainKey(chain) && isAddress(token) ? await memo(`og:${chain}:${token.toLowerCase()}`, 30_000, () => getLaunch(chain, token, usd)) : null;
  const card = l ? shapeCard(l, nowMs()) : null;
  const glLogo = card?.quote?.kind === "gitlawb" ? await logoDataUrl(GITLAWB_LOGO_PATH) : null;
  const mwLogo = card?.quote?.kind === "museworld" ? await logoDataUrl(MUSEWORLD_LOGO_PATH) : null;
  const official = card?.quote?.kind === "museworld";
  const logo = l ? await memo(`og-logo:${chain}:${token.toLowerCase()}`, 60_000, () => ownLogo(l.image_url)) : null;
  const h = hueOf(token);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: PAPER, display: "flex", flexDirection: "column", fontFamily: "Inter, sans-serif", position: "relative", overflow: "hidden", color: INK }}>
        <div style={{ position: "absolute", top: -320, left: -120, width: 900, height: 640, borderRadius: "50%", background: "radial-gradient(closest-side, #EAF0FF 0%, rgba(234,240,255,0) 100%)" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "40px 64px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width={40} height={40} viewBox="0 0 32 32">
              <rect width="32" height="32" rx="7" fill={BLUE} />
              <path fill="#FFFFFF" fillRule="evenodd" d="M10.5 13a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13ZM10.5 16.4a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 1 0 0-6.2Z" />
              <rect x="19.5" y="6" width="4.6" height="20" rx="1.4" fill="#FFFFFF" />
              <rect x="19.5" y="21.4" width="8.2" height="4.6" rx="1.4" fill="#FFFFFF" />
            </svg>
            <span style={{ fontSize: 26, fontWeight: 700, display: "flex" }}>
              {BRAND}
              <span style={{ color: BLUE }}>{BRAND_TLD}</span>
            </span>
          </div>
          {card ? (
            <span style={{ display: "flex", alignItems: "center", height: 40, padding: "0 16px", borderRadius: 999, border: `1px solid ${LINE}`, background: "#fff", color: BODY, fontSize: 20, fontWeight: 600 }}>
              {card.chainLabel}
            </span>
          ) : null}
        </div>

        {card ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 48, padding: "0 64px" }}>
            {logo ? (
              <img src={logo} alt="" width={220} height={220} style={{ width: 220, height: 220, borderRadius: 48, objectFit: "cover", border: `1px solid ${LINE}` }} />
            ) : (
              <div style={{ width: 220, height: 220, borderRadius: 48, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 75% 45%))`, color: "#fff", fontFamily: "Unbounded, Inter, sans-serif", fontWeight: 700, fontSize: 110 }}>
                {card.symbol.slice(0, 1)}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
                <span style={{ fontFamily: "Unbounded, Inter, sans-serif", fontWeight: 700, fontSize: 72, letterSpacing: -2, lineHeight: 1.05 }}>{card.title}</span>
                <span style={{ fontFamily: "Space Mono, monospace", fontSize: 30, color: MUTED }}>{card.symbol}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 18 }}>
                <span style={{ fontFamily: "Unbounded, Inter, sans-serif", fontWeight: 700, fontSize: 64, letterSpacing: -2 }}>{card.mcap}</span>
                <span style={{ fontFamily: "Space Mono, monospace", fontSize: 32, fontWeight: 700, color: card.up === null ? MUTED : card.up ? UP : DOWN }}>{card.change}</span>
                <span style={{ fontSize: 22, color: MUTED }}>market cap · since launch</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 26 }}>
                {card.quote ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 10, height: 40, padding: "0 16px 0 7px", borderRadius: 999, border: `1px solid ${official ? MUSEWORLD_BLUE : LINE}`, background: official ? MUSEWORLD_BLUE : "#fff", color: official ? "#fff" : BODY, fontSize: 19, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {card.quote.kind === "museworld" ? (
                      <span style={{ display: "flex", width: 30, height: 30, borderRadius: 8, overflow: "hidden" }}>
                        {mwLogo ? <img src={mwLogo} width={30} height={30} alt="" /> : null}
                      </span>
                    ) : card.quote.kind === "gitlawb" ? (
                      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, background: GITLAWB_LOGO_BG, overflow: "hidden" }}>
                        {glLogo ? <img src={glLogo} width={30} height={30} alt="" /> : null}
                      </span>
                    ) : (
                      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8, background: BLUE, color: "#fff", fontSize: card.quote.ticker.length > 4 ? 7 : card.quote.ticker.length > 3 ? 8 : 10, fontWeight: 800, letterSpacing: -0.5, whiteSpace: "nowrap", overflow: "hidden" }}>
                        {card.quote.ticker}
                      </span>
                    )}
                    {official ? `official · priced in ${card.quote.symbol}` : `priced in ${card.quote.symbol}`}
                  </span>
                ) : null}
                {[card.fee, "liquidity locked forever", card.age].map((t, i) => (
                  <span key={t} style={{ display: "flex", alignItems: "center", height: 40, padding: "0 16px", borderRadius: 999, border: `1px solid ${i === 0 ? "#bbf7d0" : LINE}`, background: i === 0 ? "#ECFDF3" : "#fff", color: i === 0 ? UP : BODY, fontSize: 19, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 64px", fontSize: 40, color: MUTED }}>Token not found</div>
        )}
        <div style={{ padding: "0 64px 40px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 20, color: MUTED }}>Free. Open source. No platform fee. Ever.</span>
          {/* call to action: the one thing a reader can do from this card */}
          <span style={{ display: "flex", alignItems: "center", gap: 10, height: 52, padding: "0 26px", borderRadius: 999, background: BLUE, color: "#fff", fontSize: 22, fontWeight: 700 }}>
            {card ? `Trade ${card.symbol} on ${BRAND}${BRAND_TLD}` : `Launch a token on ${BRAND}${BRAND_TLD}`} →
          </span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
