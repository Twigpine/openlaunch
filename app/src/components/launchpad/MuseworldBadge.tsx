import { BadgeCheck } from "lucide-react";
import { MUSEWORLD_BLUE, MUSEWORLD_LOGO_PATH, MUSEWORLD_SYMBOL } from "@/lib/launchpad/museworld";
import GitlawbBadge, { isGitlawbQuote } from "./GitlawbBadge";
import TwigBadge, { isTwigQuote } from "./TwigBadge";

/** Museworld's logo tile (white "m" and sparkle on Museworld blue, transparent corners baked in), served from our origin. */
export function MuseworldMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={MUSEWORLD_LOGO_PATH} alt="" width={size} height={size} className={`shrink-0 ${className}`} />;
}

/**
 * Official badge for tokens paired with MUSEWORLD, Museworld's token (lib/launchpad/museworld.ts). Same geometry as the
 * GITLAWB badge so the two sit side by side in any row: "sm" is 20px tall and fits a text-sm line. Museworld blue with
 * the logo tile flush left and a check seal on the right: the mark that says the pair is official, not just named so.
 * The badge follows the server-resolved quote key, which comes from the quote ADDRESS, never from an on-chain name.
 */
export default function MuseworldBadge({ size = "sm", className = "", label = MUSEWORLD_SYMBOL }: { size?: "sm" | "md"; className?: string; label?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-black/10 font-semibold leading-none whitespace-nowrap text-white dark:border-white/25 ${size === "md" ? "h-6 gap-1.5 pl-[3px] pr-1.5 text-[11px]" : "h-5 gap-1 pl-[2px] pr-1 text-[10px] tracking-wide"} ${className}`}
      style={{ background: MUSEWORLD_BLUE }}
      title="Official pair: MUSEWORLD, Museworld's token. Launches paired with it are made inside Museworld by its AI agents. USD from the MUSEWORLD/GITLAWB pool."
    >
      <MuseworldMark size={size === "md" ? 18 : 16} />
      {label}
      <BadgeCheck size={size === "md" ? 13 : 12} strokeWidth={2.25} aria-label="official" className="shrink-0" />
    </span>
  );
}

export function isMuseworldQuote(quoteKey: string | null | undefined): boolean {
  return quoteKey === "museworld";
}

type Brand = "twig" | "gitlawb" | "museworld";
/** The brand a quote earns a badge for, if any: TWIG, GITLAWB or Museworld's official one. The one list of brands. */
function brandOf(quoteKey: string | null | undefined): Brand | null {
  if (isTwigQuote(quoteKey)) return "twig";
  if (isGitlawbQuote(quoteKey)) return "gitlawb";
  if (isMuseworldQuote(quoteKey)) return "museworld";
  return null;
}

/** Whether a quote earns a brand badge (QuoteBrandBadge renders something for it). */
export function hasQuoteBrandBadge(quoteKey: string | null | undefined): boolean {
  return brandOf(quoteKey) !== null;
}

/** A quote's brand badge, or nothing. One place for every list to call; `satisfies` keeps it in step with `Brand`. */
export function QuoteBrandBadge({ quoteKey, size = "sm", className = "" }: { quoteKey: string | null | undefined; size?: "sm" | "md"; className?: string }) {
  const brand = brandOf(quoteKey);
  if (brand === null) return null;
  return ({
    twig: <TwigBadge size={size} className={className} />,
    gitlawb: <GitlawbBadge size={size} className={className} />,
    museworld: <MuseworldBadge size={size} className={className} />,
  } satisfies Record<Brand, React.ReactElement>)[brand];
}
