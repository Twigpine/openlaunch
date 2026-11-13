#!/usr/bin/env bash
# Deploy a tagged openlaunch release to Fly (app `basebid`). From the repository root or from app/:
#   app/scripts/deploy.sh             # every check below, then the deploy, then a live check of /api/health
#   app/scripts/deploy.sh --dry-run   # every check below, then print the fly command; deploys nothing
#
# It deploys only a commit that:
#   - is main, identical to origin/main, with no local changes and no untracked files (the Docker build context is app/,
#     so anything lying around there would be shipped);
#   - carries the annotated tag v<app/package.json version>, and GitHub has that same tag on that same commit.
# The factory and locker addresses come from contracts/deployments/*.json after each file's SHA-256 matches
# contracts/deployed.lock (the guard refuses any change to that lock), so a build can only get the verified addresses.
# It never creates or moves a tag, pushes, bumps a version or reads a secret: runtime secrets stay in Fly
# (scripts/fly-secrets.sh) and everything passed here is public.
set -euo pipefail

APP="basebid"
SITE="https://openlaunch.lol"
DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
die() { echo "deploy: $*" >&2; exit 1; }

# ── the commit ────────────────────────────────────────────────────────────────
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "check out main first"
[ -z "$(git status --porcelain --untracked-files=all)" ] || die "the working tree has changes or untracked files; the build would ship them"
git fetch --quiet --tags origin main || die "could not fetch origin"
SHA="$(git rev-parse HEAD)"
[ "$SHA" = "$(git rev-parse origin/main)" ] || die "main is not origin/main (pull, or push the release PR's merge first)"

# ── the release tag ───────────────────────────────────────────────────────────
VERSION="$(node -p 'require("./app/package.json").version')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "app/package.json version '$VERSION' is not major.minor.patch"
TAG="v$VERSION"
[ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null || true)" = "tag" ] || die "no annotated tag $TAG here (git tag -a $TAG -m \"openlaunch $TAG\" $SHA)"
[ "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$SHA" ] || die "$TAG is not on this commit"
REMOTE="$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)"
[ "$REMOTE" = "$SHA" ] || die "GitHub's $TAG is not this commit (push the tag: git push origin $TAG)"

# ── the contract addresses, from the hash-pinned deployment records ──────────
LOCK="contracts/deployed.lock"
addr() { # chain, field → address, only after the record's hash matches the lock
  local file="contracts/deployments/launchpad-$1.json" want got value
  want="$(awk -v f="$file" '$1 == "sha256" && $3 == f { print $2 }' "$LOCK")"
  [ -n "$want" ] || die "$file is not pinned in $LOCK"
  got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "$file does not match its hash in $LOCK"
  value="$(node -e 'const d = require(process.argv[1]); process.stdout.write(String(d[process.argv[2]] ?? ""))' "./$file" "$2")"
  [[ "$value" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$file has no valid $2"
  printf '%s' "$value"
}
# One assignment each, never inside the array below: a failed $(...) inside an array literal does not stop the script,
# even under set -e, and would deploy an empty address.
BASE_FACTORY="$(addr base LaunchFactory)" || exit 1
BASE_LOCKER="$(addr base LaunchLocker)" || exit 1
ROBINHOOD_FACTORY="$(addr robinhood LaunchFactory)" || exit 1
ROBINHOOD_LOCKER="$(addr robinhood LaunchLocker)" || exit 1
ARC_FACTORY="$(addr arc LaunchFactory)" || exit 1
ARC_LOCKER="$(addr arc LaunchLocker)" || exit 1
ELYSIUM_FACTORY="$(addr elysium LaunchFactory)" || exit 1
ELYSIUM_LOCKER="$(addr elysium LaunchLocker)" || exit 1
BUILD_ARGS=(
  --build-arg "NEXT_PUBLIC_LAUNCH_FACTORY=$BASE_FACTORY"
  --build-arg "NEXT_PUBLIC_LAUNCH_LOCKER=$BASE_LOCKER"
  --build-arg "NEXT_PUBLIC_LAUNCH_FACTORY_ROBINHOOD=$ROBINHOOD_FACTORY"
  --build-arg "NEXT_PUBLIC_LAUNCH_LOCKER_ROBINHOOD=$ROBINHOOD_LOCKER"
  --build-arg "NEXT_PUBLIC_LAUNCH_FACTORY_ARC=$ARC_FACTORY"
  --build-arg "NEXT_PUBLIC_LAUNCH_LOCKER_ARC=$ARC_LOCKER"
  --build-arg "NEXT_PUBLIC_LAUNCH_FACTORY_ELYSIUM=$ELYSIUM_FACTORY"
  --build-arg "NEXT_PUBLIC_LAUNCH_LOCKER_ELYSIUM=$ELYSIUM_LOCKER"
  --build-arg "GIT_SHA=$SHA"
)

echo "deploy: $TAG ($SHA) to $APP"
if [ "$DRY_RUN" = 1 ]; then
  printf 'deploy: dry run, would run in app/:\n  fly deploy -a %s -c fly.toml --remote-only' "$APP"
  printf ' %q' "${BUILD_ARGS[@]}"
  printf '\n'
  exit 0
fi

# ── deploy, then check what production reports ──────────────────────────────
(cd app && fly deploy -a "$APP" -c fly.toml --remote-only "${BUILD_ARGS[@]}")

# Both machines must answer with this release: ten checks in a row, up to three minutes.
ok=0
for _ in $(seq 1 36); do
  if curl -fsS -m 10 "$SITE/api/health" | node -e '
      let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
        const h = JSON.parse(s);
        process.exit(h.version === process.argv[1] && h.commit === process.argv[2] ? 0 : 1);
      });' "$VERSION" "$SHA"; then
    ok=$((ok + 1)); [ "$ok" -ge 10 ] && break
  else
    ok=0
  fi
  sleep 5
done
[ "$ok" -ge 10 ] || die "production does not report $TAG ($SHA) on every machine; check fly status and /api/health"
echo "deploy: production reports $TAG ($SHA). Now run app/scripts/smoke.sh."
