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
# Apple's media analysis service can do recognition work on an app's behalf (rem issue #59), so it
# is sampled alongside and reported, not gated. It may restart; its samples then stop.
media_pid="$(pgrep -x mediaanalysisd | head -1 || true)"
media_args=()
if [ -n "$media_pid" ]; then media_args=(-pid "$media_pid"); fi
echo "Sampling PID $trial_pid for $samples samples at ${interval}s intervals; first sample is discarded."
/usr/bin/top -l "$samples" -s "$interval" -pid "$trial_pid" ${media_args[@]+"${media_args[@]}"} -stats pid,cpu,time |
awk -v target="$trial_pid" -v expected="$samples" -v media="${media_pid:-none}" '
$1 == target && $2 ~ /^[0-9]+([.][0-9]+)?$/ {
  observed++
  if (observed == 1) next
  cpu = $2 + 0; count++; sum += cpu
  if (cpu > peak) peak = cpu
}
$1 == media && $2 ~ /^[0-9]+([.][0-9]+)?$/ {
  mobserved++
  if (mobserved == 1) next
  mcount++; msum += $2
}
END {
  if (media == "none") print "mediaanalysisd: not running at start; not sampled."
  else if (mcount) printf "mediaanalysisd (not gated): mean CPU %.2f%% over %d samples\n", msum / mcount, mcount
  else print "mediaanalysisd (not gated): no samples."
  if (observed != expected) {
    printf "Incomplete sample: observed %d of %d; CPU gate cannot be evaluated.\n", observed, expected
    exit 2
  }
  mean = sum / count
  printf "Mean CPU: %.2f%%; peak: %.2f%%; samples: %d; target: <=3.00%%; result: %s\n",
    mean, peak, count, (mean <= 3 ? "PASS" : "FAIL")
  if (mean > 3) exit 1
}'
