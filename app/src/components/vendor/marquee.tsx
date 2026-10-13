// Adapted from Magic UI: https://magicui.design/r/marquee.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): pauses on hover and focus inside it, stops under reduced motion, and only the first copy
// of the content is exposed to assistive tech (the repeats are decorative duplicates).
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

interface MarqueeProps extends ComponentPropsWithoutRef<"div"> {
  className?: string;
  reverse?: boolean;
  pauseOnHover?: boolean;
  children: React.ReactNode;
  vertical?: boolean;
  repeat?: number;
}

export function Marquee({ className, reverse = false, pauseOnHover = false, children, vertical = false, repeat = 4, ...props }: MarqueeProps) {
  return (
    <div {...props} className={cn("group flex gap-(--gap) overflow-hidden p-2 [--duration:40s] [--gap:1rem]", vertical ? "flex-col" : "flex-row", className)}>
      {Array.from({ length: repeat }, (_, i) => (
        <div
          key={i}
          aria-hidden={i > 0 ? true : undefined}
          inert={i > 0 ? true : undefined}
          className={cn(
            "flex shrink-0 justify-around gap-(--gap) motion-reduce:animate-none",
            vertical ? "animate-marquee-vertical flex-col" : "animate-marquee flex-row",
            pauseOnHover && "group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]",
            reverse && "[animation-direction:reverse]",
          )}
        >
          {children}
        </div>
      ))}
    </div>
  );
}
