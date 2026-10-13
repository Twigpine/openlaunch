import "server-only";

/**
 * Fonts for next/og (satori needs TTF/OTF/WOFF, not woff2): Geist, the site's one family, resolved through the
 * Google Fonts CSS endpoint with a legacy UA so it hands back TTF/WOFF.
 * All best-effort: an OG image with system fallbacks beats a broken one.
 */
export type OgFont = { name: string; data: ArrayBuffer; style: "normal"; weight: 400 | 500 | 600 | 700 | 800 | 900 };

async function fetchBuf(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url, { next: { revalidate: 86400 } });
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function googleTtf(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:27.0) Gecko/20100101 Firefox/27.0" },
      next: { revalidate: 86400 },
    });
    if (!css.ok) return null;
    const text = await css.text();
    const m = /src:\s*url\(([^)]+\.(?:ttf|otf|woff))\)/.exec(text);
    return m ? fetchBuf(m[1]) : null;
  } catch {
    return null;
  }
}

export async function loadOgFonts(): Promise<OgFont[]> {
  const weights = [400, 500, 700] as const;
  const files = await Promise.all(weights.map((weight) => googleTtf("Geist", weight)));
  return weights.flatMap((weight, i) => { const data = files[i]; return data ? [{ name: "Geist", data, style: "normal" as const, weight }] : []; });
}
