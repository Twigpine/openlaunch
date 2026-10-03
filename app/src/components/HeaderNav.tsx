"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Navbar, NavBody, MobileNav, MobileNavHeader, MobileNavMenu } from "./navigation-shell";
import Mark, { Wordmark } from "./launchpad/Mark";
import { BRAND_X } from "@/lib/brand";
import ConnectButton from "./ConnectButton";
import ThemeToggle from "./ThemeToggle";
import NotificationSettings from "./NotificationSettings";
import LivePulse from "./launchpad/LivePulse";
import { BridgeButton, BridgeProvider } from "./bridge/BridgeProvider";

const NAV = [
  { href: "/", label: "Launchpad" },
  { href: "/feed", label: "Posts" },
  { href: "/rules", label: "How it works" },
  { href: "/agents", label: "Agents" },
  // /me is reached from the wallet menu ("Your workspace") and the footer ("Your dashboard")
];

type Pulse = { visits: number; online: number };

/**
 * Market pages keep a docked, edge-aligned instrument strip. Reading and
 * account pages retain the floating navigation. `Navbar` injects `visible`
 * into its direct children to signal the compact floating state.
 */
export default function HeaderNav({ pulse }: { pulse: Pulse }) {
  const pathname = usePathname();
  const workspace = pathname === "/" || pathname.startsWith("/t/");
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(href));
  const heroCtaOnScreen = useHeroCtaOnScreen(pathname);

  return (
    <BridgeProvider><MotionConfig reducedMotion="user">
      <Navbar className="top-0" docked={workspace}>
        <Desktop workspace={workspace} pulse={pulse} isActive={isActive} quietCta={heroCtaOnScreen} />
        <Mobile key={pathname} workspace={workspace} pulse={pulse} isActive={isActive} />
      </Navbar>
    </MotionConfig></BridgeProvider>
  );
}

/**
 * One filled blue per screen: while the home hero's own "Launch a token" is in
 * view, the header's copy of it stays a hairline utility. Watches `#hero-cta`;
 * on any other route (or before the hero mounts) the header CTA is the filled one.
 */
function useHeroCtaOnScreen(pathname: string) {
  // Assume it is on screen on the home page's first paint, so the header CTA
  // does not flash filled before the observer's first callback.
  const [onScreen, setOnScreen] = useState(() => pathname === "/");
  useEffect(() => {
    const el = document.getElementById("hero-cta");
    if (!el) return;
    // any visible sliver counts (occlusion by the floating pill is ignored on purpose):
    // the header fills only once the hero CTA has fully left the viewport
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [pathname]);
  // the observer only runs where the hero exists; elsewhere the stale value must not leak
  return pathname === "/" && onScreen;
}

// ── desktop ──────────────────────────────────────────────────────────────────

function Desktop({ visible = false, workspace, pulse, isActive, quietCta }: { visible?: boolean; workspace: boolean; pulse: Pulse; isActive: (href: string) => boolean; quietCta: boolean }) {
  return (
    <NavBody
      visible={visible}
      className={cn(
        "border border-line transition-colors",
        // Workspaces share the market gutters; other routes retain their
        // readable page-column alignment and floating pill.
        workspace
          ? "workspace-shell max-w-none border-x-0 border-t-0 bg-paper dark:bg-paper"
          : visible
          ? "max-w-6xl px-3 bg-card/90 dark:bg-card/90"
          : "max-w-none border-x-0 border-t-0 px-[max(16px,calc((100vw-1120px)/2))] bg-paper dark:bg-paper",
      )}
    >
      <Link href="/" className="relative z-20 flex items-center gap-2" aria-label="openlaunch.lol home">
        <Mark size={24} />
        {/* the wordmark and pulse are the first things to give way when the strip contracts */}
        {!visible ? <Wordmark /> : null}
      </Link>
      {!visible ? (
        <div className="relative z-20 ml-1 hidden xl:block">
          <LivePulse initial={pulse} />
        </div>
      ) : null}

      <NavLinks isActive={isActive} compact={visible} />

      <div className={cn("relative z-20 flex items-center gap-2", !workspace && "ml-auto")}>
        <BridgeButton />
        <NotificationSettings />
        <ThemeToggle />
        <ConnectButton />
        {/* while the hero's CTA is on screen it owns the one filled blue; this one fills in once that has scrolled away */}
        <LaunchCta compact={visible} quiet={quietCta} />
      </div>
    </NavBody>
  );
}

/**
 * Nav links in normal flex flow between the brand and the utilities. All three
 * groups share the available width when the strip contracts to 800px.
 * One shared hover pill slides
 * between items via layoutId; under reduced motion it simply appears.
 */
function NavLinks({ isActive, compact = false }: { isActive: (href: string) => boolean; compact?: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const reduced = useReducedMotion();
  return (
    <nav aria-label="Primary" onMouseLeave={() => setHovered(null)} className="mx-auto hidden items-center gap-0.5 px-2 lg:flex">
      {NAV.map((n, i) => {
        const active = isActive(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
            aria-current={active ? "page" : undefined}
            className={cn("relative h-9 inline-flex items-center rounded-full text-sm font-medium whitespace-nowrap transition-colors", compact ? "px-2" : "px-3.5", active ? "text-ink" : "text-body hover:text-ink")}
          >
            {hovered === i ? (
              reduced ? (
                <span className="absolute inset-0 rounded-full bg-line" />
              ) : (
                <motion.span layoutId="nav-hover" className="absolute inset-0 rounded-full bg-line" transition={{ type: "spring", stiffness: 400, damping: 32 }} />
              )
            ) : active ? (
              <span className="absolute inset-0 rounded-full border border-line-strong" />
            ) : null}
            <span className="relative z-10">{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The one filled control in the header. Shortens to "Launch" while the strip
 * is floating; `quiet` drops it to the hairline-utility recipe when another
 * filled blue already owns the screen (the home hero at rest).
 */
function LaunchCta({ compact = false, block = false, quiet = false, onNavigate }: { compact?: boolean; block?: boolean; quiet?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href="/launch"
      onClick={onNavigate}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-semibold whitespace-nowrap transition-colors",
        quiet ? "border border-line bg-card text-body hover:text-ink hover:border-line-strong" : "bg-brand text-inverse hover:bg-brand-strong",
        block ? "w-full min-h-12 rounded-xl text-[15px]" : "h-9 rounded-full text-[13px]",
        block ? "" : compact ? "px-3.5" : "px-4",
      )}
    >
      {/* at lg (1024–1279) the rest-state strip has no room for the long label beside five links */}
      {compact ? (
        "Launch"
      ) : (
        <>
          Launch<span className="hidden xl:inline"> a token</span>
        </>
      )}
      <ArrowRight size={14} strokeWidth={2.4} aria-hidden />
    </Link>
  );
}

/** The official account: a labelled row in the mobile menu (the desktop strip stays uncrowded; the footer carries it). */
function XLink({ block = false }: { block?: boolean }) {
  const href = `https://x.com/${BRAND_X}`;
  const icon = (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
  if (block) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="min-h-12 px-3 flex items-center justify-between gap-3 rounded-xl text-base font-medium text-ink hover:bg-line">
        <span>@{BRAND_X} <span className="text-muted">· on X</span></span>
        {icon}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`@${BRAND_X} on X`} title={`@${BRAND_X} on X`} className="h-9 w-9 inline-flex items-center justify-center rounded-full border border-line bg-card text-body hover:text-ink hover:border-line-strong">
      {icon}
    </a>
  );
}

// ── mobile ───────────────────────────────────────────────────────────────────

function Mobile({ visible = false, workspace, pulse, isActive }: { visible?: boolean; workspace: boolean; pulse: Pulse; isActive: (href: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const dismissMenu = useCallback(() => {
    setOpen(false);
    menuToggle.current?.focus();
  }, []);
  return (
    <MobileNav
      visible={visible}
      docked={workspace}
      className={cn(
        "border border-line transition-colors",
        // same story as desktop: full-bleed hairline row at rest, pill while floating
        workspace ? "workspace-shell max-w-none border-x-0 border-t-0 bg-paper dark:bg-paper" : visible ? "max-w-[calc(100vw-2rem)] bg-card/90 dark:bg-card/90" : "max-w-none border-x-0 border-t-0 bg-paper dark:bg-paper",
      )}
    >
      <MobileNavHeader>
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2 py-1" aria-label="openlaunch.lol home" onClick={() => setOpen(false)}>
            <Mark size={24} />
            <Wordmark />
          </Link>
          {/* self-hides below sm; on tablets it rides beside the wordmark as on desktop */}
          <LivePulse initial={pulse} />
        </div>
        <button
          type="button"
          ref={menuToggle}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-menu"
          className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-line bg-card text-ink hover:border-line-strong"
        >
          {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
        </button>
      </MobileNavHeader>

      <MobileNavMenu isOpen={open} onClose={dismissMenu} className="-inset-x-px top-14 gap-1 rounded-t-none rounded-b-2xl border border-t-0 border-line bg-card px-2 py-2 shadow-none">
        <div id="mobile-menu" className="flex w-full flex-col gap-1">
          {NAV.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn("min-h-12 px-3 inline-flex items-center rounded-xl text-base font-medium", active ? "bg-line text-ink" : "text-body hover:bg-line hover:text-ink")}
              >
                {n.label}
              </Link>
            );
          })}
          <LivePulse initial={pulse} block />
          <div className="my-1 border-t border-line" aria-hidden />
          <XLink block />
          <BridgeButton block onOpen={() => setOpen(false)} />
          <NotificationSettings block />
          <ThemeToggle block />
          <ConnectButton block onNavigate={() => setOpen(false)} />
          <LaunchCta block onNavigate={() => setOpen(false)} />
        </div>
      </MobileNavMenu>
    </MobileNav>
  );
}
