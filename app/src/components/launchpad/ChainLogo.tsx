import Image from "next/image";
import type { ChainKey } from "@/lib/chainPublic";

/**
 * Official network marks (public/brand; each file names its source), each on its own rounded tile so a white mark
 * reads on the light theme too. Base's blue square is its own tile; Robinhood's feather and Arc's arch sit on black,
 * as in their own app icons. Always decorative: the chain's name is in the text beside it.
 */
/** Black tiles keep a hairline inner edge, so they still read as tiles on the black dark theme. */
const DARK_TILE = "bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]";
// `fill`: the mark is its own tile and covers it edge to edge
const MARK: Record<ChainKey, { src: string; tile: string; w: number; h: number; scale: number; fill: boolean }> = {
  base: { src: "/brand/base.svg", tile: "", w: 1, h: 1, scale: 1, fill: true },
  robinhood: { src: "/brand/robinhood-white.svg", tile: DARK_TILE, w: 32, h: 42, scale: 0.62, fill: false },
  arc: { src: "/brand/arc.svg", tile: DARK_TILE, w: 31, h: 32, scale: 0.56, fill: false },
};

export function ChainLogo({ chain, size = 18, className = "" }: { chain: ChainKey; size?: number; className?: string }) {
  const mark = MARK[chain];
  const box = Math.round(size * mark.scale);
  const height = box;
  const width = Math.round((box * mark.w) / mark.h);
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-[28%] ${mark.tile} ${className}`} style={{ width: size, height: size }}>
      <Image src={mark.src} alt="" width={mark.fill ? size : width} height={mark.fill ? size : height} draggable={false} className={mark.fill ? "size-full" : ""} />
    </span>
  );
}

/** The networks as one overlapping row; inside a `group` they fan out on hover. */
export function ChainLogoStack({ chains, size = 18 }: { chains: readonly ChainKey[]; size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center">
      {chains.map((chain, i) => (
        <ChainLogo key={chain} chain={chain} size={size} className={`ring-2 ring-paper transition-[margin] duration-200 motion-reduce:transition-none ${i ? "-ml-1.5 group-hover:ml-0.5" : ""}`} />
      ))}
    </span>
  );
}

/** A small network mark pinned to the corner of a token avatar. Wrap the avatar in a `relative` element. */
export function ChainCorner({ chain, size = 14 }: { chain: ChainKey; size?: number }) {
  return <ChainLogo chain={chain} size={size} className="absolute -right-1 -bottom-1 ring-2 ring-paper" />;
}
