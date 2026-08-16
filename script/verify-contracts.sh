#!/usr/bin/env bash
#
# Verify every deployed contract on the X Layer explorer so judges can read the source.
#
#   bash script/verify-contracts.sh
#
# Reads addresses from deployments/<chainId>.json, so it works for testnet or mainnet
# without arguments. Needs OKLINK_API_KEY in .env.
#
# Verification is worth more than it costs. An unverified contract is a blob of bytecode
# nobody can audit, and "trust us, the source matches" is exactly what this protocol exists
# to stop asking people to do.

set -uo pipefail

[ -f .env ] || { echo "run this from the aval-protocol directory"; exit 1; }
set -a; source .env; set +a

CHAIN_ID="${1:-1952}"
DEPLOY_JSON="deployments/${CHAIN_ID}.json"
[ -f "$DEPLOY_JSON" ] || { echo "no $DEPLOY_JSON, deploy first"; exit 1; }

if [ "$CHAIN_ID" = "196" ]; then
  RPC="${XLAYER_RPC_URL:-https://rpc.xlayer.tech}"
  EXPLORER="https://www.okx.com/web3/explorer/xlayer"
else
  RPC="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech/terigon}"
  EXPLORER="https://www.okx.com/web3/explorer/xlayer-test"
fi

# The chain short name is part of the path, and using the wrong one returns "URL not found"
# for every contract rather than anything that mentions chains. XLAYER is mainnet;
# XLAYER_TESTNET is chain 1952. This script previously sent testnet contracts to the mainnet
# endpoint and reported seven identical failures with no clue why.
if [ "$CHAIN_ID" = "196" ]; then
  CHAIN_SHORT_NAME="XLAYER"
else
  CHAIN_SHORT_NAME="XLAYER_TESTNET"
fi
VERIFIER_URL="https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/${CHAIN_SHORT_NAME}"

# Without `--verifier oklink`, forge speaks the Etherscan dialect at an OKLink endpoint.
VERIFIER="oklink"

if [ -z "${OKLINK_API_KEY:-}" ]; then
  echo
  echo "  OKLINK_API_KEY is not set. Verification will be rejected."
  echo "  Get one from https://www.oklink.com/ (free), then add to .env:"
  echo "    OKLINK_API_KEY=..."
  echo
  echo "  Continuing anyway so you can see the errors, but expect failures."
  echo
fi

get() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$DEPLOY_JSON','utf8'))['$1']||''))"; }

OWNER="${OWNER_ADDRESS:?set OWNER_ADDRESS in .env}"
USDT="${USDT_ADDRESS:?set USDT_ADDRESS in .env}"
MIN_BOND="${MIN_BOND:-10000000000}"

REGISTRY=$(get registry)
REPUTATION=$(get reputation)
VAULT=$(get vault)
DEAL_MANAGER=$(get dealManager)
ADAPTER=$(get protocolRevenueAdapter)
INVOICE=$(get invoiceAdapter)

echo "verifying on chain $CHAIN_ID"
echo

# Constructor args must match the deployment exactly or verification is rejected.
verify() {
  local addr="$1" contract="$2" args="$3"
  echo "  $contract  $addr"
  if [ -n "$args" ]; then
    forge verify-contract "$addr" "$contract" \
      --chain-id "$CHAIN_ID" --verifier "$VERIFIER" --verifier-url "$VERIFIER_URL" \
      --etherscan-api-key "${OKLINK_API_KEY:-}" \
      --constructor-args "$args" --watch 2>&1 | sed 's/^/      /' | tail -3
  else
    forge verify-contract "$addr" "$contract" \
      --chain-id "$CHAIN_ID" --verifier "$VERIFIER" --verifier-url "$VERIFIER_URL" \
      --etherscan-api-key "${OKLINK_API_KEY:-}" --watch 2>&1 | sed 's/^/      /' | tail -3
  fi
  echo
}

# Deploy.s.sol constructs everything with the DEPLOYER as interim owner, not OWNER_ADDRESS.
DEPLOYER=$(cast wallet address --private-key "${PRIVATE_KEY:?set PRIVATE_KEY in .env}")

verify "$REGISTRY"     "src/UnderwriterRegistry.sol:UnderwriterRegistry" \
  "$(cast abi-encode 'c(address,uint256,address)' "$USDT" "$MIN_BOND" "$DEPLOYER")"

verify "$REPUTATION"   "src/Reputation.sol:Reputation" \
  "$(cast abi-encode 'c(address)' "$DEPLOYER")"

verify "$VAULT"        "src/SeniorVault.sol:SeniorVault" \
  "$(cast abi-encode 'c(address,string,string,address)' "$USDT" "Aval Senior USDT" "avUSDT" "$DEPLOYER")"

verify "$DEAL_MANAGER" "src/DealManager.sol:DealManager" \
  "$(cast abi-encode 'c(address,address,address,address,address)' "$USDT" "$REGISTRY" "$REPUTATION" "$VAULT" "$DEPLOYER")"

verify "$ADAPTER"      "src/adapters/ProtocolRevenueAdapter.sol:ProtocolRevenueAdapter" \
  "$(cast abi-encode 'c(address)' "$OWNER")"

verify "$INVOICE"      "src/adapters/InvoiceAdapter.sol:InvoiceAdapter" \
  "$(cast abi-encode 'c(address)' "$OWNER")"

if [ "$CHAIN_ID" != "196" ] && [ -n "${USDT_ADDRESS:-}" ]; then
  verify "$USDT_ADDRESS" "src/mocks/MockUSDT.sol:MockUSDT" ""
fi

echo "done. Check each contract at:"
echo "  $EXPLORER/address/$DEAL_MANAGER"
echo
echo "If OKLink rejects the plugin endpoint, verify manually by pasting flattened source:"
echo "  forge flatten src/DealManager.sol > DealManager.flat.sol"
