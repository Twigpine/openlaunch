/**
 * A token's social links, ready to render. The server only stores https websites and bare X handles (metaShared.ts,
 * editAuth.ts); this checks again at the edge where they become links, so a bad row can never become a javascript:
 * or off-shape URL. Pure, so node --test loads it directly.
 */
const X_HANDLE = /^\w{1,15}$/;

export type Socials = { x: string | null; site: string | null; host: string | null };

export function safeSocials(meta: { website: string | null; x_handle: string | null }): Socials {
  const x = meta.x_handle && X_HANDLE.test(meta.x_handle) ? meta.x_handle : null;
  let site: string | null = null;
  let host: string | null = null;
  if (meta.website) {
    try {
      const u = new URL(meta.website);
      if (u.protocol === "https:" && !u.username && !u.password) {
        site = u.toString();
        host = u.hostname.replace(/^www\./, "");
      }
    } catch {
      /* not a URL: no link */
    }
  }
  return { x, site, host };
}
