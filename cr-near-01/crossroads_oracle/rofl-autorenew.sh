#!/usr/bin/env bash
#
# rofl-autorenew.sh — keep the Crossroads block-hash oracle ROFL machine alive
# unattended. Programmatic answer to "top up our ROFL app and renew its service".
#
# What it does (mode `auto`, meant for cron/launchd):
#   1. If the machine already lapsed ("Machine instance not found") → re-rent it
#      with `oasis rofl deploy --replace-machine` and refresh the oracle URL.
#   2. Else read "Paid until" and, if the runway is below RENEW_THRESHOLD_HOURS,
#      `oasis rofl machine top-up` for RENEW_TERM_HOURS more.
#   3. Before paying, check the admin balance covers the cost; if not, log an
#      alert and exit 3 so the scheduler/operator notices (refill from faucet).
#
# Renewal economics (testnet): rental is ~5 TEST/hour and NON-REFUNDABLE, funded
# from the faucet — so this renews WHILE FUNDS LAST and alerts when it can't.
# There is no "free forever": #4 is automated renewal + a low-balance alert, not
# infinite uptime.
#
# Non-interactive signing: the oasis CLI reads the keystore passphrase from
# stdin, so we pipe it from the macOS Keychain (preferred) or $OASIS_PASSPHRASE.
# The passphrase is never written to the repo.
#
# Usage:
#   ./rofl-autorenew.sh                 # check + renew/redeploy as needed
#   ./rofl-autorenew.sh status          # print status + runway, make no changes
#   ./rofl-autorenew.sh topup [HOURS]   # force a top-up of HOURS now
#
set -euo pipefail

# Make CLI tools resolvable under launchd/cron's minimal PATH.
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.foundry/bin:/usr/bin:/bin:$PATH"

# --- config (override via env) ----------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROFL_DIR="${ROFL_DIR:-$SCRIPT_DIR}"                 # dir holding rofl.yaml
MACHINE="${ROFL_MACHINE:-default}"
RENEW_THRESHOLD_HOURS="${RENEW_THRESHOLD_HOURS:-2}" # top up when runway < this
RENEW_TERM_HOURS="${RENEW_TERM_HOURS:-6}"           # hours bought per top-up
TEST_PER_HOUR="${TEST_PER_HOUR:-5}"                 # rental price (balance guard)
ADMIN_ADDR="${ADMIN_ADDR:-0xFF530ccBB4096d62a417650B8e358B28E647779a}"
SAPPHIRE_RPC="${SAPPHIRE_RPC:-https://testnet.sapphire.oasis.io}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-oasis-rofl-passphrase}"
ORACLE_PORT="${ORACLE_PORT:-8080}"
# .env file whose CROSSROADS_ORACLE_API is refreshed after a re-rent (URL change).
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../backend_contracts/.env.demo-keys}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# --- passphrase (stdin, from Keychain or env) -------------------------------
get_passphrase() {
  if [ -n "${OASIS_PASSPHRASE:-}" ]; then
    printf '%s' "$OASIS_PASSPHRASE"; return 0
  fi
  if command -v security >/dev/null 2>&1; then
    security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null && return 0
  fi
  die "no passphrase: set \$OASIS_PASSPHRASE or store it in Keychain (service '$KEYCHAIN_SERVICE')"
}

# --- machine state ----------------------------------------------------------
machine_text() { (cd "$ROFL_DIR" && oasis rofl machine show 2>&1) || true; }

# echoes: "gone" | "<paid_until_epoch>" | "unknown"
machine_state() {
  local txt; txt="$(machine_text)"
  if grep -qi "instance not found" <<<"$txt"; then echo "gone"; return; fi
  local line; line="$(grep -i "Paid until:" <<<"$txt" | head -1 | sed -E 's/^[^:]*: *//' || true)"
  [ -z "$line" ] && { echo "unknown"; return; }
  # "2026-06-04 23:38:21 -0400 EDT" -> epoch (drop trailing tz name, keep offset)
  python3 - "$line" <<'PY' 2>/dev/null || echo "unknown"
import sys
from datetime import datetime
s = " ".join(sys.argv[1].split()[:3])  # date time offset (drop the tz name)
print(int(datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z").timestamp()))
PY
}

admin_balance() {
  local wei; wei="$(cast balance "$ADMIN_ADDR" --rpc-url "$SAPPHIRE_RPC" 2>/dev/null || echo 0)"
  python3 -c "print(int('${wei:-0}')/1e18)"
}

# Derive the ROFL Port-Proxy URL: p<port>.m<instanceId(dec)>.<net.oasis.proxy.domain>
derive_url() {
  local json; json="$(cd "$ROFL_DIR" && oasis rofl machine show --format json 2>/dev/null)" || return 1
  ORACLE_PORT="$ORACLE_PORT" python3 - "$json" <<'PY' 2>/dev/null
import sys, json, os
def find(o, key):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key: return v
            r = find(v, key)
            if r is not None: return r
    elif isinstance(o, list):
        for v in o:
            r = find(v, key)
            if r is not None: return r
    return None
d = json.loads(sys.argv[1])
mid = find(d, "id"); dom = find(d, "net.oasis.proxy.domain")
if not mid or not dom: sys.exit(1)
print(f"https://p{os.environ['ORACLE_PORT']}.m{int(str(mid), 16)}.{dom}")
PY
}

refresh_env_url() {
  local url="$1"
  [ -z "$url" ] && { log "could not derive URL; leaving $ENV_FILE untouched"; return; }
  if [ -f "$ENV_FILE" ] && grep -q '^CROSSROADS_ORACLE_API=' "$ENV_FILE"; then
    sed -i '' -E "s|^CROSSROADS_ORACLE_API=.*|CROSSROADS_ORACLE_API=${url}|" "$ENV_FILE"
    log "oracle URL -> $url  (updated $ENV_FILE)"
  else
    log "oracle URL -> $url  ($ENV_FILE has no CROSSROADS_ORACLE_API line; not modified)"
  fi
}

# --- balance guard ----------------------------------------------------------
ensure_funds() {
  local hours="$1" cost bal
  cost="$(python3 -c "print($hours * $TEST_PER_HOUR)")"
  bal="$(admin_balance)"
  if python3 -c "import sys; sys.exit(0 if float('$bal') >= float('$cost') else 1)"; then
    log "balance ok: ${bal} TEST >= ${cost} TEST for ${hours}h"
  else
    log "ALERT: admin ${ADMIN_ADDR} has ${bal} TEST, need ${cost} for ${hours}h. Fund from the faucet."
    exit 3
  fi
}

# --- actions ----------------------------------------------------------------
do_topup() {
  local hours="$1"
  ensure_funds "$hours"
  log "topping up ${MACHINE} by ${hours}h ($((hours * TEST_PER_HOUR)) TEST)…"
  local pass; pass="$(get_passphrase)"
  printf '%s\n' "$pass" | (cd "$ROFL_DIR" && oasis rofl machine top-up "$MACHINE" \
    --term hour --term-count "$hours" -y)
  log "top-up done; new runway: $(runway_str)"
}

do_redeploy() {
  local hours="$1"
  ensure_funds "$hours"
  log "machine lapsed — re-renting with deploy --replace-machine (${hours}h)…"
  local pass; pass="$(get_passphrase)"
  printf '%s\n' "$pass" | (cd "$ROFL_DIR" && oasis rofl deploy --replace-machine \
    --term hour --term-count "$hours" -y)
  refresh_env_url "$(derive_url || true)"
  log "re-rent done; new runway: $(runway_str)"
}

runway_str() {
  local st; st="$(machine_state)"
  case "$st" in
    gone)    echo "GONE";;
    unknown) echo "unknown";;
    *)       python3 -c "print(round(($st-$(date +%s))/3600, 2), 'h left')";;
  esac
}

# --- main -------------------------------------------------------------------
cmd="${1:-auto}"
case "$cmd" in
  status)
    st="$(machine_state)"
    log "machine=$MACHINE state=$st runway=$(runway_str) admin_balance=$(admin_balance) TEST"
    if [ "$st" != gone ]; then
      url="$(derive_url || true)"
      [ -n "$url" ] && log "oracle URL: $url"
    fi
    ;;
  topup)
    do_topup "${2:-$RENEW_TERM_HOURS}"
    ;;
  auto)
    st="$(machine_state)"
    if [ "$st" = gone ]; then
      do_redeploy "$RENEW_TERM_HOURS"
    elif [ "$st" = unknown ]; then
      die "could not read machine state (oasis CLI/network issue)"
    else
      left_h="$(python3 -c "print(($st-$(date +%s))/3600)")"
      if python3 -c "import sys; sys.exit(0 if float('$left_h') < float('$RENEW_THRESHOLD_HOURS') else 1)"; then
        log "runway ${left_h}h < ${RENEW_THRESHOLD_HOURS}h threshold — renewing"
        do_topup "$RENEW_TERM_HOURS"
      else
        log "runway ${left_h}h >= ${RENEW_THRESHOLD_HOURS}h threshold — nothing to do"
      fi
    fi
    ;;
  *)
    die "unknown command '$cmd' (use: auto | status | topup [HOURS])"
    ;;
esac
