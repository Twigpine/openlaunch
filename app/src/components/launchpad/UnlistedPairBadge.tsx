/**
 * Marks a launch paired with an ERC-20 no list knows (lib/launchpad/unlisted-quote.ts): the pool is real and indexed,
 * but the quote's name is only what its own contract says, and it has no USD price here.
 */
export default function UnlistedPairBadge({ symbol, className = "" }: { symbol: string; className?: string }) {
  return (
    <span className={`inline-flex h-5 items-center rounded-full border border-warm/30 bg-warm-soft px-2 text-[10px] font-medium text-warm-ink ${className}`} title={`Paired with ${symbol}, a token openlaunch does not list. Its name comes from its own contract; check the address.`}>
      Unlisted pair
    </span>
  );
}
