import { FlickeringGrid } from "@/components/vendor/flickering-grid";

/**
 * Behind the home hero and the river: a flickering grid (grey on light, blue on dark) fading out from the top, with no colour wash
 * over it. Decorative only; it sits in a clipped band so it never widens the page.
 */
export default function HeroBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <FlickeringGrid className="absolute inset-0 [mask-image:radial-gradient(ellipse_75%_65%_at_50%_0%,#000_35%,transparent_100%)]" squareSize={3} gridGap={8} flickerChance={0.18} maxOpacity={0.24} color="var(--color-glow)" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-paper" />
    </div>
  );
}
