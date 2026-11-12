import { Doto } from "next/font/google";

/**
 * Dot-matrix numerals for the bridge's amounts and board caption (Doto, SIL Open Font Licence). Declared here, not in
 * app/fonts.ts, so it ships with the lazily loaded bridge panel and is never preloaded on pages that do not open it.
 */
export const dotFont = Doto({ subsets: ["latin"], axes: ["ROND"], variable: "--font-dots", display: "swap", preload: false });
