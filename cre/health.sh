#!/usr/bin/env bash
#
# Is the live system healthy right now? One read-only look at everything that
# can go wrong WITHOUT anything failing loudly.
#
#   ./health.sh [hours]        (default: the last 24 hours)
#
# Sends no transaction and holds no key. Where preflight.sh checks that the
# contracts are WIRED right, this checks that the DON is actually DOING its
# job — the questions that until now were answered by someone noticing:
#
#   1. Executions that failed, per workflow. A failure is often the platform's
#      own RPC ("no healthy upstream", "context canceled" on all ten nodes)
#      and the next run catches up — but nothing else tells you it happened.
#   2. Reports the receivers REFUSED. The execution still reads SUCCESS; only
#      ReportProcessed(result=false) on the forwarder says the contract said
#      no (out of gas, wrong name, a revert). Counted per receiver.
#   3. Markets past their time that nobody has asked to settle (the keeper's
#      own view), and markets stuck waiting for a report.
#   4. The confidential attestation: when it last landed, and which band.
#   5. Football matches long finished but not settled, and exchange orders
#      waiting longer than a new price should take.
#
# RPC: SEPOLIA_RPC_URL if set, else VITE_RPC_URL from frontend/.env.local,
# else the public node. The URL is never printed — it carries the key.
# Exit status is 0 only when nothing is marked FAIL; WARN is information.

set -uo pipefail

HOURS="${1:-24}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATH="$HOME/.cre/bin:$HOME/.foundry/bin:$PATH"

RPC="${SEPOLIA_RPC_URL:-}"
if [ -z "$RPC" ] && [ -f "$HERE/../frontend/.env.local" ]; then
  RPC="$(grep '^VITE_RPC_URL=' "$HERE/../frontend/.env.local" | cut -d= -f2- | tr -d '"')"
fi
RPC="${RPC:-https://ethereum-sepolia-rpc.publicnode.com}"

FORWARDER="0xF8344CFd5c43616a4366C34E3EEE75af79a74482"
SETTLEMENT_CFG="$HERE/settlement/config.production.json"
RESERVE_CFG="$HERE/reserve-attestation/config.production.json"

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }
FAILED=0

cfg() { python3 -c "import json,sys; print(json.load(open('$1')).get('$2') or '')"; }
call() { cast call "$@" --rpc-url "$RPC" 2>/dev/null; }

NOW=$(date +%s)
HEAD=$(cast block-number --rpc-url "$RPC" 2>/dev/null)
if [ -z "$HEAD" ]; then
  echo "Cannot reach the Sepolia RPC." >&2
  exit 2
fi
# Sepolia makes a block every 12 s.
FROM=$((HEAD - HOURS * 300))
SINCE=$(date -u -r $((NOW - HOURS * 3600)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$((NOW - HOURS * 3600))" +%Y-%m-%dT%H:%M:%SZ)
echo "Health over the last ${HOURS}h — Sepolia block $HEAD, $(date -u +%H:%MZ)"

echo
echo "1. DON executions"
for wf in predictsafe-settlement predictsafe-reserve; do
  n=$(cre execution list "$wf" --status FAILURE --start "$SINCE" --limit 100 2>/dev/null | grep -c "Started:")
  if [ "$n" -eq 0 ]; then ok "$wf: no failed executions"
  else warn "$wf: $n failed — read them with: cre execution list $wf --status FAILURE"; fi
done

echo
echo "2. Reports the contracts accepted / refused"
receivers=()
for key in flightContractAddress cryptoContractAddress stockContractAddress reserveContractAddress \
           ammContractAddress sportsContractAddress exchangeContractAddress keeperContractAddress \
           schedulerContractAddress; do
  a=$(cfg "$SETTLEMENT_CFG" "$key"); [ -n "$a" ] && receivers+=("${key%ContractAddress}:$a")
done
a=$(cfg "$RESERVE_CFG" attestationAddress); [ -n "$a" ] && receivers+=("attestation:$a")
for r in "${receivers[@]}"; do
  name=${r%%:*}; addr=${r#*:}
  # getLogs is capped at 10,000 blocks on the free RPC: walk in chunks.
  data=""
  for ((s = FROM; s <= HEAD; s += 9999)); do
    e=$((s + 9998 < HEAD ? s + 9998 : HEAD))
    data+=$(cast logs --address "$FORWARDER" --from-block "$s" --to-block "$e" \
      'ReportProcessed(address indexed,bytes32 indexed,bytes2 indexed,bool)' "$addr" \
      --rpc-url "$RPC" 2>/dev/null | grep "data:")$'\n'
  done
  yes=$(grep -c '1$' <<<"$data"); no=$(grep -c '0000000000000000000000000000000000000000000000000000000000000000$' <<<"$data")
  if [ "$no" -gt 0 ]; then fail "$name: $yes accepted, $no REFUSED — the receiver said no (gas? name? revert?)"
  else ok "$name: $yes accepted"; fi
done

echo
echo "3. Markets past their time"
keeper=$(cfg "$SETTLEMENT_CFG" keeperContractAddress)
due=$(call "$keeper" 'dueMarkets(uint256)(address[],uint256[])' 20 | tail -1)
if [ "$due" = "[]" ] || [ -z "$due" ]; then ok "keeper: nothing due"
else warn "keeper: due now $due — normal for up to ~20 min (it runs every 10, reading finalized blocks)"; fi
stuck=0
for key in cryptoContractAddress stockContractAddress reserveContractAddress; do
  c=$(cfg "$SETTLEMENT_CFG" "$key"); [ -z "$c" ] && continue
  n=$(call "$c" 'marketCount()(uint256)' | awk '{print $1}'); lo=$((n > 15 ? n - 15 : 0))
  for ((i = n - 1; i >= lo; i--)); do
    row=$(call "$c" 'core(uint256)(string,uint64,uint64,uint8,uint8,bytes32,int256,uint256,uint256)' "$i" | sed -n '3p;4p' | awk '{print $1}' | paste -sd' ' -)
    sa=${row%% *}; st=${row##* }
    if [ "$st" = "2" ] && [ $((NOW - sa)) -gt 3600 ]; then
      warn "${key%ContractAddress} #$i waiting for a report $(( (NOW - sa) / 60 )) min — the sweep should catch it"; stuck=1
    fi
  done
done
[ "$stuck" -eq 0 ] && ok "no market stuck waiting for a report"

echo
echo "4. Confidential reserve attestation"
att=$(cfg "$RESERVE_CFG" attestationAddress)
latest=$(call "$att" 'latest()((uint8,uint256,uint64,uint64,bytes32))' | tr -d '()' | tr ',' ' ')
# cast prints big numbers with a "[1.79e9]" hint after them: drop those first.
band=$(awk '{print $1}' <<<"$latest")
at=$(sed -E 's/\[[^]]*\]//g' <<<"$latest" | awk '{print $4}')
labels=("below 100%" "at least 100%" "at least 150%" "at least 200%" "at least 300%" "at least 400%" "at least 500%")
if [ -z "$at" ] || [ "$at" = "0" ]; then fail "no attestation yet"
else
  age=$(( (NOW - at) / 60 ))
  if [ "$age" -gt 125 ]; then fail "last attestation ${age} min ago (expected hourly) — band ${labels[$band]:-?}"
  elif [ "$band" = "0" ]; then fail "attested ${age} min ago: BELOW 100% — the custodian holds less than the tokens are worth"
  else ok "attested ${age} min ago: ${labels[$band]:-band $band}"; fi
fi

echo
echo "5. Football and the exchange"
sports=$(cfg "$SETTLEMENT_CFG" sportsContractAddress)
if [ -n "$sports" ]; then
  out=$(call "$sports" 'unsettled(uint256)(uint64[],uint64[])' 20)
  kicks=$(sed -n 2p <<<"$out" | tr -d '[]' | tr ',' '\n' | awk '{print $1}')
  late=0
  for k in $kicks; do [ -n "$k" ] && [ $((NOW - k)) -gt $((4 * 3600)) ] && late=$((late + 1)); done
  open=$(sed -n 1p <<<"$out" | tr -d '[]' | tr ',' '\n' | grep -c '[0-9]')
  if [ "$late" -gt 0 ]; then warn "$late match(es) finished over 2 h ago and not settled (the result needs 2 h after kick-off + the next :01/:31 run)"
  else ok "$open match(es) waiting, none overdue"; fi
fi
ex=$(cfg "$SETTLEMENT_CFG" exchangeContractAddress)
pending=$(call "$ex" 'pendingOrderIds()(uint256[])' | tr -d '[]' | tr ',' '\n' | awk '{print $1}')
oldest=0
for id in $pending; do
  placed=$(call "$ex" 'order(uint256)((address,uint32,uint8,uint8,uint80,uint64,uint256,uint256,uint256,uint80,int256))' "$id" | tr -d '()' | tr ',' '\n' | sed -n 6p | awk '{print $1}')
  [ -n "$placed" ] && [ $((NOW - placed)) -gt "$oldest" ] && oldest=$((NOW - placed))
done
count=$(grep -c '[0-9]' <<<"$pending")
if [ "$count" -eq 0 ]; then ok "exchange: no pending orders"
elif [ "$oldest" -gt $((3 * 3600)) ]; then warn "exchange: $count pending, oldest $((oldest / 3600)) h — normal over a weekend (no new price), otherwise look at trigger 7"
else ok "exchange: $count pending, oldest $((oldest / 60)) min"; fi

echo
[ "$FAILED" -eq 0 ] && echo "Healthy." || echo "Something needs a look — see FAIL above."
exit "$FAILED"
