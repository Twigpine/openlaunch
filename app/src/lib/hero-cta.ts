/**
 * Whether the home hero's filled "Launch a token" is on screen, for the header's copy of it (one filled blue per
 * screen). The hero reports its own visibility, so the signal survives the hero remounting after load (a light
 * theme load can swap the streamed page for a client render, which left an observer in the header watching a
 * detached node). Null while no hero is mounted.
 */
let onScreen: boolean | null = null;
const listeners = new Set<() => void>();

export function setHeroCtaOnScreen(value: boolean | null): void {
  if (value === onScreen) return;
  onScreen = value;
  for (const listener of listeners) listener();
}

export function heroCtaOnScreen(): boolean | null {
  return onScreen;
}

export function subscribeHeroCta(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
