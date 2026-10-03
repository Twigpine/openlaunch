"use client";

import Link from "next/link";
import { useEffect } from "react";
import "./globals.css";
import { inter, geistMono, unbounded } from "./fonts";
import { errorBody, errorRegionLabel, sanitizeDigest } from "@/lib/error-copy";

/**
 * Root-level error boundary. Must render its own <html>/<body> — it replaces
 * the root layout when active, so it loads the global stylesheet and font
 * variables itself instead of inheriting them. Next.js injects
 * `{ error, reset }`: `reset` re-renders from the root.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = sanitizeDigest(error.digest);
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} ${unbounded.variable}`}>
      <body className="min-h-screen flex flex-col">
        <main aria-label={errorRegionLabel("global")} className="mx-auto max-w-3xl px-4 py-24 text-center space-y-5">
          <h1 className="font-display font-bold text-7xl">500</h1>
          <p role="alert" className="text-[15px]">{errorBody("global")}</p>
          {digest ? (
            <p className="text-xs opacity-70">Error ID: {digest}</p>
          ) : null}
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center justify-center rounded-xl px-5 min-h-11 bg-black text-white font-semibold text-sm"
            >
              Try again
            </button>
            <Link href="/" className="inline-flex items-center justify-center rounded-xl px-5 min-h-11 border font-semibold text-sm">
              Back to the launchpad
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
