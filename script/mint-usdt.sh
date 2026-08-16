#!/usr/bin/env bash
#
# Mint test USDT to a wallet, so you can use the lend and borrow parts of the app.
#
#   bash script/mint-usdt.sh 0xYourWalletAddress          # 10,000 USDT
#   bash script/mint-usdt.sh 0xYourWalletAddress 250000   # a specific amount
#
# NOTE: you do NOT need USDT to record the demo. settle() moves none of your tokens; it only
# needs OKB for gas. This is for the deposit and repay flows.
#
# MockUSDT.mint is deliberately unrestricted, because it is a testnet stand-in and gating it
# would just mean handing keys around. That is also exactly why MockUSDT must never be
# deployed to mainnet: see SECURITY.md, "Before mainnet".

set -uo pipefail

TO="${1:-}"
AMOUNT_USDT="${2:-10000}"

[ -f .env ] || { echo "Run this from the aval-protocol directory."; exit 1; }
set -a; source .env; set +a

if [ -z "$TO" ]; then
  echo "Usage: bash script/mint-usdt.sh <wallet-address> [amount-in-usdt]"
  echo
  echo "  The wallet address is the one you connected in the app. In most wallets you can"
  echo "  copy it from the account name at the top."
  exit 1
fi

case "$TO" in
  0x*) ;;
  *) echo "That does not look like an address. It should start with 0x."; exit 1;;
esac

RPC="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech/terigon}"

# USDT is 6 decimals, not 18. Getting this wrong by 1e12 is the classic mistake.
UNITS=$(node -e "process.stdout.write(String(BigInt(Math.round(Number(process.argv[1]) * 1e6))))" "$AMOUNT_USDT")

echo "Minting ${AMOUNT_USDT} USDT to ${TO}"

cast send "$USDT_ADDRESS" "mint(address,uint256)" "$TO" "$UNITS" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" >/dev/null || {
    echo
    echo "Failed. The usual causes, in order of likelihood:"
    echo "  1. The sending wallet has no OKB for gas. Faucet: https://web3.okx.com/xlayer/faucet"
    echo "  2. PRIVATE_KEY or USDT_ADDRESS is missing from .env"
    exit 1
  }

BAL=$(cast call "$USDT_ADDRESS" "balanceOf(address)(uint256)" "$TO" --rpc-url "$RPC" | awk '{print $1}')
echo "Done. That wallet now holds $(node -e "process.stdout.write((Number(process.argv[1])/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))" "$BAL") USDT."
echo
echo "If the app still shows zero, the token is not in your wallet's list yet. Add it manually:"
echo "  address  $USDT_ADDRESS"
echo "  symbol   USDT"
echo "  decimals 6"
