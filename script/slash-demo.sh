#!/usr/bin/env bash
#
# The demo. Settles the defaulted loan and shows the bond being slashed.
#
#   bash script/slash-demo.sh --check     read-only: is the loan still settleable?
#   bash script/slash-demo.sh             settles it. THIS IS THE TAKE.
#
# Prints the underwriter's position before and after so the loss is visible on screen.
# Run this on camera. It is the moment the whole protocol exists to produce.
#
# ALWAYS --check first. A deal can only be settled once, so running this without --check to
# "see if it works" spends the demo off camera and there is no undo. --check reads state and
# writes nothing.

set -uo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

[ -f .env ] || { echo "run this from the aval-protocol directory"; exit 1; }
set -a; source .env; set +a

RPC="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech/terigon}"
DEAL_ID=$(cast keccak "seed:defaulted")
UW=$(cast wallet address --private-key "$UNDERWRITER_PRIVATE_KEY")

usdt() { node -e "process.stdout.write((Number(process.argv[1])/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))" "$1"; }
raw()  { awk '{print $1}'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null; }
line() { printf "\n\033[1m%s\033[0m\n" "$1"; }

snapshot() {
  BOND=$(call "$REGISTRY_ADDRESS" "getUnderwriter(address)((bool,uint32,uint64,bytes32,uint256,uint256,uint256,uint64))" "$UW" | tr -d '()' | awk -F', ' '{print $5}' | raw)
  TVL=$(call "$VAULT_ADDRESS" "totalAssets()(uint256)" | raw)
  BRIER=$(call "$REPUTATION_ADDRESS" "brierScore(address)(uint256)" "$UW" | raw)
  DEFAULTS=$(call "$REPUTATION_ADDRESS" "getRecord(address)((uint256,uint256,uint256,uint256,uint64,uint64))" "$UW" | tr -d '()' | awk -F', ' '{print $6}' | raw)
}

D=$(call "$DEAL_MANAGER_ADDRESS" "deals(bytes32)(address,address,address,uint256,uint256,uint256,uint256,uint64,uint64,uint16,uint8,bool)" "$DEAL_ID")
ps() { echo "$D" | sed -n "${1}p" | raw; }
# deals(bytes32) returns, in order:
#   1 borrower  2 adapter  3 underwriter  4 principal  5 dueAmount  6 avalLocked
#   7 repaid    8 maturity 9 gracePeriod 10 pdBps     11 status    12 defaulted
PRINCIPAL=$(ps 4); DUE=$(ps 5); AVAL=$(ps 6); REPAID=$(ps 7)
MATURITY=$(ps 8); GRACE=$(ps 9); PD=$(ps 10); STATUS=$(ps 11)

# What settling will actually take, matching DealManager.settle: the shortfall, capped at the
# bond locked against THIS deal. Not the underwriter's whole bond, which is a much larger
# number and would be wrong to quote on camera.
SHORTFALL=$(( DUE - REPAID ))
[ "$SHORTFALL" -lt 0 ] && SHORTFALL=0
SLASH=$SHORTFALL
[ "$SLASH" -gt "$AVAL" ] && SLASH=$AVAL

NOW=$(date +%s); READY=$(( MATURITY + GRACE ))

if [ "$CHECK_ONLY" = "1" ]; then
  line "Demo loan status (read-only, nothing written)"
  echo "  deal id            $DEAL_ID"
  case "${STATUS:-0}" in
    1) echo "  state              ACTIVE, not yet settled" ;;
    *) echo "  state              ALREADY SETTLED (status ${STATUS:-0})" ;;
  esac
  echo "  declared PD        $(node -e "process.stdout.write((Number(process.argv[1])/100).toFixed(2))" "${PD:-0}")%"
  if [ "${STATUS:-0}" = "1" ] && [ "$NOW" -gt "$READY" ]; then
    snapshot
    echo "  matured            yes, $(( (NOW - READY) / 3600 )) hours ago"
    echo "  principal          $(usdt "$PRINCIPAL") USDT"
    echo "  owed back          $(usdt "$DUE") USDT, of which $(usdt "$REPAID") repaid"
    echo "  bond on this deal  $(usdt "$AVAL") USDT"
    echo "  underwriter bond   $(usdt "$BOND") USDT total, across all its deals"
    echo ""
    printf "  \033[1mSETTLING WILL SLASH   %s USDT\033[0m\n" "$(usdt "$SLASH")"
    echo "  That is the number to say on camera. Not the total bond above."
    echo ""
    echo "  READY TO RECORD. Run without --check when the camera is rolling."
  elif [ "${STATUS:-0}" = "1" ]; then
    echo "  matured            not yet, $(( (READY - NOW) / 60 + 1 )) more minute(s)"
    echo ""
    echo "  Wait, then run this again."
  else
    echo ""
    echo "  This loan is spent. Fund a fresh one before recording:"
    echo "    forge script script/SeedDemoLoan.s.sol:SeedDemoLoan \\"
    echo "      --rpc-url \$XLAYER_TESTNET_RPC_URL --broadcast -vv"
  fi
  echo ""
  exit 0
fi

[ "${STATUS:-0}" = "1" ] || { echo "demo loan is not in a settleable state (status ${STATUS:-0}). Run SeedDemoLoan first."; exit 1; }

if [ "$NOW" -le "$READY" ]; then
  echo "Not settleable yet. $(( (READY - NOW) / 60 + 1 )) more minute(s)."
  exit 1
fi

snapshot
B_BOND=$BOND; B_TVL=$TVL; B_BRIER=$BRIER; B_DEF=$DEFAULTS

line "Before"
echo "  The AI declared a $(node -e "process.stdout.write((Number(process.argv[1])/100).toFixed(2))" "$PD")% chance this loan would default."
echo "  It did not get repaid."
echo ""
echo "  Underwriter collateral   $(usdt "$B_BOND") USDT"
echo "  Lending pool             $(usdt "$B_TVL") USDT"
echo "  Defaults on record       $B_DEF"

line "Settling"
cast send "$DEAL_MANAGER_ADDRESS" "settle(bytes32)" "$DEAL_ID" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" >/dev/null || { echo "settle failed"; exit 1; }
echo "  done"

snapshot
LOST=$(( B_BOND - BOND ))

line "After"
echo "  Underwriter collateral   $(usdt "$BOND") USDT   (lost $(usdt "$LOST"))"
echo "  Lending pool             $(usdt "$TVL") USDT"
echo "  Defaults on record       $DEFAULTS"
echo "  Accuracy score           $(node -e "process.stdout.write((Number(process.argv[1])/1e18).toFixed(4))" "$BRIER") (was $(node -e "process.stdout.write((Number(process.argv[1])/1e18).toFixed(4))" "$B_BRIER"))"

line "What just happened"
cat <<EOF
  The AI was confidently wrong, so $(usdt "$LOST") USDT of its own capital was taken and
  paid to the lenders. Its accuracy score is now permanently worse, onchain, where anyone
  deciding whether to trust this model can see it.

  No other credit product does this. The model bore the cost of its own mistake.

  Verify it yourself:
  https://www.okx.com/web3/explorer/xlayer-test/address/$DEAL_MANAGER_ADDRESS

EOF
