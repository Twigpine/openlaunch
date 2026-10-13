"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { setHeroCtaOnScreen } from "@/lib/hero-cta";

/** The hero's filled CTA. It reports its own visibility, so the header's copy can stay quiet while it is on screen. */
export default function HeroCtaLink({ id, href, className, children }: { id: string; href: string; className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // any visible sliver counts (occlusion by the floating pill is ignored on purpose):
    // the header fills only once the hero CTA has fully left the viewport
    const io = new IntersectionObserver(([entry]) => setHeroCtaOnScreen(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => { io.disconnect(); setHeroCtaOnScreen(null); };
  }, []);
  return <Link ref={ref} id={id} href={href} className={className}>{children}</Link>;
}
