"use client";

import { useState } from "react";
import { addressHue } from "@/lib/launchpad/tint";

/**
 * Token image with a graceful fallback: a soft gradient tile with the first letter of the symbol
 * (the openlaunch default mark). `chain` is accepted so call sites can pass the token's chain, but the
 * fallback is keyed on the address alone so a token looks the same everywhere.
 */
export default function TokenAvatar({ token, symbol, image, size = 40, className = "" }: { chain?: string; token: string; symbol: string; image?: string | null; size?: number; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = image?.trim() || null;
  const h = addressHue(token); // the same hue the token page tint falls back to
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) };
  if (src && src !== failedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={src}
        src={src}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={`shrink-0 rounded-xl object-cover bg-paper border border-line ${className}`}
        style={style}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`shrink-0 rounded-xl grid place-items-center font-display font-bold text-white select-none ${className}`}
      style={{ ...style, background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 75% 45%))` }}
    >
      {symbol.slice(0, 1).toUpperCase()}
    </div>
  );
}
