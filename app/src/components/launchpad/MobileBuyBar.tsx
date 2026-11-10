"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";

/** Sticky "Buy" bar on phones, shown only while the trade panel (#trade) is scrolled out of view. */
export default function MobileBuyBar({ symbol, mcap }: { symbol: string; mcap: string }) {
  const t = useTranslations("trade.mobileBar");
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = document.getElementById("trade");
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      className={`bb-action-bar lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/80 pb-[env(safe-area-inset-bottom)] transition-transform duration-200 motion-reduce:transition-none ${show ? "translate-y-0" : "translate-y-full"}`}
      aria-hidden={!show}
      inert={!show}
    >
      <div className="px-4 h-16 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">{t("mcap", { symbol })}</div>
          <div className="font-mono font-bold text-ink tnum">{mcap}</div>
        </div>
        <a href="#trade" onClick={(e) => { e.preventDefault(); const panel = document.getElementById("trade"); panel?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); panel?.focus({ preventScroll: true }); }} className="inline-flex items-center justify-center min-h-11 px-6 rounded-xl bg-up text-inverse text-sm font-semibold">
          {t("trade", { symbol })}
        </a>
      </div>
    </div>
  );
}
