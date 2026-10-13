// Adapted from Magic UI: https://magicui.design/r/shine-border.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): the theme's glow colour by default (neutral on light, blue on dark); the shine only moves when motion is allowed.
import { cn } from "@/lib/utils";

export function ShineBorder({ borderWidth = 1, duration = 14, shineColor = "var(--color-glow)", className, style, ...props }: React.HTMLAttributes<HTMLDivElement> & { borderWidth?: number; duration?: number; shineColor?: string | string[] }) {
  return (
    <div
      aria-hidden="true"
      style={{
        "--border-width": `${borderWidth}px`,
        "--duration": `${duration}s`,
        backgroundImage: `radial-gradient(transparent,transparent, ${Array.isArray(shineColor) ? shineColor.join(",") : shineColor},transparent,transparent)`,
        backgroundSize: "300% 300%",
        mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMaskComposite: "xor",
        maskComposite: "exclude",
        padding: "var(--border-width)",
        ...style,
      } as React.CSSProperties}
      className={cn("pointer-events-none absolute inset-0 size-full rounded-[inherit] will-change-[background-position] motion-safe:animate-shine", className)}
      {...props}
    />
  );
}
