"use client";

import { useEffect, useRef } from "react";

/**
 * Ambient motion (a beacon on every live row, floating bubbles, pings) keeps a slow phone's main thread busy whether or not
 * anyone can see it. Put the ref on a container and, while it is more than 160px off screen, the stylesheet (globals.css,
 * [data-offscreen]) pauses every animation inside it; they pick up where they were when it comes back. `enabled: false`
 * leaves the container running, for motion that is a clock (the river's marks drift in real time).
 */
export function usePauseOffscreen<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled) {
      delete el.dataset.offscreen;
      return;
    }
    const watch = new IntersectionObserver(([entry]) => { el.dataset.offscreen = entry.isIntersecting ? "false" : "true"; }, { rootMargin: "160px 0px" });
    watch.observe(el);
    return () => {
      watch.disconnect();
      delete el.dataset.offscreen;
    };
  }, [enabled]);
  return ref;
}
