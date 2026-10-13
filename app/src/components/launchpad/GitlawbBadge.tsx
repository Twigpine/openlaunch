import { GITLAWB_LOGO_BG, GITLAWB_LOGO_PATH, GITLAWB_SYMBOL } from "@/lib/launchpad/gitlawb";

/** Gitlawb's logo tile (black, white branch-and-key mark; transparent corners baked in), served from our origin. */
export function GitlawbMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={GITLAWB_LOGO_PATH} alt="" width={size} height={size} className={`shrink-0 ${className}`} />;
}

/**
 * Badge for tokens paired with GITLAWB. Shown wherever a token appears (list, trending, feed, token page,
 * dashboard, share card) — the visible perk of picking GITLAWB as the quote asset. "sm" is 20px tall so it sits
 * inside a text-sm line without changing row heights. Black like the logo tile,
 * white text, a light hairline in dark mode so it still reads as a chip on a dark page. `collapse` shows the mark
 * alone on phones, keeping the label for screen readers.
 */
export default function GitlawbBadge({ size = "sm", className = "", label = GITLAWB_SYMBOL, collapse = false }: { size?: "sm" | "md"; className?: string; label?: string; collapse?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-black/10 font-semibold leading-none whitespace-nowrap text-white dark:border-white/25 ${size === "md" ? "h-6 gap-1.5 pl-[3px] pr-2 text-[11px]" : "h-5 gap-1 pl-[2px] pr-1.5 text-[10px] tracking-wide"} ${collapse ? "max-sm:pr-[2px]" : ""} ${className}`}
      style={{ background: GITLAWB_LOGO_BG }}
      title="Paired with GITLAWB: buyers pay in GITLAWB; any trading fee is paid, or burned, in GITLAWB."
    >
      <GitlawbMark size={size === "md" ? 18 : 16} />
      {collapse ? <span className="max-sm:sr-only">{label}</span> : label}
    </span>
  );
}

/** True for a row whose server-resolved quote key is GITLAWB (keys come from the quote address, never from on-chain names). */
export function isGitlawbQuote(quoteKey: string | null | undefined): boolean {
  return quoteKey === "gitlawb";
}
