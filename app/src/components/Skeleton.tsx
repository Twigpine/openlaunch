/**
 * Skeleton primitives (server-safe). Gray placeholders in the shape of the content they replace,
 * shimmering unless the viewer prefers reduced motion. Keep layouts identical to the real component
 * so nothing shifts when data arrives.
 */
export function Sk({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`bb-skel block rounded-md ${className}`} style={style} aria-hidden />;
}

/** One launch row, matching LaunchRow's grid. */
export function SkRow({ i, ledger = false }: { i: number; ledger?: boolean }) {
  if (ledger) return (
    <li className="relative min-h-[5.25rem] border-b border-line py-3 pl-12 pr-3 sm:min-h-[5.5rem]">
      <Sk className="absolute left-3 top-6 h-4 w-4" />
      <div className="launch-ledger grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3"><Sk className="h-11 w-11 shrink-0 rounded-xl" /><div className="min-w-0 flex-1 space-y-1.5"><Sk className="h-3.5 w-3/4" /><Sk className="h-2.5 w-full max-w-36" /><Sk className="hidden h-2.5 w-4/5 sm:block" /></div></div>
        <div className="space-y-1.5"><div className="flex justify-end gap-2"><Sk className="h-4 w-16" /><Sk className="h-3 w-8" /></div><Sk className="ml-auto h-2.5 w-14" /></div>
        <div className="hidden space-y-1.5 lg:block"><Sk className="ml-auto h-3.5 w-14" /><Sk className="ml-auto h-2.5 w-10" /></div>
        <div className="ml-auto hidden space-y-1.5 sm:block"><Sk className="ml-auto h-3 w-24" /><Sk className="ml-auto h-2.5 w-28" /></div>
        <Sk className="col-span-2 h-2.5 w-4/5 sm:hidden" />
        <div className="col-span-2 grid grid-cols-2 items-end gap-3 sm:hidden"><div className="space-y-1.5"><Sk className="h-2 w-16" /><Sk className="h-3 w-12" /></div><div className="space-y-1.5"><Sk className="ml-auto h-3 w-24" /><Sk className="ml-auto h-2.5 w-16" /></div></div>
      </div>
    </li>
  );
  return (
    <li className="px-3 sm:px-4 py-3 border-t border-line first:border-t-0">
      <div className="grid md:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem_4rem] items-center gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Sk className="h-10 w-10 rounded-xl shrink-0" />
          <div className="min-w-0 space-y-2">
            <Sk className="h-3.5" style={{ width: `${110 + ((i * 37) % 90)}px` }} />
            <Sk className="h-3 w-24" />
          </div>
        </div>
        <Sk className="hidden md:block h-3.5 w-16 ml-auto" />
        <Sk className="hidden md:block h-3.5 w-14 ml-auto" />
        <Sk className="hidden md:block h-3.5 w-12 ml-auto" />
        <Sk className="hidden md:block h-3 w-8 ml-auto" />
      </div>
    </li>
  );
}

export function SkStat() {
  return (
    <div className="rounded-xl bg-card border border-line shadow-card px-3.5 py-3 min-w-0 space-y-2">
      <Sk className="h-3 w-14" />
      <Sk className="h-5 w-20" />
      <Sk className="h-2.5 w-16" />
    </div>
  );
}

/**
 * One compact sidebar row. `round` (default) is a post: 28px wallet avatar, author line, token line and a
 * clamped body (PostsFeed compact). `tile` is a launch-tape row: 28px square token tile and two lines.
 */
export function SkPost({ i = 0, avatar = "round" }: { i?: number; avatar?: "round" | "tile" }) {
  return (
    <li className="px-4 py-3 border-t border-line first:border-t-0 flex gap-2.5">
      <Sk className={`h-7 w-7 shrink-0 ${avatar === "tile" ? "rounded-lg" : "rounded-full"}`} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2"><Sk className="h-3 w-24" /><Sk className="h-2.5 w-8" /></div>
        <Sk className="h-2.5 w-28" />
        {avatar === "round" ? <><Sk className="mt-2 h-3.5 w-full" /><Sk className="h-3.5" style={{ width: `${40 + ((i * 29) % 45)}%` }} /></> : null}
      </div>
    </li>
  );
}

/**
 * One community-feed post (CommunityFeed.tsx `.post`): 40px wallet avatar + author heading, a 15px body
 * (26px line pitch), the 20px token tile line and the "Open conversation" line.
 * Open rows use 28px vertical padding, 24px on phones, with no inset container.
 */
export function SkFeedPost({ i }: { i: number }) {
  const lines = 1 + (i % 2);
  return (
    <li className="border-t border-line first:border-t-0 py-6 sm:py-7">
      <div className="flex items-center gap-3">
        <Sk className="h-10 w-10 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center"><Sk className="h-3.5 w-28" /></div>
          <div className="mt-1 flex h-5 items-center gap-2"><Sk className="h-5 w-14 rounded" /><Sk className="h-2.5 w-16" /></div>
        </div>
        <Sk className="h-4 w-4 shrink-0" />
      </div>
      <div className="mt-[18px]">
        {Array.from({ length: lines }, (_, n) => <div key={n} className="flex h-[26px] items-center"><Sk className="h-3.5" style={{ width: n === lines - 1 ? `${30 + ((i * 23) % 45)}%` : "100%" }} /></div>)}
      </div>
      <div className="mt-[18px] flex items-center gap-2"><Sk className="h-5 w-5 shrink-0 rounded-md" /><Sk className="h-3 w-44 max-w-full" /></div>
      <div className="mt-2 flex h-8 items-center"><Sk className="h-3 w-28" /></div>
    </li>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <span className={`bb-spin inline-block rounded-full border-2 border-current border-t-transparent align-[-0.15em] ${className}`} style={{ width: size, height: size }} aria-hidden />;
}
