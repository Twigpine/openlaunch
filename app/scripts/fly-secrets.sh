#!/usr/bin/env bash
# Stage runtime secrets on Fly for this app, reading EVERY value independently from one env file
# (default ./.env.production — see .env.example for the keys; never committed, never printed).
# DATABASE_URL is set by `fly postgres attach`, the image bucket by `fly storage create` — not here.
# Staged secrets apply on the next `fly deploy`. Re-runnable.
#   FLY_APP     = Fly app name            (default: basebid — the live openlaunch.lol app)
#   SECRETS_ENV = file to read            (default: .env.production)
#   --dry-run   = print what would be staged, do not call fly
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${FLY_APP:-basebid}
FILE=${SECRETS_ENV:-.env.production}
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
[ -f "$FILE" ] || { echo "missing $FILE — copy .env.example to $FILE and fill in the production values"; exit 1; }

val() { { grep -E "^$1=" "$FILE" || true; } | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }

REQUIRED=(BASE_RPC_URL ROBINHOOD_RPC_URL NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_LAUNCH_FACTORY NEXT_PUBLIC_LAUNCH_LOCKER LAUNCH_DEPLOY_BLOCK NEXT_PUBLIC_LAUNCH_FACTORY_ROBINHOOD NEXT_PUBLIC_LAUNCH_LOCKER_ROBINHOOD LAUNCH_DEPLOY_BLOCK_ROBINHOOD)
# Arc: ARC_RPC_URL (Alchemy) and the contract settings become required once the factory is deployed there; until then the site shows
# Arc as "Coming soon" and the server falls back to the public RPC.
OPTIONAL=(ARC_RPC_URL NEXT_PUBLIC_LAUNCH_FACTORY_ARC NEXT_PUBLIC_LAUNCH_LOCKER_ARC LAUNCH_DEPLOY_BLOCK_ARC ELYSIUM_RPC_URL NEXT_PUBLIC_LAUNCH_FACTORY_ELYSIUM NEXT_PUBLIC_LAUNCH_LOCKER_ELYSIUM LAUNCH_DEPLOY_BLOCK_ELYSIUM LAUNCH_SYNC_CONFIRMATIONS_ELYSIUM BASE_B20_RPC_URL LAUNCH_SYNC_CONFIRMATIONS LAUNCH_SYNC_CONFIRMATIONS_ARC LAUNCH_SYNC_LOOP ADMIN_WALLETS IMAGE_PUBLIC_BASE)
# Once the Arc factory is set, its locker, deploy block and RPC are required too: without the deploy block the indexer never
# runs for Arc and the site would show a chain it does not index.
if [ -n "$(val NEXT_PUBLIC_LAUNCH_FACTORY_ARC)" ]; then REQUIRED+=(NEXT_PUBLIC_LAUNCH_LOCKER_ARC LAUNCH_DEPLOY_BLOCK_ARC ARC_RPC_URL); fi
# Elysium: the same rule (ELYSIUM_RPC_URL = Alchemy elysium-mainnet; the public node is shared by everyone).
if [ -n "$(val NEXT_PUBLIC_LAUNCH_FACTORY_ELYSIUM)" ]; then REQUIRED+=(NEXT_PUBLIC_LAUNCH_LOCKER_ELYSIUM LAUNCH_DEPLOY_BLOCK_ELYSIUM ELYSIUM_RPC_URL); fi

args=(); missing=()
for k in "${REQUIRED[@]}"; do v=$(val "$k"); if [ -n "$v" ]; then args+=("$k=$v"); echo "  staged $k"; else missing+=("$k"); fi; done
for k in "${OPTIONAL[@]}"; do v=$(val "$k"); if [ -n "$v" ]; then args+=("$k=$v"); echo "  staged $k"; else echo "  skip   $k (not set)"; fi; done
if [ ${#missing[@]} -gt 0 ]; then echo "missing required keys in $FILE: ${missing[*]}"; exit 1; fi

if [ $DRY -eq 1 ]; then echo "dry run: ${#args[@]} secrets would be staged on app '$APP' (values not shown)"; exit 0; fi
fly secrets set -a "$APP" --stage "${args[@]}" >/dev/null
echo "done: ${#args[@]} secrets staged on '$APP'. NEXT_PUBLIC_LAUNCH_* are also BUILD args (see the fly.toml header)."
