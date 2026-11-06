# Solana review workspace

The first integration stays at `/solana`, separate from the EVM launchpad until verification. This was explicitly selected for the review build. Existing EVM wallet, routes, storage, charts, launch and fee flows are unchanged.

## Direction contract

THESIS: make irreversible launch terms and actual custody readable before requesting a wallet signature. Extend Openlaunch, not a new visual identity.

OWN-WORLD: inherit the existing Geist typography, paper/card/ink theme tokens, blue action color, shared buttons and inputs. Use ordinary lists and definition rows, not decorative dashboards.

STORY: inspect deployment status, connect a Solana wallet, prepare immutable terms, review and activate, then inspect real reserves, trade or claim earned fees. An uncertain submission remains visible until reconciled.

FIRST VIEWPORT: title and cluster status, wallet connection, a compact pool lookup and launch entry. Pool detail puts market facts beside the trade form; on mobile facts precede the form. Supply, virtual pricing offset and real SOL are separate labels.

FORM: narrow extension of the incumbent transaction flow, with a separate route explicitly approved by the user. No concept roll or replacement brand.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance. The existing identity is inherited from `app/src/components/ui.ts` and `app/src/app/globals.css`; no new raster assets or visual-system changes are introduced.

## Boundaries

No mock balances, fabricated candles, external listing claims, private-key inputs, hidden signing, or automatic retry of an uncertain transaction. Mainnet remains blocked by an unapproved deployment manifest. The first review workspace is not a claim that the broader production rollout or audit is complete.
