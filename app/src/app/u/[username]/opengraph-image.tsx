import { ImageResponse } from "next/og";
import sharp from "sharp";
import { loadOgFonts } from "@/lib/ogFonts";
import { memo } from "@/lib/launchpad/memo";
import { readImage } from "@/lib/launchpad/imageStore";
import { getProfile } from "@/lib/profiles/server";
import { walletFacts } from "@/lib/profiles/stats";
import { usernameFromPath } from "@/lib/profiles/validate";
import { BRAND, BRAND_DOMAIN, BRAND_TLD } from "@/lib/brand";
import { walletHue, walletMark } from "@/lib/wallet-mark";

export const alt = "profile on openlaunch.lol";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const PAPER = "#FAFAF8";
const INK = "#0F172A";
const BODY = "#475569";
const MUTED = "#64748B";
const LINE = "#E7E5E4";
const BLUE = "#0052FF";

/** The avatar from our own store only (uploaded + re-encoded by us), as a PNG data URL; satori cannot decode WebP. */
async function avatarPng(url: string | null): Promise<string | null> {
  const key = url?.match(/(t\/[0-9a-f]{48}\.webp)$/)?.[1];
  if (!key) return null;
  try {
    const buf = await readImage(key);
    if (!buf) return null;
    const png = await sharp(buf).resize(240, 240).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The link card under every profile link, including the X verification post: name, ✓, and three on-chain facts. */
export default async function ProfileOg({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const u = usernameFromPath(username);
  const [fonts, p] = await Promise.all([loadOgFonts(), u ? memo(`og-u:${u}`, 30_000, () => getProfile({ username: u })) : Promise.resolve(null)]);
  const facts = p ? await memo(`u-facts:${p.wallet}`, 10_000, () => walletFacts(p.wallet)) : null;
  const avatar = p ? await memo(`og-u-avatar:${p.wallet}:${p.avatar_url ?? ""}`, 60_000, () => avatarPng(p.avatar_url)) : null;
  // no picture: the same wallet mark the site draws (WalletAvatar), so the card and the page look like one person
  const hue = p ? walletHue(p.wallet) : 212;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: PAPER, display: "flex", flexDirection: "column", fontFamily: "Geist, sans-serif", position: "relative", overflow: "hidden", color: INK }}>
        <div style={{ position: "absolute", top: -320, left: -120, width: 900, height: 640, borderRadius: "50%", background: "radial-gradient(closest-side, #EAF0FF 0%, rgba(234,240,255,0) 100%)" }} />
        <div style={{ display: "flex", alignItems: "center", padding: "40px 64px 0", gap: 12 }}>
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
        {p && facts ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 48, padding: "0 64px" }}>
            {avatar ? (
              <img src={avatar} alt="" width={220} height={220} style={{ width: 220, height: 220, borderRadius: 999, objectFit: "cover", border: `1px solid ${LINE}` }} />
            ) : (
              <svg width={220} height={220} viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="19.5" fill={`hsl(${hue} 85% 86%)`} stroke={`hsl(${hue} 35% 78%)`} strokeWidth={0.5} />
                {walletMark(p.wallet).map(({ x, y }) => (
                  <rect key={`${x}:${y}`} x={x} y={y} width={3.5} height={3.5} rx={0.8} fill={`hsl(${hue} 70% 28%)`} />
                ))}
              </svg>
            )}
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ fontWeight: 700, fontSize: 68, letterSpacing: -2, lineHeight: 1.05, maxWidth: 640, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{p.display_name}</span>
                {p.x ? (
                  <svg width={52} height={52} viewBox="0 0 24 24">
                    <path fill={BLUE} d="M12 1.5l2.4 1.8 3-.2 1 2.8 2.6 1.6-.7 2.9 1.2 2.7-2.1 2.1-.2 3-2.9.7-1.8 2.4-2.8-1-2.7 1-1.8-2.4-2.9-.7-.2-3-2.1-2.1 1.2-2.7-.7-2.9 2.6-1.6 1-2.8 3 .2z" />
                    <path fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" d="M8 12.3l2.6 2.6L16.2 9.3" />
                  </svg>
                ) : null}
              </div>
              <span style={{ fontSize: 30, color: MUTED, marginTop: 8 }}>{p.x ? `${p.username} · @${p.x.handle} on X` : p.username}</span>
              <div style={{ display: "flex", gap: 14, marginTop: 30 }}>
                {[
                  [facts.launches, "tokens launched"],
                  [facts.holders, "holders"],
                  [facts.trades, "trades"],
                ].map(([v, k]) => (
                  <div key={String(k)} style={{ display: "flex", flexDirection: "column", padding: "16px 22px", borderRadius: 18, border: `1px solid ${LINE}`, background: "#fff", minWidth: 170 }}>
                    <span style={{ fontWeight: 700, fontSize: 40, letterSpacing: -1 }}>{Number(v).toLocaleString("en-US")}</span>
                    <span style={{ fontSize: 19, color: BODY }}>{k}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 64px", fontSize: 40, color: MUTED }}>Profile not found</div>
        )}
        <div style={{ padding: "0 64px 40px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 20, color: MUTED }}>{p ? `${BRAND_DOMAIN}/u/${p.username}` : BRAND_DOMAIN}</span>
          <span style={{ display: "flex", alignItems: "center", height: 52, padding: "0 26px", borderRadius: 999, background: BLUE, color: "#fff", fontSize: 22, fontWeight: 700 }}>Free token launches · no platform fee →</span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
