#!/usr/bin/env bash
# Sweep committee sizes (and optionally inter-node latencies) and produce
# a single mean-latency table at $RESULTS_DIR/summary.txt.
#
# For each odd committee size in $SIZES, spins up a fresh committee, runs
# DKG once, then for each value in $LATENCIES timed-signs both schemes
# $TRIALS times and writes results to
#   $RESULTS_DIR/size-<N>-lat<MS>-<scheme>.csv
#
# Environment:
#   SIZES        space-separated odd ints (default: "3 5 7 9 11 13 15")
#   LATENCIES    space-separated one-way per-leg ms (default: "0")
#   TRIALS       timed signs per scheme per (size, latency) (default 10)
#   PROFILE      cargo build profile (default release)
#   RESULTS_DIR  output dir for per-size CSVs and summary

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$ROOT_DIR/scripts/bench_sign_latency.sh"

SIZES="${SIZES:-3 5 7 9 11 13 15}"
LATENCIES="${LATENCIES:-0 10 50 100 250 500 750 1000}"
TRIALS="${TRIALS:-10}"
SIGN_TIMEOUT="${SIGN_TIMEOUT:-22}"
SCHEMES="${SCHEMES:-ecdsa ed25519}"
PROFILE="${PROFILE:-release}"
RESULTS_DIR="${RESULTS_DIR:-$ROOT_DIR/tmp/bench-sign-latency/results}"

mkdir -p "$RESULTS_DIR"
: >"$RESULTS_DIR/sizes.txt"
: >"$RESULTS_DIR/latencies.txt"
printf '%s\n' $LATENCIES >>"$RESULTS_DIR/latencies.txt"

for size in $SIZES; do
  TRIALS="$TRIALS" PROFILE="$PROFILE" RESULTS_DIR="$RESULTS_DIR" \
    LATENCIES="$LATENCIES" SIGN_TIMEOUT="$SIGN_TIMEOUT" \
    SCHEMES="$SCHEMES" COMMITTEE_SIZE="$size" "$BENCH"
  printf '%s\n' "$size" >>"$RESULTS_DIR/sizes.txt"
done

python3 "$ROOT_DIR/scripts/bench_summarize.py" "$RESULTS_DIR" \
  | tee "$RESULTS_DIR/summary.txt"
