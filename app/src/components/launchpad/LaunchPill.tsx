"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Rocket } from "lucide-react";
import { heroCtaOnScreen, subscribeHeroCta } from "@/lib/hero-cta";
import styles from "./LaunchPill.module.css";

/**
 * A phone's way to launch once the hero's own button has scrolled away. The header has no Launch button on a phone (it lives
 * in the menu), so without this the page has nothing to act on after the hero. The hero reports whether its button is on screen
 * (HeroCtaLink), so the pill and that button are never on screen together: one filled blue per screen. It steps aside for the
 * footer, so it never covers a footer link. From 640px the header carries the button and this is not drawn.
 */
export default function LaunchPill() {
  const heroButton = useSyncExternalStore(subscribeHeroCta, heroCtaOnScreen, () => null);
  const [atFooter, setAtFooter] = useState(false);
  useEffect(() => {
    const footer = document.getElementById("site-footer");
    if (!footer) return;
    const watch = new IntersectionObserver(([entry]) => setAtFooter(entry.isIntersecting));
    watch.observe(footer);
    return () => watch.disconnect();
  }, []);
  // `false`: the hero is mounted and its button has fully left the screen (null: no hero yet)
  if (heroButton !== false || atFooter) return null;
  return (
    <Link href="/launch" className={styles.pill}>
      <span aria-hidden="true" className={styles.tile}><Rocket size={15} strokeWidth={2.2} /></span>
      Launch a token
    </Link>
  );
}
