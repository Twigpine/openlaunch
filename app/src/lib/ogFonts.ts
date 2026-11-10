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

/** `text` asks Google for a subset holding only those characters (a few KB instead of a whole CJK face). */
async function googleFont(family: string, weight: number, text?: string): Promise<ArrayBuffer | null> {
  try {
    const subset = text ? `&text=${encodeURIComponent(text)}` : "";
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}${subset}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:27.0) Gecko/20100101 Firefox/27.0" },
      next: { revalidate: 86400 },
    });
    if (!css.ok) return null;
    const body = await css.text();
    // a whole family comes back as a .ttf/.woff file; a text= subset as an extensionless URL with its format beside it
    const m = /src:\s*url\(([^)]+)\)\s*format\('(?:woff|truetype|opentype)'\)/.exec(body) ?? /src:\s*url\(([^)]+\.(?:ttf|otf|woff))\)/.exec(body);
    return m ? fetchBuf(m[1]) : null;
  } catch {
    return null;
  }
}

export async function loadOgFonts(): Promise<OgFont[]> {
  const weights = [400, 500, 700] as const;
  const files = await Promise.all(weights.map((weight) => googleFont("Geist", weight)));
  return weights.flatMap((weight, i) => { const data = files[i]; return data ? [{ name: "Geist", data, style: "normal" as const, weight }] : []; });
}

/** Han (with CJK punctuation and full-width forms) and kana, which Noto Sans SC draws, and Hangul, which Noto Sans KR does. */
const HAN = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯\u{20000}-\u{2FA1F}]/u;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
const MAX_CHARACTERS = 300;

/** The distinct characters of `text` Geist has no glyph for, by the face that draws them. */
export function cjkCharacters(text: string): { han: string; hangul: string } {
  const han = new Set<string>();
  const hangul = new Set<string>();
  for (const char of text) {
    if (HAN.test(char) && han.size < MAX_CHARACTERS) han.add(char);
    else if (HANGUL.test(char) && hangul.size < MAX_CHARACTERS) hangul.add(char);
  }
  return { han: [...han].join(""), hangul: [...hangul].join("") };
}

/**
 * Fallback faces for the CJK characters a card draws (a token or person named in Chinese, Japanese or Korean): satori
 * falls back glyph by glyph through every font it is given, so these sit after Geist. Nothing is fetched for Latin text.
 */
export async function loadCjkOgFonts(text: string): Promise<OgFont[]> {
  const { han, hangul } = cjkCharacters(text);
  const [sc, kr] = await Promise.all([han ? googleFont("Noto Sans SC", 700, han) : null, hangul ? googleFont("Noto Sans KR", 700, hangul) : null]);
  return [
    ...(sc ? [{ name: "Noto Sans SC", data: sc, style: "normal" as const, weight: 700 as const }] : []),
    ...(kr ? [{ name: "Noto Sans KR", data: kr, style: "normal" as const, weight: 700 as const }] : []),
  ];
}
