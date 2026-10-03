"use client";

// Original Openlaunch navigation primitives. This replaces the previous
// registry component while keeping the composition API used by HeaderNav.
import { Children, cloneElement, isValidElement, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

type SlotProps = { children: ReactNode; className?: string };
type SurfaceProps = SlotProps & { visible?: boolean; docked?: boolean };

// React only re-renders when the threshold changes, not on every scroll pixel.
function subscribeToScroll(notify: () => void) {
  window.addEventListener("scroll", notify, { passive: true });
  return () => window.removeEventListener("scroll", notify);
}
const isFloating = () => window.scrollY > 100;
const serverIsFloating = () => false;

export function Navbar({ children, className, docked = false }: SlotProps & { docked?: boolean }) {
  const scrolled = useSyncExternalStore(subscribeToScroll, isFloating, serverIsFloating);
  const visible = scrolled && !docked;
  return (
    <header className={cn("sticky top-0 z-40 w-full", className)}>
      {Children.map(children, (child) => isValidElement(child)
        ? cloneElement(child as ReactElement<{ visible?: boolean }>, { visible })
        : child)}
    </header>
  );
}

function NavigationSurface({ children, className, visible = false, mobile = false, docked = false }: SurfaceProps & { mobile?: boolean }) {
  const reduced = useReducedMotion();
  const width = visible ? (mobile ? "90%" : "40%") : "100%";
  return (
    <motion.div
      initial={false}
      animate={{
        width,
        y: visible ? 20 : 0,
        borderRadius: visible ? 28 : 0,
        backdropFilter: visible ? "blur(10px)" : "blur(0px)",
        ...(mobile && !docked ? { paddingLeft: visible ? 12 : 16, paddingRight: visible ? 12 : 16 } : {}),
      }}
      transition={{ duration: reduced ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      style={mobile ? undefined : { minWidth: 800 }}
      className={cn(
        "relative mx-auto w-full items-center justify-between bg-paper py-2",
        mobile ? "z-50 flex flex-col lg:hidden" : "z-[60] hidden flex-row px-4 lg:flex",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

export function NavBody(props: SurfaceProps) {
  return <NavigationSurface {...props} />;
}

export function MobileNav(props: SurfaceProps) {
  return <NavigationSurface {...props} mobile />;
}

export function MobileNavHeader({ children, className }: SlotProps) {
  return <div className={cn("flex w-full items-center justify-between", className)}>{children}</div>;
}

export function MobileNavMenu({ children, className, isOpen, onClose }: SlotProps & { isOpen: boolean; onClose: () => void }) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Nested controls may handle Escape first (for example the wallet menu).
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence initial={false}>
      {isOpen ? (
        <motion.div
          key="mobile-navigation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          className={cn(
            "absolute inset-x-0 top-16 z-50 flex flex-col gap-2 rounded-2xl border border-line bg-card p-2",
            "max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain",
            className,
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// Optional composition helpers, kept compatible with the shell's public API.
export function NavItems({ items, className, onItemClick }: { items: { name: string; link: string }[]; className?: string; onItemClick?: () => void }) {
  return (
    <nav aria-label="Primary" className={cn("flex items-center gap-1", className)}>
      {items.map(({ name, link }) => (
        <a key={link} href={link} onClick={onItemClick} className="rounded-full px-3 py-2 text-sm font-medium text-body transition-colors hover:bg-line hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none">
          {name}
        </a>
      ))}
    </nav>
  );
}

export function MobileNavToggle({ isOpen, onClick }: { isOpen: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={isOpen} aria-label={isOpen ? "Close menu" : "Open menu"} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line text-ink hover:bg-line">
      {isOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
    </button>
  );
}
