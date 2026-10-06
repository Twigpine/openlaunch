"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, BookOpen, Bot, ChartCandlestick, ChevronRight, Menu, MessagesSquare, Rocket, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/lib/command-palette";
import { heroCtaOnScreen, subscribeHeroCta } from "@/lib/hero-cta";
import CommandPalette from "./CommandPalette";
import { Navbar, NavBody, MobileNav, MobileNavHeader, MobileNavMenu } from "./navigation-shell";
import Mark, { Wordmark } from "./launchpad/Mark";
import { BRAND_X } from "@/lib/brand";
import ConnectButton from "./ConnectButton";
import ThemeToggle from "./ThemeToggle";
import NotificationSettings from "./NotificationSettings";
import LivePulse from "./launchpad/LivePulse";
import { BridgeButton, BridgeProvider } from "./bridge/BridgeProvider";

const NAV = [
  { href: "/", label: "Launchpad", hint: "Live launches, charts and trades", icon: ChartCandlestick },
  { href: "/feed", label: "Posts", hint: "What people say about tokens", icon: MessagesSquare },
  { href: "/rules", label: "How it works", hint: "What a launch does and costs", icon: BookOpen },
  { href: "/agents", label: "Agents", hint: "Launch and trade from an agent", icon: Bot },
  // /me is reached from the wallet menu ("Your workspace") and the footer ("Your dashboard")
];

type Pulse = { visits: number; online: number };

/** The glass the strip turns into while it floats: translucent card, a hairline of light on top, a soft drop shadow. */
const FLOATING = "bg-card/80 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),var(--shadow-card-hover)] dark:bg-card/75";

/**
 * Site header: a floating instrument strip. Full-width hairline row at rest;
 * past 100px of scroll the navigation shell contracts it into a
 * centred pill that rides over the content, keeping the launch CTA and wallet
 * one reach away. `Navbar` injects `visible` into its direct children, which
 * is how the strip knows to drop the wordmark and shorten the CTA when it is
 * floating and has ~800px to work with.
 */
export default function HeaderNav({ pulse }: { pulse: Pulse }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(href));
  const heroCtaOnScreen = useHeroCtaOnScreen(pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(setSearchOpen);

  return (
    <BridgeProvider><MotionConfig reducedMotion="user">
      <Navbar className="top-0">
        <Desktop pulse={pulse} isActive={isActive} quietCta={heroCtaOnScreen} onSearch={openSearch} />
        <Mobile key={pathname} pulse={pulse} isActive={isActive} onSearch={openSearch} />
      </Navbar>
      {/* outside Navbar: it injects `visible` into its direct children */}
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </MotionConfig></BridgeProvider>
  );
}

/** ⌘K or Ctrl+K toggles search from anywhere; "/" opens it unless the visitor is typing in a field. */
function useSearchShortcut(setOpen: React.Dispatch<React.SetStateAction<boolean>>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target as HTMLElement | null)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

const noSubscribe = () => () => {};
/** "⌘K" on Apple devices, "Ctrl K" elsewhere; the server renders the Apple form and the client corrects it after hydration. */
function useShortcutLabel(): string {
  return useSyncExternalStore(noSubscribe, () => (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘K" : "Ctrl K"), () => "⌘K");
}

/**
 * The header's tools in one capsule: search, bridge, notifications and theme read as one group beside the wallet and
 * the launch button, instead of four separate frames. Each tool inside is a borderless 30px button.
 */
function Rail({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="group" aria-label="Tools" className={cn("flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-card p-[2px]", className)}>
      {children}
    </div>
  );
}

/**
 * The header's way into search: the first tool in the rail, naming its shortcut beside the icon while the strip
 * rests at full width (xl and up). The home redesign gives search a proper field.
 */
function SearchTrigger({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  const shortcut = useShortcutLabel();
  return (
    <button type="button" onClick={onClick} aria-label={`Search tokens and pages (${shortcut})`} title={`Search (${shortcut})`} className="inline-flex h-7.5 min-w-7.5 shrink-0 items-center justify-center gap-1.5 rounded-full px-[7px] text-body transition-colors hover:bg-line hover:text-ink motion-reduce:transition-none">
      <Search size={16} aria-hidden />
      {compact ? null : <kbd aria-hidden="true" className="hidden rounded-md border border-line bg-paper px-1.5 font-sans text-[10px] font-medium leading-4 text-muted xl:inline">{shortcut}</kbd>}
    </button>
  );
}

/**
 * One filled blue per screen: while the home hero's own "Launch a token" is in
 * view, the header's copy of it stays a hairline utility. The hero reports its
 * visibility itself (HeroCtaLink, `#hero-cta`); on any other route the header
 * CTA is the filled one.
 */
function useHeroCtaOnScreen(pathname: string) {
  const onScreen = useSyncExternalStore(subscribeHeroCta, heroCtaOnScreen, () => null);
  // before the hero's first report, assume it is on screen on the home page so the header CTA does not flash filled
  return pathname === "/" && (onScreen ?? true);
}

// ── desktop ──────────────────────────────────────────────────────────────────

function Desktop({ visible = false, pulse, isActive, quietCta, onSearch }: { visible?: boolean; pulse: Pulse; isActive: (href: string) => boolean; quietCta: boolean; onSearch: () => void }) {
  return (
    <NavBody
      visible={visible}
      className={cn(
        "border border-line transition-colors",
        // At rest: a full-width hairline ROW, content padded to the page column
        // (--page-max and --page-pad in globals.css). Floating: a glass pill
        // over the content. The shell animates the width and corner radius together.
        visible
          ? `max-w-6xl px-2.5 ${FLOATING}`
          : "max-w-none border-x-0 border-t-0 px-[max(var(--page-pad),calc((100vw_-_var(--page-max))/2_+_var(--page-pad)))] bg-paper dark:bg-paper",
      )}
    >
      {/* at rest, the bottom hairline catches a little brand light in the middle */}
      {!visible ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-[linear-gradient(90deg,transparent,var(--color-brand),transparent)] opacity-25 dark:opacity-45" /> : null}
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

      <div className="relative z-20 ml-auto flex items-center gap-2">
        <Rail>
          <SearchTrigger onClick={onSearch} compact={visible} />
          {/* the floating pill is 800px wide: the bridge gives up its label there */}
          <BridgeButton compact={visible} />
          <NotificationSettings />
          <ThemeToggle />
        </Rail>
        <ConnectButton />
        {/* while the hero's CTA is on screen it owns the one filled blue; this one fills in once that has scrolled away */}
        <LaunchCta compact={visible} quiet={quietCta} />
      </div>
    </NavBody>
  );
}

/**
 * Nav links in normal flex flow between the brand and the utilities. The page you
 * are on sits in a filled pill with a small lamp of brand light on its top edge;
 * it glides to the new link when you navigate. A fainter pill follows the pointer
 * between the other links. Under reduced motion both simply appear.
 */
function NavLinks({ isActive, compact = false }: { isActive: (href: string) => boolean; compact?: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const reduced = useReducedMotion();
  const glide = reduced ? { duration: 0 } : ({ type: "spring", stiffness: 420, damping: 34 } as const);
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
            className={cn("relative h-9 inline-flex items-center rounded-full text-sm font-medium whitespace-nowrap transition-colors", compact ? "px-2.5" : "px-3.5", active ? "text-ink" : "text-body hover:text-ink")}
          >
            {hovered === i && !active ? <motion.span layoutId="nav-hover" transition={glide} className="absolute inset-0 rounded-full bg-line/60" /> : null}
            {active ? (
              <motion.span layoutId="nav-active" transition={glide} className="absolute inset-0 rounded-full bg-line">
                <span aria-hidden="true" className="absolute -top-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-brand" />
                <span aria-hidden="true" className="absolute -top-2 left-1/2 h-4 w-10 -translate-x-1/2 rounded-full bg-brand/40 blur-md" />
              </motion.span>
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
        "group relative inline-flex items-center justify-center gap-1.5 overflow-hidden font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.97] motion-reduce:active:scale-100",
        // filled: the same rocket and sheen as the hero button it takes over from
        quiet ? "border border-line bg-card text-body hover:text-ink hover:border-line-strong" : "bb-sheen bg-brand text-inverse shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:bg-brand-strong",
        block ? "w-full min-h-12 rounded-xl text-[15px]" : "h-9 rounded-full text-[13px]",
        block ? "" : compact ? "px-3.5" : "px-4",
      )}
    >
      <Rocket size={14} strokeWidth={2.2} aria-hidden="true" className="shrink-0 transition-transform duration-300 ease-out group-hover:translate-x-px group-hover:-translate-y-px group-hover:-rotate-12 motion-reduce:transition-none" />
      {/* at lg (1024–1279) the rest-state strip has no room for the long label beside five links; the phone menu has the whole width */}
      {compact ? (
        "Launch"
      ) : block ? (
        "Launch a token"
      ) : (
        // one flex item, so the button's icon gap never lands between "Launch" and "a token"
        <span>Launch<span className="hidden xl:inline"> a token</span></span>
      )}
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
    // a settings row like its neighbours: mark in the 17px icon column, label, then the arrow that says it leaves the site
    return (
      <a href={href} target="_blank" rel="noreferrer" className="min-h-12 px-3 flex items-center gap-3 rounded-xl text-[15px] font-medium text-ink transition-colors hover:bg-line motion-reduce:transition-none">
        <span className="grid w-[17px] shrink-0 place-items-center">{icon}</span>
        <span>@{BRAND_X} <span className="text-muted">on X</span></span>
        <ArrowUpRight size={15} aria-hidden className="ml-auto text-muted" />
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

/** Holds the page still while the phone menu is open, so a swipe scrolls the menu, not what is under it. */
function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, [locked]);
}

const mobileTool = "h-9 w-9 inline-flex items-center justify-center rounded-full text-ink transition-colors hover:bg-line motion-reduce:transition-none";

function Mobile({ visible = false, pulse, isActive, onSearch }: { visible?: boolean; pulse: Pulse; isActive: (href: string) => boolean; onSearch: () => void }) {
  const [open, setOpen] = useState(false);
  // MotionConfig's reducedMotion only drops transforms, so the fades below are zeroed by hand, as the menu card's are
  const reduced = useReducedMotion();
  const menuToggle = useRef<HTMLButtonElement>(null);
  const dismissMenu = useCallback(() => {
    setOpen(false);
    menuToggle.current?.focus();
  }, []);
  useScrollLock(open);
  return (
    <>
      {/* the page dims behind the open menu; a tap on it closes the menu */}
      <AnimatePresence>
        {open ? <motion.div key="scrim" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.15 }} onClick={dismissMenu} className="fixed inset-0 z-40 bg-scrim/35 backdrop-blur-[2px] lg:hidden dark:bg-scrim/60" /> : null}
      </AnimatePresence>
      <MobileNav
        visible={visible}
        className={cn(
          "border border-line transition-colors",
          // same story as desktop: full-bleed hairline row at rest, glass pill while floating
          visible ? `max-w-[calc(100vw-2rem)] ${FLOATING}` : "max-w-none border-x-0 border-t-0 bg-paper dark:bg-paper",
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
          <Rail>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onSearch();
              }}
              aria-label="Search tokens and pages"
              className={mobileTool}
            >
              <Search size={18} aria-hidden />
            </button>
            <button
              type="button"
              ref={menuToggle}
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobile-menu"
              className={cn(mobileTool, open ? "bg-line" : "")}
            >
              {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </Rail>
        </MobileNavHeader>

        {/* a card of its own just under the strip, so it reads the same whether the strip rests or floats */}
        <MobileNavMenu isOpen={open} onClose={dismissMenu} className={cn("top-[calc(100%+0.5rem)] gap-0 rounded-3xl border border-line bg-raised p-2 shadow-dialog", visible ? "inset-x-0" : "inset-x-3")}>
          <div id="mobile-menu" className="flex w-full flex-col">
            {NAV.map((n, i) => {
              const active = isActive(n.href);
              const Icon = n.icon;
              return (
                <motion.div key={n.href} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : { duration: 0.18, delay: 0.03 * i }}>
                  <Link
                    href={n.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn("flex min-h-14 items-center gap-3 rounded-2xl px-2.5 py-2 transition-colors motion-reduce:transition-none", active ? "bg-line" : "hover:bg-line")}
                  >
                    <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl border", active ? "border-brand/30 bg-brand-soft text-brand" : "border-line bg-paper text-body")}>
                      <Icon size={17} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-ink">{n.label}</span>
                      <span className="block truncate text-xs text-muted">{n.hint}</span>
                    </span>
                    <ChevronRight size={16} aria-hidden className="shrink-0 text-faint" />
                  </Link>
                </motion.div>
              );
            })}
            <div className="mx-2.5 my-2 border-t border-line" aria-hidden />
            <BridgeButton block onOpen={() => setOpen(false)} />
            <NotificationSettings block />
            <ThemeToggle block />
            <XLink block />
            <div className="mx-2.5 my-2 border-t border-line" aria-hidden />
            <div className="flex flex-col gap-2 px-1">
              <ConnectButton block onNavigate={() => setOpen(false)} />
              <LaunchCta block onNavigate={() => setOpen(false)} />
            </div>
            <LivePulse initial={pulse} block />
          </div>
        </MobileNavMenu>
      </MobileNav>
    </>
  );
}
