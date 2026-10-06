"use client";

import { useId, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { helper, input as inputCls } from "@/components/ui";
import { BANNER_HEIGHT, BANNER_WIDTH, maxBytesFor, sniffImage, type ImageRole } from "@/lib/launchpad/images";
import { Spinner } from "@/components/Skeleton";

/**
 * The address an image preview loads: an http(s) URL typed into the field, parsed the way the browser will request
 * it, or null. The parser already percent-encodes quotes and angle brackets, so the replace never changes a real
 * address; it is there so static analysis (CodeQL js/xss-through-dom) can see that typed text never reaches the
 * <img> as markup.
 */
function previewUrl(value: string): string | null {
  const url = value.trim();
  if (!/^https?:\/\//.test(url)) return null;
  try {
    return new URL(url).href.replace(/["<]/g, encodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * Token image picker: drop zone / tap-to-browse → POST /api/launch/image → https URL into `value`.
 * The URL field stays available for people who already host the image. Wallet must be connected
 * (uploads are rate-limited per wallet server-side). `kind="banner"` picks the wide banner instead of
 * the square logo: a 3:1 drop zone that previews the banner across its full width. `stacked` (from sm up)
 * fills the height it is given, so a logo and a banner side by side end level: the logo's tile sits above
 * its words, and the banner zone drops its fixed 3:1 for the row's height.
 */
export default function ImageUpload({ value, onChange, wallet, compact = false, kind = "logo", stacked = false }: { value: string; onChange: (url: string) => void; wallet: string | undefined; compact?: boolean; kind?: ImageRole; stacked?: boolean }) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const preview = previewUrl(value);
  const banner = kind === "banner";
  const max = maxBytesFor(kind);

  async function upload(file: File) {
    setErr(null);
    if (!wallet) return setErr("Connect a wallet to upload.");
    if (file.size > max) return setErr(`Max ${max / 1024 / 1024} MB.`);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!sniffImage(head)) return setErr("PNG, JPEG, WebP or GIF only.");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("wallet", wallet);
      fd.set("kind", kind);
      fd.set("file", file, kind);
      const r = await fetch("/api/launch/image", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error || `upload failed (${r.status})`);
      onChange(j.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  // the drop zone behaves the same for both kinds; only what it draws differs
  const zone = {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": banner ? "Upload token banner" : "Upload token image",
    onClick: () => !busy && fileRef.current?.click(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileRef.current?.click();
      }
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void upload(f);
    },
  };
  const edge = `${over ? "border-brand bg-brand-soft" : "border-line hover:border-ink/40 bg-paper"} ${busy ? "opacity-70 cursor-progress" : ""}`;
  const fileInput = (
    <input
      ref={fileRef}
      id={id}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      className="sr-only"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void upload(f);
      }}
    />
  );

  const tile = compact ? 64 : 88;
  return (
    <div className={stacked ? "sm:flex sm:h-full sm:flex-col" : undefined}>
      {banner ? (
        <div className={`relative ${stacked ? "sm:flex-1" : ""}`}>
          <div {...zone} className={`group relative grid aspect-[3/1] w-full cursor-pointer select-none place-items-center overflow-hidden rounded-2xl border border-dashed transition-colors ${stacked ? "sm:aspect-auto sm:h-full" : ""} ${edge}`}>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="absolute inset-0 size-full object-cover" referrerPolicy="no-referrer" />
            ) : null}
            <div className={`relative flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-center transition-opacity motion-reduce:transition-none ${preview ? "bg-black/60 text-white opacity-0 backdrop-blur-sm group-hover:opacity-100 group-focus-visible:opacity-100" : ""}`}>
              {busy ? <Spinner size={18} className={preview ? "text-white" : "text-brand"} /> : preview ? null : <ImagePlus size={20} strokeWidth={1.8} aria-hidden="true" className="mb-0.5 text-muted" />}
              <p className="text-sm font-semibold">{busy ? "Uploading…" : preview ? "Change banner" : "Upload banner"}</p>
              <p className={`text-xs ${preview ? "text-white/80" : "text-muted"}`}>{busy ? `Resizing to ${BANNER_WIDTH}×${BANNER_HEIGHT}` : `Wide, about 3:1 · PNG, JPEG, WebP or GIF · max ${max / 1024 / 1024} MB`}</p>
            </div>
            {fileInput}
          </div>
          {preview && !busy ? (
            <button type="button" onClick={() => onChange("")} aria-label="Remove banner" title="Remove banner" className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/75 motion-reduce:transition-none">
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : (
        <div {...zone} className={`flex items-center rounded-2xl border border-dashed cursor-pointer transition-colors select-none ${stacked ? "gap-4 px-4 py-3 sm:flex-1 sm:flex-col sm:justify-center sm:gap-3 sm:px-3 sm:py-4 sm:text-center" : "gap-4 px-4 py-3"} ${edge}`}>
          <div className="shrink-0 rounded-2xl overflow-hidden bg-card border border-line flex items-center justify-center" style={{ width: tile, height: tile }}>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" width={tile} height={tile} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : busy ? (
              <Spinner size={20} className="text-brand" />
            ) : (
              <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="text-muted" aria-hidden>
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <circle cx="9" cy="10" r="2" />
                <path d="M21 16l-5-5-8 8" />
              </svg>
            )}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm">{busy ? "Uploading…" : preview ? "Change image" : "Upload image"}</p>
            <p className={`${helper} mt-0.5`}>{busy ? "Resizing to 512×512" : stacked ? "Square · PNG, JPEG, WebP or GIF · max 2 MB" : "PNG, JPEG, WebP or GIF · max 2 MB · drop it here or tap"}</p>
          </div>
          {fileInput}
        </div>
      )}
      {err ? <p className="text-xs text-red-600 mt-1.5">{err}</p> : null}
      <details className="mt-2">
        <summary className={`${helper} cursor-pointer select-none`}>{banner ? "or paste a banner URL" : "or paste an image URL"}</summary>
        <input className={`${inputCls} mt-2`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={banner ? "https://…/banner.png" : "https://…/logo.png"} inputMode="url" aria-label={banner ? "Banner URL" : "Image URL"} />
      </details>
    </div>
  );
}
