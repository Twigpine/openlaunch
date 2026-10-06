import { Geist, Geist_Mono } from "next/font/google";

/**
 * Font loaders shared by the root layout and global-error.tsx.
 * global-error replaces the root layout when active, so it cannot inherit
 * these variables — it imports them from here instead of duplicating them.
 *
 * One family for the interface, figures included (Geist, as most launchpads keep a single grotesk); Geist Mono only
 * for addresses and transaction hashes, where every character must line up.
 */
export const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
export const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
