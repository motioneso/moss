#!/bin/bash
# Bounded working-day sample of the running Debug trial build. No screen content is collected.
# Usage: bash backtrack-cpu-trial.sh [pid] [samples] [interval-seconds]
set -eu -o pipefail
trial_pid="${1:-$(pgrep -x 'Trail Marker')}"
samples="${2:-480}"
interval="${3:-60}"
for value in "$trial_pid" "$samples" "$interval"; do
  case "$value" in ''|*[!0-9]*) echo "Expected one PID and positive integer samples/interval." >&2; exit 2;; esac
  if [ "$value" -lt 1 ]; then echo "Values must be positive." >&2; exit 2; fi
done
if [ "$samples" -lt 2 ]; then echo "At least two samples are required." >&2; exit 2; fi
kill -0 "$trial_pid"
echo "Sampling PID $trial_pid for $samples samples at ${interval}s intervals; first sample is discarded."
/usr/bin/top -l "$samples" -s "$interval" -pid "$trial_pid" -stats pid,cpu,time |
awk -v target="$trial_pid" -v expected="$samples" '
$1 == target && $2 ~ /^[0-9]+([.][0-9]+)?$/ {
  observed++
  if (observed == 1) next
  cpu = $2 + 0; count++; sum += cpu
  if (cpu > peak) peak = cpu
}
END {
  if (observed != expected) {
    printf "Incomplete sample: observed %d of %d; CPU gate cannot be evaluated.\n", observed, expected
    exit 2
  }
  mean = sum / count
  printf "Mean CPU: %.2f%%; peak: %.2f%%; samples: %d; target: <=3.00%%; result: %s\n",
    mean, peak, count, (mean <= 3 ? "PASS" : "FAIL")
  if (mean > 3) exit 1
}'
