# Admin sign-in

`/admin` (reported posts, profiles, season points, the Boosted lane, community pairs) is for the wallets in the
`ADMIN_WALLETS` secret. Code: `app/src/lib/admin/`.

## Signing in

Without an admin session, `/admin` is a sign-in card and nothing else: no panel and no admin data is rendered.

1. Connect an admin wallet and press **Sign in**.
2. The server issues a nonce (`POST /api/admin/nonce`, single use, 5 minutes) with its own time.
3. The wallet signs a standard Sign-In with Ethereum message (EIP-4361) for `openlaunch.lol`, on Base. Wallets that
   support the standard compare its domain with the site asking for the signature and warn on a mismatch, so a
   look-alike site cannot quietly collect an openlaunch sign-in.
4. `POST /api/admin/session` accepts only the exact text the site builds: this domain and URL, Base, the fixed
   statement, a nonce this server issued, issued within 5 minutes. The signer must be in `ADMIN_WALLETS`. The nonce
   must be open before the signature is checked (a made-up one costs no RPC) and is spent only after it checks out.
   Smart wallets are checked on Base.

## The session

- An 8-hour session, never extended. A random 32-byte token sits in a `__Host-ol_admin` cookie: HttpOnly (no page
  script can read it), Secure, SameSite=Strict, Path=/, no Domain (bound to openlaunch.lol exactly, never basebid.lol).
- The database (`bb_admin_sessions`) keeps only the token's SHA-256, a rough device label ("Chrome · macOS") and the
  times. No IP, no user agent.
- Every request checks that the session exists, is not ended, has not expired, and that its wallet is still in
  `ADMIN_WALLETS`. A request never ends sessions itself: while a secret change rolls out, a machine still on the old
  list would end a newly added admin's. Ending a removed wallet's sessions is done at boot (see Ops).
- At most 5 sessions per wallet; signing in again ends the oldest.
- **Sessions** on `/admin` lists this wallet's sessions. Each can be ended, or all of them with **Sign out everywhere**.
  Sign out ends the session on the server, not only in the browser.
- Sign-in, sign-out and every admin action only accept requests from the site's own pages (the Origin header), on top
  of SameSite=Strict. An action must name the wallet that signed it; one without is refused, never treated as a read.
  Sign-in is limited to 10 a minute per IP and per wallet.
- Opening `/admin` from a link on another site sends no Strict cookie on that first load. The card asks the server
  from inside the page and loads the panels when a session is there, so there is no second signature.

## What needs what

| | Session | Its own wallet signature |
|---|---|---|
| The admin page and the admin reads (reported posts, Boost stats, the profile queue, the season boards) | yes | no |
| Every admin action (hide, list, review, season actions, profile moderation) | yes, same wallet | yes, single-use nonce |
| A token's creator muting their own token's thread | no | yes |

A stolen cookie cannot act without the wallet, and a phished action signature cannot act without the cookie.

## Ops

- **Remove an admin**: take the wallet out of `ADMIN_WALLETS` (`fly secrets set ADMIN_WALLETS=… -a basebid`). The
  secret change restarts the machines, and at boot every session of a wallet no longer listed is ended for good
  (retried if the database is briefly unreachable): adding the wallet back later revives none of them. Until a machine
  restarts it still has the old list, so the swap takes as long as the restart (a minute or so).
- **Add an admin**: add the wallet to `ADMIN_WALLETS` the same way, and sign in once both machines have restarted.
- **Adding back a removed wallet**, or if the log shows `[admin] session sweep failed`: end that wallet's old sessions
  first, `UPDATE bb_admin_sessions SET revoked_at = now() WHERE wallet = '<address, lowercase>' AND revoked_at IS NULL;`
  (the boot sweep normally did it already; this covers a sweep that failed all its tries).
- **End every session at once** (a lost device):
  `UPDATE bb_admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL;`
- Sign-ins and sign-outs are logged as `[admin] signed in: <wallet> (<device>)` and `[admin] signed out: …`.
