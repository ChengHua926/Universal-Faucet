#!/usr/bin/env python3
"""Aggregate per-trial signing latencies into summary tables.

Reads $RESULTS_DIR/size-<N>-rtt<MS>-<scheme>.csv files (one floating-point
latency in seconds per line) and prints:

  1. A flat table with one row per (size, rtt_ms, scheme) showing mean,
     median, p95, min, max, stdev — in seconds rounded to 0.01s.
  2. A pivoted mean-latency matrix per scheme, rows=size, cols=rtt_ms.

Cells where bench_sign_latency.sh aborted (a size-N-rttMS.skipped marker
exists) are rendered as 'skip' in the pivot.
"""
from __future__ import annotations

import statistics
import sys
from pathlib import Path


def fmt(x: float) -> str:
    return f"{x:.2f}"


def load(path: Path) -> list[float]:
    return [float(line) for line in path.read_text().splitlines() if line.strip()]


def print_flat(rows):
    header = ("size", "rtt_ms", "scheme", "trials", "mean(s)",
              "median(s)", "p95(s)", "min(s)", "max(s)", "stdev(s)")
    widths = [max(len(h), 9) for h in header]
    print("  ".join(h.rjust(w) for h, w in zip(header, widths)))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        cells = [
            str(r["size"]), str(r["rtt_ms"]), r["scheme"], str(r["trials"]),
            fmt(r["mean"]), fmt(r["median"]), fmt(r["p95"]),
            fmt(r["min"]), fmt(r["max"]), fmt(r["stdev"]),
        ]
        print("  ".join(c.rjust(w) for c, w in zip(cells, widths)))


def print_pivot(rows, scheme: str, sizes: list[int], lats: list[int], skipped: set[tuple[int, int]]):
    print(f"\nMean signing latency (s) — scheme = {scheme}")
    head = ["size \\ rtt_ms"] + [str(l) for l in lats]
    widths = [max(len(h), 9) for h in head]
    print("  ".join(h.rjust(w) for h, w in zip(head, widths)))
    print("  ".join("-" * w for w in widths))
    lookup = {(r["size"], r["rtt_ms"]): r for r in rows if r["scheme"] == scheme}
    for n in sizes:
        cells = [str(n)]
        for l in lats:
            if (n, l) in skipped:
                cells.append("skip")
            else:
                r = lookup.get((n, l))
                cells.append(fmt(r["mean"]) if r else "-")
        print("  ".join(c.rjust(w) for c, w in zip(cells, widths)))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: bench_summarize.py <results_dir>", file=sys.stderr)
        return 2
    results = Path(sys.argv[1])
    sizes = [int(s) for s in (results / "sizes.txt").read_text().split() if s.strip()]
    lats_file = results / "latencies.txt"
    if lats_file.exists():
        lats = [int(s) for s in lats_file.read_text().split() if s.strip()]
    else:
        lats = [0]

    rows = []
    skipped: set[tuple[int, int]] = set()
    for n in sizes:
        for lat in lats:
            if (results / f"size-{n}-rtt{lat}.skipped").exists():
                skipped.add((n, lat))
                continue
            for scheme in ("ecdsa", "ed25519"):
                csv = results / f"size-{n}-rtt{lat}-{scheme}.csv"
                if not csv.exists():
                    continue
                samples = load(csv)
                if not samples:
                    continue
                samples_sorted = sorted(samples)
                p95_idx = max(0, int(round(0.95 * (len(samples_sorted) - 1))))
                rows.append({
                    "size": n, "rtt_ms": lat, "scheme": scheme,
                    "trials": len(samples),
                    "mean": statistics.fmean(samples),
                    "median": statistics.median(samples),
                    "p95": samples_sorted[p95_idx],
                    "min": min(samples), "max": max(samples),
                    "stdev": statistics.pstdev(samples) if len(samples) > 1 else 0.0,
                })

    print_flat(rows)
    print_pivot(rows, "ecdsa", sizes, lats, skipped)
    print_pivot(rows, "ed25519", sizes, lats, skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
