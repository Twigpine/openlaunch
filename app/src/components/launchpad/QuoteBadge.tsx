import { PAIR_COPY } from "@/lib/launchpad/pairs";
import GitlawbBadge, { isGitlawbQuote } from "./GitlawbBadge";
import TwigBadge, { isTwigQuote } from "./TwigBadge";

/**
 * Badge for tokens paired with a community pair (lib/launchpad/pairs.ts): the community's logo and symbol, in a neutral
 * pill with no seal. Same geometry as the TWIG and GITLAWB badges ("sm" is 20px tall and fits a text-sm line). It
 * follows the server-resolved quote key, which comes from the pair's ADDRESS on the list, never from an on-chain name.
 * `collapse` shows the logo alone on phones, keeping the label for screen readers.
 */
export function CommunityPairBadge({ symbol, logo, size = "sm", className = "", label = symbol, collapse = false }: { symbol: string; logo: string | null; size?: "sm" | "md"; className?: string; label?: string; collapse?: boolean }) {
  const px = size === "md" ? 18 : 16;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-line-strong bg-card font-semibold leading-none whitespace-nowrap text-ink ${size === "md" ? "h-6 gap-1.5 pl-[3px] pr-2 text-[11px]" : "h-5 gap-1 pl-[2px] pr-1.5 text-[10px] tracking-wide"} ${collapse ? "max-sm:pr-[2px]" : ""} ${className}`}
      title={PAIR_COPY.badgeTitle(symbol)}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" width={px} height={px} className="shrink-0 rounded-[4px]" />
      ) : (
        <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-[4px] bg-line font-mono text-[9px] text-body" style={{ width: px, height: px }}>{symbol.slice(0, 1)}</span>
      )}
      {collapse ? <span className="max-sm:sr-only">{label}</span> : label}
    </span>
  );
}

type Brand = "twig" | "gitlawb" | "pair";
/** The badge a quote earns, if any: TWIG, GITLAWB, or a community pair's. The one list of them. */
function brandOf(quoteKey: string | null | undefined): Brand | null {
  if (isTwigQuote(quoteKey)) return "twig";
  if (isGitlawbQuote(quoteKey)) return "gitlawb";
  if (quoteKey === "pair") return "pair";
  return null;
}

/** Whether a quote earns a badge (QuoteBrandBadge renders something for it). */
export function hasQuoteBrandBadge(quoteKey: string | null | undefined): boolean {
  return brandOf(quoteKey) !== null;
}

/**
 * A quote's badge, or nothing. One place for every list to call; `satisfies` keeps it in step with `Brand`. A community
 * pair needs its symbol and logo (the row's quote_symbol and quote_logo). `collapse` shows the mark alone on phones.
 */
export function QuoteBrandBadge({ quoteKey, symbol = "", logo = null, size = "sm", className = "", collapse = false }: { quoteKey: string | null | undefined; symbol?: string; logo?: string | null; size?: "sm" | "md"; className?: string; collapse?: boolean }) {
  const brand = brandOf(quoteKey);
  if (brand === null || (brand === "pair" && !symbol)) return null;
  return ({
    twig: <TwigBadge size={size} className={className} collapse={collapse} />,
    gitlawb: <GitlawbBadge size={size} className={className} collapse={collapse} />,
    pair: <CommunityPairBadge symbol={symbol} logo={logo} size={size} className={className} collapse={collapse} />,
  } satisfies Record<Brand, React.ReactElement>)[brand];
}
