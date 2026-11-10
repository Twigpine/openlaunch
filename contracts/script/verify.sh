#!/usr/bin/env bash
# Verify the launchpad contracts on the block explorers (source already exact-matched on Sourcify).
#   Basescan (Base):            needs an Etherscan API key (one key works for every chain on Etherscan V2):
#                               export ETHERSCAN_API_KEY=... (or put ETHERSCAN_API_KEY= in contracts/.env)
#   Blockscout (Robinhood/Base/Arc): keyless.
#   Elysium explorer (Etherscan-compatible API under /explorer/api): keyless.
# Usage: script/verify.sh [base|robinhood|arc|elysium|all]   (default: all)
set -euo pipefail
failed=0
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
KEY="${ETHERSCAN_API_KEY:-${BASESCAN_API_KEY:-}}"

# The addresses are the same on every chain (deployer nonce 0). ARC_FACTORY / ARC_LOCKER override the Arc pair only, for an
# Arc deployment that landed elsewhere; Base and Robinhood always verify the live pair.
FACTORY=0x815542E8b392389A1389E22E588E4B62A67Ade72
LOCKER=0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
# Uniswap v4 per chain (must match script/DeployLaunchFactory.s.sol)
BASE_PM=0x498581fF718922c3f8e6A244956aF099B2652b2b
BASE_POSM=0x7C5f5A4bBd8fD63184577525326123B519429bDc
RH_PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
RH_POSM=0x58daec3116aae6d93017baaea7749052e8a04fa7
ARC_PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
ARC_POSM=0x6049c9a0e26405c0985f9e3685c87d0ae917f82b
ELY_PM=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1
ELY_POSM=0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518

common=(--watch --compiler-version 0.8.26 --evm-version cancun --num-of-optimizations 200 --via-ir)

verify_pair() { # <chain-id> <pm> <posm> <verifier args...>   (FACTORY_SRC: the factory contract; Arc deploys LaunchFactoryArc)
  local chain=$1 pm=$2 posm=$3; shift 3
  local src=${FACTORY_SRC:-src/LaunchFactory.sol:LaunchFactory}
  local factory=${VERIFY_FACTORY:-$FACTORY} locker=${VERIFY_LOCKER:-$LOCKER}
  local fargs largs
  fargs=$(cast abi-encode "constructor(address,address,address)" "$pm" "$posm" "$PERMIT2")
  largs=$(cast abi-encode "constructor(address)" "$posm")
  echo "== chain $chain: ${src##*:}"
  forge verify-contract --chain "$chain" "$factory" "$src" --constructor-args "$fargs" "${common[@]}" "$@" || { echo "!! ${src##*:} on chain $chain NOT verified"; failed=$((failed + 1)); }
  echo "== chain $chain: LaunchLocker"
  forge verify-contract --chain "$chain" "$locker" src/LaunchLocker.sol:LaunchLocker --constructor-args "$largs" "${common[@]}" "$@" || { echo "!! LaunchLocker on chain $chain NOT verified"; failed=$((failed + 1)); }
}

target=${1:-all}
if [[ $target == base || $target == all ]]; then
  if [[ -z $KEY ]]; then echo "Basescan: set ETHERSCAN_API_KEY (free at etherscan.io → API keys) — skipping"; else
    verify_pair 8453 "$BASE_PM" "$BASE_POSM" --verifier etherscan --etherscan-api-key "$KEY"
  fi
  echo "== Base Blockscout (keyless)"
  verify_pair 8453 "$BASE_PM" "$BASE_POSM" --verifier blockscout --verifier-url https://base.blockscout.com/api/
fi
if [[ $target == robinhood || $target == all ]]; then
  echo "== Robinhood Chain Blockscout (keyless)"
  verify_pair 4663 "$RH_PM" "$RH_POSM" --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
fi
if [[ $target == arc || $target == all ]]; then
  echo "== Arc Blockscout (keyless)"
  VERIFY_FACTORY=${ARC_FACTORY:-} VERIFY_LOCKER=${ARC_LOCKER:-} FACTORY_SRC=src/LaunchFactoryArc.sol:LaunchFactoryArc verify_pair 5042 "$ARC_PM" "$ARC_POSM" --verifier blockscout --verifier-url https://explorer.arc.io/api/
fi
if [[ $target == elysium || $target == all ]]; then
  # the explorer's pages sit behind a bot checkpoint, but its Etherscan-compatible API answers scripts
  echo "== Elysium explorer (keyless)"
  verify_pair 99901 "$ELY_PM" "$ELY_POSM" --verifier blockscout --verifier-url https://elysium.kinetiq.xyz/explorer/api/
fi
if [ "$failed" -gt 0 ]; then echo "$failed verification(s) failed"; exit 1; fi
echo "all verifications submitted"
