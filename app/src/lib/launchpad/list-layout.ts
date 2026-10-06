/**
 * How the home market list draws its tokens: rows (the default) or cards. The choice lives in a first-party
 * cookie so the server renders the same layout the visitor picked last time, with no swap after load.
 */
export type ListLayout = "list" | "cards";

export const LAYOUT_COOKIE = "ol_layout";

export function parseLayout(value: string | undefined | null): ListLayout {
  return value === "cards" ? "cards" : "list";
}

/** The cookie string to write when the visitor picks a layout: a year, the whole site, never sent cross-site. */
export function layoutCookie(layout: ListLayout): string {
  return `${LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;
}
