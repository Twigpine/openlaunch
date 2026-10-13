import { TWIG_LOGO_BG, TWIG_LOGO_PATH, TWIG_SYMBOL } from "@/lib/launchpad/twig";

/** Twigpine's logo tile (the light tree with its green dot on near-black; transparent corners baked in), served from our origin. */
export function TwigMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={TWIG_LOGO_PATH} alt="" width={size} height={size} className={`shrink-0 ${className}`} />;
}

/**
 * Badge for tokens paired with TWIG, the Base form's GITLAWB wrapper (lib/launchpad/twig.ts). Same geometry as the
 * GITLAWB badge so either sits in any row: "sm" is 20px tall and fits a text-sm line. Near-black like the logo tile,
 * white text, a light hairline in dark mode so it still reads as a chip on a dark page. `collapse` shows the mark
 * alone on phones, keeping the label for screen readers.
 */
export default function TwigBadge({ size = "sm", className = "", label = TWIG_SYMBOL, collapse = false }: { size?: "sm" | "md"; className?: string; label?: string; collapse?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-black/10 font-semibold leading-none whitespace-nowrap text-white dark:border-white/25 ${size === "md" ? "h-6 gap-1.5 pl-[3px] pr-2 text-[11px]" : "h-5 gap-1 pl-[2px] pr-1.5 text-[10px] tracking-wide"} ${collapse ? "max-sm:pr-[2px]" : ""} ${className}`}
      style={{ background: TWIG_LOGO_BG }}
      title="Paired with TWIG, the 1:1 wrapper of GITLAWB: buyers pay in TWIG; any trading fee is paid, or burned, in TWIG."
    >
      <TwigMark size={size === "md" ? 18 : 16} />
      {collapse ? <span className="max-sm:sr-only">{label}</span> : label}
    </span>
  );
}

/** True for a row whose server-resolved quote key is TWIG (keys come from the quote address, never from on-chain names). */
export function isTwigQuote(quoteKey: string | null | undefined): boolean {
  return quoteKey === "twig";
}
