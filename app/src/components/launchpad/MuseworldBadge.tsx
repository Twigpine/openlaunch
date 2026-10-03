import { BadgeCheck } from "lucide-react";
import { MUSEWORLD_BLUE, MUSEWORLD_LOGO_PATH, MUSEWORLD_SYMBOL } from "@/lib/launchpad/museworld";
import GitlawbBadge, { isGitlawbQuote } from "./GitlawbBadge";

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

/** The brand badge a quote earns, if any: GITLAWB's or Museworld's official one. One place for every list to call. */
export function QuoteBrandBadge({ quoteKey, size = "sm", className = "" }: { quoteKey: string | null | undefined; size?: "sm" | "md"; className?: string }) {
  if (isGitlawbQuote(quoteKey)) return <GitlawbBadge size={size} className={className} />;
  if (isMuseworldQuote(quoteKey)) return <MuseworldBadge size={size} className={className} />;
  return null;
}
