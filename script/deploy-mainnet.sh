#!/usr/bin/env bash
#
# Mainnet deploy for Aval Protocol. X Layer, chain 196.
#
#   bash script/deploy-mainnet.sh
#
# This is deliberately NOT the testnet script with the chain id changed. Mainnet differs in
# four ways that each cost real money if got wrong, and every one of them is a hard stop here
# rather than a line in a README nobody reads:
#
#   1. USDT is real. There is no MockUSDT to deploy and nothing to mint. The address must be
#      supplied and is echoed back for confirmation before anything is broadcast.
#
#   2. MIN_BOND cannot be left at the contract default. That default is 10_000e6 - ten
#      thousand USDT - which is free against a mock and ruinous against real Tether, where it
#      means no underwriter can register without ten thousand dollars. A deployment nobody can
#      register against is a dead deployment.
#
#   3. Nothing is seeded. Seed.s.sol mints, and mainnet USDT cannot be minted; it also
#      already refuses chain 196 on its own. Demo state on mainnet has to be funded with real
#      money, deliberately, by a human.
#
#   4. Ownership matters. On testnet the owner is the deployer because the seed step needs
#      owner rights. On mainnet the owner controls setParams, setTermLimits, setConsumer,
#      setDealManager and pause. See SECURITY.md.
#
# It also asks for typed confirmation. An accidental mainnet broadcast is not recoverable.

set -euo pipefail

RPC="${XLAYER_RPC_URL:-https://rpc.xlayer.tech}"
EXPECTED_CHAIN=196
ENV_FILE=".env"

# Bridged Tether on X Layer. Verify it yourself before trusting this line:
#   https://www.oklink.com/x-layer/evm/token/0x1e4a5963abfd975d8c9021ce480b42188849d41d
KNOWN_USDT="0x1e4a5963abFD975d8c9021ce480b42188849D41d"

# 10 USDT at 6 decimals. Low enough that registering is possible with pocket change, high
# enough that it is not zero. Override in .env if you want something else.
DEFAULT_MIN_BOND="10000000"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33m!!\033[0m  %s\n" "$1"; }
die()  { printf "\n\033[31mFAILED\033[0m  %s\n\n" "$1" >&2; exit 1; }

set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf "%s=%s\n" "$key" "$val" >> "$ENV_FILE"
  fi
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
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
[ "$CHAIN_ID" = "$EXPECTED_CHAIN" ] || die "expected mainnet chain $EXPECTED_CHAIN, got $CHAIN_ID"
ok "connected to X Layer mainnet, chain $CHAIN_ID"

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
UNDERWRITER="$(cast wallet address --private-key "$UNDERWRITER_PRIVATE_KEY")"
[ "$(lower "$DEPLOYER")" != "$(lower "$UNDERWRITER")" ] \
  || die "PRIVATE_KEY and UNDERWRITER_PRIVATE_KEY are the same address. The underwriter must be a separate party."
ok "deployer     $DEPLOYER"
ok "underwriter  $UNDERWRITER"

# Gas. On mainnet this is real OKB and running out mid-sequence leaves a half-wired protocol.
for addr in "$DEPLOYER" "$UNDERWRITER"; do
  bal="$(cast balance "$addr" --rpc-url "$RPC")"
  [ "$bal" != "0" ] || die "$addr has no OKB for gas"
done
ok "both signers hold OKB"

bold "2. The two decisions that differ from testnet"

# --- USDT -------------------------------------------------------------------------------
if [ -z "${USDT_ADDRESS:-}" ]; then
  warn "USDT_ADDRESS is not set in .env"
  printf "      Known bridged Tether on X Layer: %s\n" "$KNOWN_USDT"
  printf "      Verify at https://www.oklink.com/x-layer/evm/token/%s\n\n" "$(lower "$KNOWN_USDT")"
  read -r -p "      Use that address? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "set USDT_ADDRESS in .env and rerun"
  USDT_ADDRESS="$KNOWN_USDT"
  set_env USDT_ADDRESS "$USDT_ADDRESS"
fi

# A wrong address here is a protocol wired to a token nobody holds, so confirm it is a real
# ERC-20 before spending gas on five contracts that reference it.
DECIMALS="$(cast call "$USDT_ADDRESS" "decimals()(uint8)" --rpc-url "$RPC" 2>/dev/null || echo "")"
[ -n "$DECIMALS" ] || die "$USDT_ADDRESS does not answer decimals(). That is not an ERC-20 on this chain."
SYMBOL="$(cast call "$USDT_ADDRESS" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null | tr -d '"' || echo "?")"
ok "asset $SYMBOL at $USDT_ADDRESS, $DECIMALS decimals"
[ "$DECIMALS" = "6" ] || warn "expected 6 decimals; MIN_BOND and every amount below assume 6"

# --- MIN_BOND ---------------------------------------------------------------------------
if [ -z "${MIN_BOND:-}" ]; then
  warn "MIN_BOND is not set, and the contract default is 10000000000 (ten thousand USDT)"
  printf "      Against real %s that means nobody can register as an underwriter.\n" "$SYMBOL"
  printf "      Using %s (10 %s) instead.\n\n" "$DEFAULT_MIN_BOND" "$SYMBOL"
  MIN_BOND="$DEFAULT_MIN_BOND"
  set_env MIN_BOND "$MIN_BOND"
fi
export MIN_BOND
ok "min bond $MIN_BOND ($(node -e "process.stdout.write((Number('$MIN_BOND')/1e6).toString())") $SYMBOL)"

# --- ownership --------------------------------------------------------------------------
if [ "$(lower "$OWNER_ADDRESS")" = "$(lower "$DEPLOYER")" ]; then
  warn "OWNER_ADDRESS is the deployer EOA, not a multisig"
  printf "      That single key can call setParams, setTermLimits, setConsumer, setDealManager\n"
  printf "      and pause. Acceptable to launch; transfer before anyone else's money is in.\n"
  printf "      Afterwards:  bash script/transfer-ownership.sh\n\n"
else
  ok "owner $OWNER_ADDRESS (not the deployer)"
fi

bold "3. Confirm"

printf "\n  About to broadcast to \033[1mX LAYER MAINNET\033[0m, chain %s.\n" "$CHAIN_ID"
printf "  Five contracts, real OKB, and nothing about this is reversible.\n\n"
read -r -p "  Type DEPLOY MAINNET to continue: " confirm
[ "$confirm" = "DEPLOY MAINNET" ] || die "not confirmed, nothing was broadcast"

bold "4. Deploying"

forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast -vv

DEPLOY_JSON="deployments/${EXPECTED_CHAIN}.json"
[ -f "$DEPLOY_JSON" ] || die "expected $DEPLOY_JSON to be written by the deploy script"

set_env DEAL_MANAGER_ADDRESS "$(json_field "$DEPLOY_JSON" dealManager)"
set_env VAULT_ADDRESS        "$(json_field "$DEPLOY_JSON" seniorVault)"
set_env REGISTRY_ADDRESS     "$(json_field "$DEPLOY_JSON" underwriterRegistry)"
set_env REPUTATION_ADDRESS   "$(json_field "$DEPLOY_JSON" reputation)"
set_env ADAPTER_ADDRESS      "$(json_field "$DEPLOY_JSON" protocolRevenueAdapter)"
set_env DEPLOY_BLOCK         "$(cast block-number --rpc-url "$RPC")"
ok "addresses written to $ENV_FILE"

bold "5. What is NOT done"

cat <<'EOF'

  Nothing is seeded. There is no pool, no underwriter registered, and no loans, because
  seeding mainnet means moving real USDT and that is a decision, not a script.

  To make it live, in order:

    1. Register the underwriter, locking MIN_BOND of real USDT
    2. Deposit into the senior vault
    3. Fund a deal:  npm run fund -- --slug uniswap --face 50000 --dry-run   (then without)

  Then point the site at it. In web/.env.local:

    NEXT_PUBLIC_NETWORK=mainnet

  and set the addresses printed above. Flip STATUS.deployedMainnet in web/lib/facts.ts so
  every page stops describing this as a test network - the terms page reads that flag.

  Verify the contracts:  npm run verify
  Transfer ownership:    bash script/transfer-ownership.sh

EOF

bold "Deployed to X Layer mainnet."
