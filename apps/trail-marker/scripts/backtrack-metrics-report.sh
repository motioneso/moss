#!/bin/bash
# Summarises the Backtrack kill-gate metrics (#2638) from the unified log.
#   backtrack-metrics-report.sh [window] [pid]    window defaults to 8h, e.g. 2h, 30m
# Pass the trial app's pid to leave out unit-test runs, whose test host logs the same category.
set -eu -o pipefail
window="${1:-8h}"
predicate='subsystem == "com.moss.trailmarker" AND category == "backtrack-metrics"'
if [ -n "${2:-}" ]; then
  case "$2" in *[!0-9]*) echo "Expected a numeric pid." >&2; exit 2;; esac
  predicate="$predicate AND processIdentifier == $2"
fi
/usr/bin/log show --last "$window" --style compact --predicate "$predicate" |
awk '
function field(name,   i, kv) { for (i = 1; i <= NF; i++) { split($i, kv, "="); if (kv[1] == name) return kv[2] } return "" }
/\] thumb /   { t++; tc += field("cpu_ms"); if (field("changed") == 1) tch++; d = field("diff"); if (d != "none") { if (d+0 <= 5) t5++; if (d+0 <= 10) t10++ } }
/\] capture / { tr = field("trigger"); c[tr]++; cc[tr] += field("cpu_ms"); d = field("diff")
                if (tr == "switch") { if (d == "none") sn++; else if (d+0 <= 2) s2++; else if (d+0 <= 5) s5++ }
                if (field("idle_s") + 0 >= 120) idle++ }
/\] ocr /     { tr = field("trigger"); o[tr]++; oc[tr] += field("cpu_ms"); ow[tr] += field("wall_ms"); if (field("emitted_lines") == 0) noemit++
                app = field("app"); if (app != "") { ao[app]++; aoc[app] += field("cpu_ms"); apps[app] = 1 } }
/\] ax /      { a++; ac += field("cpu_ms"); aw += field("walk_ms"); v = field("verdict"); av[v]++
                if (v == "use" && field("emitted_lines") == 0) anoemit++
                app = field("app"); aa[app]++; aac[app] += field("cpu_ms"); if (v == "use") au[app]++; apps[app] = 1 }
/\] skip /    { skip[field("stage")]++ }
/\] total /   { wall += field("wall_ms"); cpu += field("cpu_ms") }
END {
  hours = wall / 3600000
  printf "Covered: %.2f h of 5-min totals; process CPU %.1f%% of one core\n", hours, (wall ? 100 * cpu / wall : 0)
  ocrcpu = oc["switch"] + oc["changed"]; capcpu = cc["switch"] + cc["changed"]
  printf "Step CPU estimates: OCR %.1f%%, captures %.1f%%, change checks %.1f%% (may overlap other app work)\n",
    (wall ? 100 * ocrcpu / wall : 0), (wall ? 100 * capcpu / wall : 0), (wall ? 100 * tc / wall : 0)
  for (tr in o) printf "OCR via %-7s %5d passes (%.0f/h), mean CPU %d ms, mean wall %d ms\n",
    tr, o[tr], (hours ? o[tr] / hours : 0), oc[tr] / o[tr], ow[tr] / o[tr]
  printf "Passes that emitted nothing new: %d of %d\n", noemit, o["switch"] + o["changed"]
  if (a) {
    printf "Accessibility reads: %d (%.0f/h), mean CPU %d ms, mean walk %d ms, %.1f%% of one core; used text that added nothing: %d\n",
      a, (hours ? a / hours : 0), ac / a, aw / a, (wall ? 100 * ac / wall : 0), anoemit
    for (v in av) printf "  verdict %-8s %d\n", v, av[v]
  }
  if (length(apps)) {
    printf "%-36s %8s %8s %8s %10s\n", "Per app", "ax/h", "ax used", "ocr/h", "CPU %"
    for (app in apps) printf "%-36s %8.0f %8d %8.0f %10.2f\n", app, (hours ? aa[app] / hours : 0), au[app],
      (hours ? ao[app] / hours : 0), (wall ? 100 * (aac[app] + aoc[app]) / wall : 0)
  }
  printf "Change checks: %d, changed %d; diff <=5: %d, <=10: %d\n", t, tch, t5, t10
  printf "Switch captures: never-seen window %d, diff <=2 (already skippable) %d, diff 2-5 %d\n", sn, s2, s5
  printf "Captures with no input for 2+ min: %d\n", idle
  for (s in skip) printf "Skipped at %s: %d\n", s, skip[s]
  if (!wall) { print "No complete 5-minute totals: CPU gate cannot be evaluated."; exit 2 }
}'
