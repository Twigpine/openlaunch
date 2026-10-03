import { Geist_Mono, Inter, Unbounded } from "next/font/google";

/**
 * Font loaders shared by the root layout and global-error.tsx.
 * global-error replaces the root layout when active, so it cannot inherit
 * these variables — it imports them from here instead of duplicating them.
 */
export const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
export const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
export const unbounded = Unbounded({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-unbounded", display: "swap" });
