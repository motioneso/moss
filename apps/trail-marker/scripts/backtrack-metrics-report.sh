#!/bin/bash
# Summarises the Backtrack kill-gate metrics (#2638) from the unified log.
#   backtrack-metrics-report.sh [window]    window defaults to 8h, e.g. 2h, 30m
set -u
window="${1:-8h}"
/usr/bin/log show --last "$window" --style compact \
  --predicate 'subsystem == "com.moss.trailmarker" AND category == "backtrack-metrics"' 2>/dev/null |
awk '
function field(name,   i, kv) { for (i = 1; i <= NF; i++) { split($i, kv, "="); if (kv[1] == name) return kv[2] } return "" }
/\] thumb /   { t++; tc += field("cpu_ms"); if (field("changed") == 1) tch++; d = field("diff"); if (d != "none") { if (d+0 <= 5) t5++; if (d+0 <= 10) t10++ } }
/\] capture / { tr = field("trigger"); c[tr]++; cc[tr] += field("cpu_ms"); d = field("diff")
                if (tr == "switch") { if (d == "none") sn++; else if (d+0 <= 2) s2++; else if (d+0 <= 5) s5++ }
                if (field("idle_s") + 0 >= 120) idle++ }
/\] ocr /     { tr = field("trigger"); o[tr]++; oc[tr] += field("cpu_ms"); ow[tr] += field("wall_ms"); if (field("emitted_lines") == 0) noemit++ }
/\] skip /    { skip[field("stage")]++ }
/\] total /   { wall += field("wall_ms"); cpu += field("cpu_ms") }
END {
  hours = wall / 3600000
  printf "Covered: %.2f h of 5-min totals; process CPU %.1f%% of one core\n", hours, (wall ? 100 * cpu / wall : 0)
  ocrcpu = oc["switch"] + oc["changed"]; capcpu = cc["switch"] + cc["changed"]
  printf "Explained by Backtrack: OCR %.1f%%, captures %.1f%%, change checks %.1f%% (rest is the app itself)\n",
    (wall ? 100 * ocrcpu / wall : 0), (wall ? 100 * capcpu / wall : 0), (wall ? 100 * tc / wall : 0)
  for (tr in o) printf "OCR via %-7s %5d passes (%.0f/h), mean CPU %d ms, mean wall %d ms\n",
    tr, o[tr], (hours ? o[tr] / hours : 0), oc[tr] / o[tr], ow[tr] / o[tr]
  printf "Passes that emitted nothing new: %d of %d\n", noemit, o["switch"] + o["changed"]
  printf "Change checks: %d, changed %d; diff <=5: %d, <=10: %d\n", t, tch, t5, t10
  printf "Switch captures: never-seen window %d, diff <=2 (already skippable) %d, diff 2-5 %d\n", sn, s2, s5
  printf "Captures with no input for 2+ min: %d\n", idle
  for (s in skip) printf "Skipped at %s: %d\n", s, skip[s]
}'
