#!/usr/bin/env bash
# The deployed contract sources, their build settings and the pinned libraries must match contracts/deployed.lock byte for
# byte. Fails on any drift. Run from anywhere.
#   script/check-deployed-sources.sh                    check
#   script/check-deployed-sources.sh --update [path…]   rewrite the hashes; extra paths (from the repo root) are added
set -euo pipefail
cd "$(dirname "$0")/../.."
lock=contracts/deployed.lock

# path -> the file's sha256
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# path -> the commit a submodule is pinned at, empty when the path is not a submodule
gitlink() { git ls-files -s -- "$1" | awk '$1 == "160000" { print $2 }'; }
# path -> succeeds when git tracks the file. A file that only exists on this machine is not there in a fresh checkout.
tracked() { git --literal-pathspecs ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }
current() { # kind path -> the value the lock should hold, empty when the path is gone or git does not track it
  if [[ "$1" == gitlink ]]; then gitlink "$2"; elif [[ -f "$2" && ! -L "$2" ]] && tracked "$2"; then sha "$2"; fi
}

if [[ "${1:-}" == "--update" ]]; then
  shift
  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  grep -E '^(#|$)' "$lock" > "$tmp" || true
  { grep -E '^(sha256|gitlink) ' "$lock" | awk '{ print $1, $3 }' || true # a lock with no entries yet
    for extra in "$@"; do
      # the lock holds each path as git spells it from the repository root, however it was typed here: the guard
      # compares the lock's paths with the paths of a pull request letter for letter
      path=$(git --literal-pathspecs ls-files --full-name -- "$extra" 2>/dev/null) || path=
      [[ -n "$path" && "$path" != *$'\n'* ]] || { echo "cannot lock $extra: not one file or submodule that git tracks in this repository (git add it first)" >&2; exit 1; }
      # an entry is "kind hash  path" with no space in the path: the check below and the guard read nothing else
      [[ "$path" != *[[:space:]]* ]] || { echo "cannot lock $extra: a path with a space in it cannot be an entry of the lock (rename the file)" >&2; exit 1; }
      if [[ -n "$(gitlink "$path")" ]]; then echo "gitlink $path"; else echo "sha256 $path"; fi
    done
  } | awk '!seen[$2]++' | while read -r kind path; do
    value=$(current "$kind" "$path")
    [[ -n "$value" ]] || { echo "cannot lock $path: the file is gone, or git no longer tracks it" >&2; exit 1; }
    printf '%s %s  %s\n' "$kind" "$value" "$path"
  done >> "$tmp"
  mv "$tmp" "$lock"; echo "updated $lock"; exit 0
fi

failed=0; checked=0
# An entry as --update writes it, which is also what the guard reads. A line in any other shape (indented, a tab, a
# path with a space) would be checked here and not locked there, so it is refused.
entry='^(sha256 [0-9a-f]{64}|gitlink [0-9a-f]{40})  [^[:space:]]+$'
while IFS= read -r line || [[ -n "$line" ]]; do # the last line counts with or without its newline
  if [[ -z "$line" || "$line" == \#* ]]; then continue; fi
  if [[ ! "$line" =~ $entry ]]; then echo "DRIFT  $lock has a line that is not an entry: $line"; failed=1; continue; fi
  read -r kind want path <<< "$line"
  checked=$((checked + 1))
  got=$(current "$kind" "$path")
  if [[ "$got" != "$want" ]]; then
    if [[ "$kind" == sha256 && -z "$got" && -f "$path" ]]; then echo "DRIFT  $path: the file is here, but git does not track it"
    else echo "DRIFT  $path: locked $kind ${want:0:12}…, found ${got:-nothing}"; fi
    failed=1; continue
  fi
  # the library that gets compiled is the checked-out one, so it has to be the pinned commit too, with nothing edited,
  # added or re-pinned inside it. A library that is not checked out at all (an empty folder) has nothing to compile.
  if [[ "$kind" == gitlink && -e "$path/.git" ]]; then
    out=$(git -C "$path" rev-parse HEAD)
    if [[ "$out" != "$want" ]]; then
      echo "DRIFT  $path: checked out at ${out:0:12}…, pinned at ${want:0:12}… (git submodule update)"; failed=1
    elif ! changed=$(git -C "$path" status --porcelain --untracked-files=normal --ignore-submodules=none) || [[ -n "$changed" ]]; then
      echo "DRIFT  $path: files differ from the pinned commit, or could not be compared with it (git -C $path status)"; failed=1
    fi
  elif [[ "$kind" == gitlink && -n "$(ls -A "$path" 2>/dev/null)" ]]; then
    echo "DRIFT  $path: holds files, but is not a checkout of the pinned commit (git submodule update --init)"; failed=1
  fi
done < "$lock"

if [[ "$checked" -eq 0 ]]; then echo "$lock lists nothing to check"; exit 1; fi
if [[ "$failed" -ne 0 ]]; then
  echo "Deployed contract files are never edited. A change for another chain goes in a new copied file (see src/LaunchFactoryArc.sol)."
  exit 1
fi
echo "ok: $checked deployed contract files and library pins match $lock"
