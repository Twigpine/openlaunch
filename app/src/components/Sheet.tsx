"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Bottom sheet on phones (< md), centered dialog on larger screens.
 * Portaled to <body>: the sticky header's backdrop-filter would otherwise
 * become the containing block for the fixed overlay. Locks body scroll +
 * hides the mobile action bar through a counter on <html>
 * (html[data-sheet-open] in globals.css). Escape / backdrop / × close it.
 */
export default function Sheet({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const html = document.documentElement;
    const n = Number(html.dataset.sheets ?? "0") + 1;
    html.dataset.sheets = String(n);
    html.dataset.sheetOpen = "";
    const h = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      const left = Number(html.dataset.sheets ?? "1") - 1;
      if (left <= 0) {
        delete html.dataset.sheets;
        delete html.dataset.sheetOpen;
      } else {
        html.dataset.sheets = String(left);
      }
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-scrim/40 backdrop-blur-[2px]"
      onClick={() => closeRef.current()}
      role="dialog"
      aria-modal
      aria-label={title}
    >
      <div
        className={`bb-sheet-in w-full ${wide ? "md:max-w-lg" : "md:max-w-md"} max-h-[92dvh] md:max-h-[85vh] flex flex-col bg-raised border border-line rounded-t-[20px] md:rounded-2xl overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="md:hidden pt-2.5 flex justify-center" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-line-strong" />
        </div>
        <div className="flex items-center justify-between pl-5 pr-3 h-12 shrink-0">
          <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Close"
            className="h-9 w-9 inline-flex items-center justify-center rounded-full text-muted hover:text-ink hover:bg-paper"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] bb-scroll">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
