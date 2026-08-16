#!/usr/bin/env bash
#
# One-command testnet deploy for Aval Protocol.
#
#   bash script/deploy-testnet.sh
#
# Does the whole sequence and wires the addresses back into .env as it goes, so there is no
# copy-pasting of addresses between steps:
#
#   1. sanity checks (env vars, chain reachable, chain id, gas balance)
#   2. deploys MockUSDT and records USDT_ADDRESS
#   3. deploys and wires the protocol, records every address
#   4. seeds the demo state: funded pool, live loan, repaid loan, and one loan
#      deliberately left unsettled so the slash can be triggered live
#
# TESTNET ONLY. It refuses to run against mainnet.

set -euo pipefail

RPC="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech/terigon}"
EXPECTED_CHAIN=1952
ENV_FILE=".env"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m  %s\n" "$1"; }
die()  { printf "\n\033[31mFAILED\033[0m  %s\n\n" "$1" >&2; exit 1; }

# Rewrite KEY=value in .env, appending if the key is absent.
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # portable in-place edit: BSD sed on macOS needs the empty -i argument
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf "%s=%s\n" "$key" "$val" >> "$ENV_FILE"
  fi
}

json_field() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$1','utf8'))['$2']||''))"; }

bold "1. Checks"

[ -f "$ENV_FILE" ] || die ".env not found. Run: cp .env.example .env  then fill it in."
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

for v in PRIVATE_KEY OWNER_ADDRESS UNDERWRITER_PRIVATE_KEY MODEL_COMMIT; do
  val="${!v:-}"
  [ -n "$val" ] && [ "$val" != "0x" ] || die "$v is empty in .env"
done
ok "env vars present"

command -v forge >/dev/null || die "forge not found. Install Foundry first."
command -v cast  >/dev/null || die "cast not found. Install Foundry first."
ok "foundry installed"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")" || die "cannot reach $RPC"
[ "$CHAIN_ID" = "$EXPECTED_CHAIN" ] || die "expected chain $EXPECTED_CHAIN, got $CHAIN_ID. Chain 195 is the old deprecated testnet."
ok "connected to chain $CHAIN_ID"

# macOS ships bash 3.2, which has no ${var,,}. Lowercase via tr instead.
lower() { echo "$1" | tr 'A-Z' 'a-z'; }

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
UNDERWRITER="$(cast wallet address --private-key "$UNDERWRITER_PRIVATE_KEY")"

[ "$(lower "$DEPLOYER")" != "$(lower "$UNDERWRITER")" ] \
  || die "deployer and underwriter must be different wallets"
ok "deployer     $DEPLOYER"
ok "underwriter  $UNDERWRITER"

[ "$(lower "$OWNER_ADDRESS")" = "$(lower "$DEPLOYER")" ] \
  || die "OWNER_ADDRESS must equal the deployer address ($DEPLOYER) for the seed step to work"
ok "owner matches deployer"

for who in "$DEPLOYER:deployer" "$UNDERWRITER:underwriter"; do
  addr="${who%%:*}"; name="${who##*:}"
  bal="$(cast balance "$addr" --rpc-url "$RPC")"
  [ "$bal" != "0" ] || die "$name wallet ($addr) has no OKB. Fund it: https://web3.okx.com/xlayer/faucet"
  ok "$name gas: $(cast from-wei "$bal") OKB"
done

bold ""
bold "2. Deploying test USDT"

USDT_OUT="$(forge create src/mocks/MockUSDT.sol:MockUSDT \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast --json)"

# forge may print progress lines around the JSON, so pull the object out rather than
# assuming the whole of stdout parses.
USDT_ADDR="$(printf '%s' "$USDT_OUT" | node -e "
let s='';
process.stdin.on('data', d => s += d).on('end', () => {
  const m = s.match(/\{[^{}]*\"deployedTo\"[^{}]*\}/);
  process.stdout.write(m ? (JSON.parse(m[0]).deployedTo || '') : '');
});")"

if [ -z "$USDT_ADDR" ]; then
  echo "$USDT_OUT" >&2
  die "could not parse the MockUSDT address from the output above"
fi
set_env USDT_ADDRESS "$USDT_ADDR"
ok "MockUSDT  $USDT_ADDR"

bold ""
bold "3. Deploying the protocol"

set -a; source "$ENV_FILE"; set +a
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast -vv

DEPLOY_JSON="deployments/${EXPECTED_CHAIN}.json"
[ -f "$DEPLOY_JSON" ] || die "$DEPLOY_JSON was not written. Check fs_permissions in foundry.toml."

set_env DEAL_MANAGER_ADDRESS "$(json_field "$DEPLOY_JSON" dealManager)"
set_env REGISTRY_ADDRESS     "$(json_field "$DEPLOY_JSON" registry)"
set_env REPUTATION_ADDRESS   "$(json_field "$DEPLOY_JSON" reputation)"
set_env VAULT_ADDRESS        "$(json_field "$DEPLOY_JSON" vault)"
set_env ADAPTER_ADDRESS      "$(json_field "$DEPLOY_JSON" protocolRevenueAdapter)"
set_env DEPLOY_BLOCK         "$(cast block-number --rpc-url "$RPC")"
ok "addresses written to $ENV_FILE"

bold ""
bold "4. Seeding demo state"

set -a; source "$ENV_FILE"; set +a
forge script script/Seed.s.sol:Seed --rpc-url "$RPC" --broadcast -vv

bold ""
bold "Done"
echo
echo "  Explorer:  https://www.okx.com/web3/explorer/xlayer-test/address/$(json_field "$DEPLOY_JSON" dealManager)"
echo
echo "  Point the web app at it by adding to web/.env.local:"
echo "    NEXT_PUBLIC_NETWORK=testnet"
echo "    NEXT_PUBLIC_DEAL_MANAGER=$(json_field "$DEPLOY_JSON" dealManager)"
echo "    NEXT_PUBLIC_VAULT=$(json_field "$DEPLOY_JSON" vault)"
echo "    NEXT_PUBLIC_USDT=$USDT_ADDR"
echo
echo "  The third loan is deliberately left unsettled. Once it is past maturity plus"
echo "  grace, calling settle() on it slashes the bond live. That is the demo."
echo
