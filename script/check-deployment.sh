#!/usr/bin/env bash
#
# Reads the live chain and reports whether the deployment is demo-ready.
#
#   bash script/check-deployment.sh
#
# Read-only. Sends no transactions, needs no private key, costs nothing.
# Every number below comes from contract state, not from local files.

set -uo pipefail

ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "run this from the aval-protocol directory"; exit 1; }
set -a; source "$ENV_FILE"; set +a

RPC="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech/terigon}"
EXPLORER="https://www.okx.com/web3/explorer/xlayer-test"

PASS=0; FAIL=0
green() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; PASS=$((PASS+1)); }
red()   { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAIL=$((FAIL+1)); }
info()  { printf "        %s\n" "$1"; }
head2() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# strip cast's "12345 [1.2e4]" annotation down to the raw integer
raw() { awk '{print $1}'; }
usdt() { node -e "const v=BigInt(process.argv[1]);const s=(Number(v)/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});process.stdout.write(s)" "$1" 2>/dev/null || echo "?"; }

call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null; }

head2 "Network"
CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null)
if [ "$CHAIN" = "1952" ]; then green "connected to X Layer testnet (1952)"; else red "expected chain 1952, got '${CHAIN:-no response}'"; exit 1; fi

head2 "Contracts deployed"
for pair in \
  "DealManager:$DEAL_MANAGER_ADDRESS" \
  "SeniorVault:$VAULT_ADDRESS" \
  "UnderwriterRegistry:$REGISTRY_ADDRESS" \
  "Reputation:$REPUTATION_ADDRESS" \
  "RevenueAdapter:$ADAPTER_ADDRESS" \
  "USDT:$USDT_ADDRESS"; do
  name="${pair%%:*}"; addr="${pair##*:}"
  code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "0x" ]; then
    green "$(printf '%-20s' "$name") $addr"
  else
    red "$(printf '%-20s' "$name") no contract at $addr"
  fi
done

head2 "Wiring"
DM_REG=$(call "$DEAL_MANAGER_ADDRESS" "registry()(address)")
DM_VAULT=$(call "$DEAL_MANAGER_ADDRESS" "vault()(address)")
DM_REP=$(call "$DEAL_MANAGER_ADDRESS" "reputation()(address)")
V_DM=$(call "$VAULT_ADDRESS" "dealManager()(address)")
lc() { echo "$1" | tr 'A-Z' 'a-z'; }
[ "$(lc "$DM_REG")"  = "$(lc "$REGISTRY_ADDRESS")" ]   && green "DealManager points at the registry"   || red "DealManager registry mismatch"
[ "$(lc "$DM_VAULT")" = "$(lc "$VAULT_ADDRESS")" ]     && green "DealManager points at the vault"      || red "DealManager vault mismatch"
[ "$(lc "$DM_REP")"  = "$(lc "$REPUTATION_ADDRESS")" ] && green "DealManager points at reputation"     || red "DealManager reputation mismatch"
[ "$(lc "$V_DM")"    = "$(lc "$DEAL_MANAGER_ADDRESS")" ] && green "Vault accepts the DealManager"      || red "Vault dealManager not set"
[ "$(call "$REGISTRY_ADDRESS" "consumers(address)(bool)" "$DEAL_MANAGER_ADDRESS")" = "true" ] \
  && green "Registry authorises the DealManager" || red "Registry consumer NOT set (bonds cannot lock)"
[ "$(call "$REPUTATION_ADDRESS" "consumers(address)(bool)" "$DEAL_MANAGER_ADDRESS")" = "true" ] \
  && green "Reputation authorises the DealManager" || red "Reputation consumer NOT set (scores cannot record)"

# The token the vault actually holds, against the one everything else is configured with.
#
# deployments/<chain>.json never recorded the USDT address, so it is carried by hand in .env and
# in web/lib/aval.ts. A redeploy that mints a fresh MockUSDT leaves both pointing at the old
# one, and the failure is silent and total: the faucet mints a token the vault will not accept,
# every deposit reverts during gas estimation so no wallet ever prompts, and nothing on screen
# names the cause. Worth two seconds to rule out.
V_ASSET=$(call "$VAULT_ADDRESS" "asset()(address)")
if [ "$(lc "$V_ASSET")" = "$(lc "$USDT_ADDRESS")" ]; then
  green "Vault asset matches USDT_ADDRESS"
else
  red "VAULT ASSET MISMATCH"
  info "  vault holds:  $V_ASSET"
  info "  configured:   $USDT_ADDRESS"
  info "  Fix USDT_ADDRESS in .env and NEXT_PUBLIC_USDT for the web app, then redeploy the site."
fi

head2 "Lending pool"
TVL=$(call "$VAULT_ADDRESS" "totalAssets()(uint256)" | raw)
DEP=$(call "$VAULT_ADDRESS" "deployedAssets()(uint256)" | raw)
UTIL=$(call "$VAULT_ADDRESS" "utilizationBps()(uint256)" | raw)
PAUSED=$(call "$DEAL_MANAGER_ADDRESS" "paused()(bool)")
if [ "${TVL:-0}" != "0" ]; then green "pool funded: $(usdt "$TVL") USDT"; else red "pool is empty, seed did not run"; fi
info "lent out:     $(usdt "${DEP:-0}") USDT"

info "utilisation:  $(node -e "process.stdout.write((Number(process.argv[1])/100).toFixed(2))" "${UTIL:-0}")%"
[ "$PAUSED" = "false" ] && green "new lending is open" || red "protocol is paused"

# Can the app actually discover these loans?
#
# Everything above reads deals by id, out of .env. The app does not have the ids: it finds deals
# by scanning DealFunded events, so a chain where every getDeal succeeds can still give the app
# an empty list. check-logs.mjs runs the browser's own scan, so this tests the path that matters.
#
# The previous version of this check was wrong twice: `$(grep -c ... || echo 0)` emitted "0" from
# grep and another "0" from echo, producing "0\n0" and an integer-expression error, and the
# cast-logs output never started lines with "blockNumber" so the pattern matched nothing and
# reported a failure that was not real.
head2 "Loan discovery"
if DEAL_MANAGER_ADDRESS="$DEAL_MANAGER_ADDRESS" DEPLOY_BLOCK="${DEPLOY_BLOCK:-0}" \
   XLAYER_TESTNET_RPC_URL="$RPC" node script/check-logs.mjs; then
  PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  the app can discover these loans\n"
else
  FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m  the app will show an empty loan list\n"
fi


head2 "AI underwriter"
UW=$(cast wallet address --private-key "$UNDERWRITER_PRIVATE_KEY" 2>/dev/null)
info "address: $UW"
U=$(call "$REGISTRY_ADDRESS" "getUnderwriter(address)((bool,uint32,uint64,bytes32,uint256,uint256,uint256,uint64))" "$UW")
BOND=$(echo "$U" | tr -d '()' | awk -F', ' '{print $5}' | raw)
LOCKED=$(echo "$U" | tr -d '()' | awk -F', ' '{print $6}' | raw)
if [ -n "${BOND:-}" ] && [ "${BOND:-0}" != "0" ]; then
  green "bond posted: $(usdt "$BOND") USDT"
  info "locked against live loans: $(usdt "${LOCKED:-0}") USDT"
else
  red "underwriter has posted no bond"
fi

head2 "Loans"
check_deal() {
  local label="$1" id; id=$(cast keccak "$2")
  local d; d=$(call "$DEAL_MANAGER_ADDRESS" "deals(bytes32)(address,address,address,uint256,uint256,uint256,uint256,uint64,uint64,uint16,uint8,bool)" "$id")
  local principal status defaulted maturity grace
  principal=$(echo "$d" | sed -n '4p' | raw)
  maturity=$(echo "$d" | sed -n '8p' | raw)
  grace=$(echo "$d" | sed -n '9p' | raw)
  status=$(echo "$d" | sed -n '11p' | raw)
  defaulted=$(echo "$d" | sed -n '12p' | raw)

  case "${status:-0}" in
    0) red "$label: not funded"; return;;
    1) green "$label: active, $(usdt "$principal") USDT lent"
       local now settle_at; now=$(date +%s); settle_at=$(( ${maturity:-0} + ${grace:-0} ))
       if [ "$now" -gt "$settle_at" ]; then
         info "SETTLEABLE NOW. This is your demo: settle it and the bond gets slashed."
         info "  cast send \$DEAL_MANAGER_ADDRESS \"settle(bytes32)\" $id --rpc-url $RPC --private-key \$PRIVATE_KEY"
       else
         info "settleable in $(( (settle_at - now) / 60 )) minutes"
       fi;;
    2) if [ "$defaulted" = "true" ]; then
         green "$label: settled, DEFAULTED, bond was slashed"
       else
         green "$label: settled, repaid in full"
       fi;;
  esac
}
check_deal "live loan     " "seed:live"
check_deal "repaid loan   " "seed:repaid"
check_deal "demo loan     " "seed:defaulted"

head2 "Track record"
BRIER=$(call "$REPUTATION_ADDRESS" "brierScore(address)(uint256)" "$UW" | raw)
REC=$(call "$REPUTATION_ADDRESS" "getRecord(address)((uint256,uint256,uint256,uint256,uint64,uint64))" "$UW")
PREDS=$(echo "$REC" | tr -d '()' | awk -F', ' '{print $5}' | raw)
DEFS=$(echo "$REC" | tr -d '()' | awk -F', ' '{print $6}' | raw)
if [ "${PREDS:-0}" != "0" ]; then
  green "$PREDS settled prediction(s) recorded, $DEFS default(s)"
  info "accuracy score: $(node -e "process.stdout.write((Number(process.argv[1])/1e18).toFixed(4))" "${BRIER:-0}") (0 is perfect)"
else
  red "no predictions recorded yet"
fi

head2 "Links"
info "DealManager: $EXPLORER/address/$DEAL_MANAGER_ADDRESS"
info "Pool:        $EXPLORER/address/$VAULT_ADDRESS"

head2 "Result"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32m%s checks passed. Aval is live and demo-ready.\033[0m\n\n" "$PASS"
else
  printf "  \033[31m%s passed, %s failed.\033[0m Paste this output and I will fix it.\n\n" "$PASS" "$FAIL"
fi
