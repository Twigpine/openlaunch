/**
 * The "why" line under a points row, in the reader's language. The server words it in English (whyLine in
 * lib/points/score.ts), which is also what /api/points and the admin views show, so this reads each part back and says
 * it with the account.points.why messages. A part it does not know reads as it came. Server-safe (the leaderboard page
 * and the client cards both use it).
 */
export type WhyKey = "verifiedHolders" | "holders" | "creatorFees" | "early" | "held" | "scoutFees";
/** The values a why message takes: the number as written (`n`) and as a number for the plural (`count`), or a USD amount. */
export type WhyValues = { n: string; count: number } | { usd: string };

const PARTS: readonly [RegExp, WhyKey, "count" | "usd"][] = [
  [/^(\d+) verified holders?$/, "verifiedHolders", "count"],
  [/^(\d+) holders?$/, "holders", "count"],
  [/^(\$[\d,.]+) fees from verified traders$/, "creatorFees", "usd"],
  [/^early on (\d+) tokens?$/, "early", "count"],
  [/^(\d+) held a day\+$/, "held", "count"],
  [/^(\$[\d,.]+) fees paid$/, "scoutFees", "usd"],
];

/** `line` with every part it knows said by `say` (a translator over account.points.why), joined as the server joins them. */
export function whyText(line: string, say: (key: WhyKey, values: WhyValues) => string): string {
  if (!line) return line;
  return line
    .split(" · ")
    .map((part) => {
      for (const [pattern, key, kind] of PARTS) {
        const m = pattern.exec(part);
        if (m) return say(key, kind === "usd" ? { usd: m[1] } : { n: m[1], count: Number(m[1]) });
      }
      return part;
    })
    .join(" · ");
}
