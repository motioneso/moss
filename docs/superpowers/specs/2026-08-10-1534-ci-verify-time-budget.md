# #1534 — Give CI verify bounded headroom and explicit phase timeouts

**Date:** 2026-08-10

**Status:** Proposed for Fable review

**Tracking:** [#1534](https://github.com/motioneso/moss/issues/1534)

**Grounded on:** `origin/main` = `97feaffc5b` (fetched 2026-08-10), the 12 most recent
successful `main` CI runs as of run `31364837064`, a 24-run branch foundation sample, and timed-out
runs `31353585447`, `31359330960`, and `31363966415` attempt 2

## Outcome

Keep foundation and Playwright in the existing `Verify foundation and app` job, raise that job's
hard backstop from 35 to 45 minutes, and give its two long phases explicit process deadlines:

- `Verify foundation`: 30 minutes;
- `Run Playwright smoke tests`: 10 minutes.

Each phase preserves the command's real nonzero exit and emits a stable `CI_PHASE_TIMEOUT` error
annotation only when GNU `timeout` regains control with status 124. A red Playwright suite therefore
remains red and cannot consume the extra job headroom: it fails on its own result or receives TERM
after 10 minutes. The timeout marker names the exhausted phase budget; it does not classify the
underlying failure as infrastructure.

This is one implementation session and one workflow file. Do not split jobs, add a helper script,
change Playwright configuration, change test semantics, or touch application code.

## Current truth

### Workflow shape

`.github/workflows/ci.yml` currently has three independent full-gate jobs after change-scope
detection:

- `Verify foundation and app` has `timeout-minutes: 35`. It starts the database, runs
  `pnpm verify:foundation`, release-hardening checks, the web build, Chromium installation, and
  `pnpm test:e2e` sequentially, then tears the database down under `if: always()`.
- `Compose deployment smoke` has its own 25-minute budget.
- `Prod compose deployment smoke` has its own 30-minute budget.

The compose jobs do not consume the verify job's 35 minutes and need no change. Foundation and
Playwright do share that budget; changing only the job cap would let a red e2e suite run longer
without making its failure clearer.

### Recent green-main durations

These are GitHub's job/step `started_at` to `completed_at` durations for the 12 most recent
successful `main` runs returned on 2026-08-10. Pushes to `main` always take the full-gate path even
when the merged change is documentation-only.

|           Run | Verify job | Foundation step | Playwright step |
| ------------: | ---------: | --------------: | --------------: |
| `31364837064` |     23m52s |          19m33s |           2m21s |
| `31362671723` | **32m42s** |      **27m33s** |           2m23s |
| `31345020048` |     23m55s |          19m36s |           2m27s |
| `31344248354` |     24m15s |          19m55s |           2m25s |
| `31339198171` |     24m27s |          19m56s |           2m22s |
| `31338047338` |     24m18s |          19m53s |           2m24s |
| `31337822912` |     24m58s |          20m25s |           2m34s |
| `31337762681` |     24m17s |          19m58s |           2m22s |
| `31336446303` |     23m56s |          19m43s |           2m20s |
| `31335329483` |     24m32s |          20m09s |           2m22s |
| `31335310516` |     22m28s |          18m27s |           1m48s |
| `31335278990` |     24m27s |          20m01s |           2m23s |

The median verify job is about 24m18s. Eleven runs finished between 22m28s and 24m58s; run
`31362671723` is the material tail at 32m42s. Its 27m33s foundation step, not Playwright, caused the
tail. The current 35-minute job cap left that healthy run only 2m18s of nominal headroom.

### Branch foundation distribution and Playwright overruns

The 24-run branch foundation sample does not support the workflow's stale "branch VF runs ~+75% vs
main" comment. Nineteen of the 24 sampled runs reached a full foundation step: eighteen between
18m23s and 21m28s, plus one 26m31s tail. The remaining five failed foundation within 1m39s and carry
no duration signal. The maximum foundation duration anywhere in the branch and green-main samples
is the 27m33s main tail above. Replace the old #1127 attribution; do not carry it into the new
comment.

All three repeated 35-minute job timeouts completed foundation green and overran while Playwright
was active:

|                     Run | Foundation | Playwright before job cancellation |
| ----------------------: | ---------: | ---------------------------------: |
| `31353585447` attempt 2 |     18m23s |                             15m03s |
| `31359330960` attempt 2 |     20m30s |                             12m53s |
| `31363966415` attempt 2 |     21m28s |                             11m39s |

This directly grounds the 10-minute Playwright deadline: every observed overrun crosses it before
the ambiguous 35-minute job cancellation, while the green-main maximum is only 2m34s. The deadline
would have named the exhausted Playwright budget on all three runs; it would not have made their
underlying test failures an infrastructure problem.

The chosen budgets are evidence-based rather than additive guesses:

- 30 minutes gives the 27m33s maximum foundation step 2m27s of phase headroom and remains below the
  current whole-job failure ceiling.
- 10 minutes is nearly four times the 2m34s green Playwright maximum and is below all three observed
  Playwright overruns.
- The worst observed non-phase workflow-step overhead is 2m43s. The required invariant is therefore
  `45m >= 30m foundation + 10m Playwright + 2m43s non-phase overhead`, leaving 2m17s for runner
  bookkeeping and variance. Re-measure this overhead and recheck the inequality whenever a step is
  added to or made heavier in the verify job.

### Why GitHub says `cancelled`

GitHub documents `jobs.<job_id>.timeout-minutes` as the maximum job runtime before GitHub
"automatically cancels it." Accordingly, all three timeout runs above expose the workflow run,
`Verify foundation and app`, and the in-flight `Run Playwright smoke tests` step as
`conclusion: cancelled` through the Actions job API and check-run API. In each run:

- the active Playwright log ends with only `The operation was canceled.`; and
- the `if: always()` database cleanup then succeeds.

This is the same public conclusion and terminal text an external cancellation can produce;
`timed_out` is an allowed generic Checks API conclusion, but GitHub did not use it for these Actions
jobs. The fixed 35-minute signature proves the present incidents operationally, but the metadata
does not name the cause.

GitHub separately documents step `timeout-minutes` as killing the process, which still leaves the
diagnostic wording under runner control. The implementation therefore uses Ubuntu's already
installed GNU `timeout --verbose` inside the two shell steps. When the child exits after GNU
`timeout` sends TERM, status 124 plus the explicit annotation is the unambiguous phase-budget signal;
an external cancellation does not come from that timer and does not emit `CI_PHASE_TIMEOUT`.

References:

- [GitHub workflow syntax: job timeout](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)
- [GitHub workflow syntax: step timeout](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsstepstimeout-minutes)
- [Timed-out run `31363966415`, attempt 2](https://github.com/motioneso/moss/actions/runs/31363966415/attempts/2)
- [Timed-out run `31359330960`, attempt 2](https://github.com/motioneso/moss/actions/runs/31359330960/attempts/2)
- [Timed-out run `31353585447`, attempt 2](https://github.com/motioneso/moss/actions/runs/31353585447/attempts/2)
- [Green-tail run `31362671723`](https://github.com/motioneso/moss/actions/runs/31362671723)

## Locked implementation

Edit only `.github/workflows/ci.yml`.

1. Change the verify job to `timeout-minutes: 45` and replace the stale #1127 stopgap comment with a
   short #1534 comment explaining that phase deadlines preserve fast failure.
2. Replace the foundation step's one-line command with this inline shell body:

   ```bash
   status=0
   timeout --verbose --signal=TERM 30m pnpm verify:foundation || status=$?
   if [ "$status" -eq 124 ]; then
     echo "::error title=CI phase timeout::CI_PHASE_TIMEOUT phase=verify-foundation budget=30m issue=#1534"
   fi
   exit "$status"
   ```

3. Replace the Playwright step's one-line command with the same body using `10m`,
   `pnpm test:e2e`, and `phase=playwright`.
4. Preserve the command exit status exactly. Do not use `continue-on-error`, `|| true`, retries,
   Playwright `--max-failures`, or a larger Playwright test timeout.
5. Leave step order, the database lifecycle, release-hardening checks, web build, browser install,
   compose jobs, path classification, and image publishing unchanged.

Do not add `--kill-after` in this change. The 30- and 10-minute values are soft bounds: GNU
`timeout` sends TERM at the deadline, then waits. A child that exits in response lets the wrapper
return 124 and emit `CI_PHASE_TIMEOUT`; a TERM-resistant child can exit late. If it never exits, the
log may show only `timeout: sending signal TERM` before the 45-minute job cap cancels the job. The
hard job cap remains the last-resort bound.
`--kill-after` would not harden this: when its escalated SIGKILL fires, GNU `timeout` returns 137
rather than 124, so the `-eq 124` guard would drop the annotation in exactly the case it exists to
name.

## Failure semantics after the change

| Event                                         | Result and evidence                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation assertion/lint/type/test failure   | Existing nonzero status propagates immediately; no timeout annotation                                                                                                                 |
| Foundation exceeds 30m and exits on TERM      | Wrapper exits 124 and reports `CI_PHASE_TIMEOUT phase=verify-foundation budget=30m`                                                                                                   |
| Playwright assertion failure                  | Existing nonzero status propagates immediately with Playwright output; no timeout annotation                                                                                          |
| Playwright exceeds 10m and exits on TERM      | Wrapper exits 124 and reports `CI_PHASE_TIMEOUT phase=playwright budget=10m`; inspect preceding reporter output before attribution                                                    |
| Phase child resists TERM                      | Soft deadline can finish late; a non-exiting child may show only GNU `timeout`'s TERM message before the 45m job cap                                                                  |
| External cancellation before a phase deadline | GitHub reports `cancelled`; no `CI_PHASE_TIMEOUT` marker                                                                                                                              |
| Unexpected whole-job overrun                  | The 45m hard backstop still cancels the job; its elapsed-time signature identifies the backstop, while the last completed phase markers show whether either named phase expired first |

This does not turn a phase timeout green and does not reinterpret a timeout as a test assertion.
The stable marker answers whether one of the two known long phases exhausted its own budget, not
why. In particular, `CI_PHASE_TIMEOUT phase=playwright` is not inherently an infrastructure failure:
inspect the Playwright reporter output first. Reported assertion failures, test timeouts, or mass
skips remain red e2e evidence; only the evidence, not the marker, determines attribution.

## One-session implementation and verification plan

1. Refresh from current `origin/main` and confirm `.github/workflows/ci.yml` still has the same
   verify step order and 35-minute cap. If the job has been split or its budgets changed, stop and
   return the spec for re-grounding.
2. Make only the locked workflow edit above.
3. Run Prettier against the workflow and inspect the exact diff. No local database or full
   foundation run is needed for a YAML-only change.
4. Exercise the inline timeout shape locally with a one-second `sleep` substitute and prove a child
   that honors TERM exits 124 with one `CI_PHASE_TIMEOUT` marker. Exercise a command that exits 7
   and prove status 7 propagates without that marker. Also use a bounded disposable command that
   briefly ignores TERM to prove the deadline is soft and the wrapper returns only after the child
   exits. These checks use disposable shell commands, not a committed test helper.
5. Commit the single workflow file and open the implementation PR under #1534. Its automatic
   current-head CI run is the real integration check; do not manually rerun a stale head.
6. Acceptance requires one mechanically green `Verify foundation and app` job. Record the verify,
   foundation, and Playwright durations from that run. A red test remains red; do not raise any
   budget in response within this task.

## Acceptance

- `.github/workflows/ci.yml` is the only changed file.
- The verify job has a 45-minute hard cap, foundation has a 30-minute process deadline, and
  Playwright has a 10-minute process deadline.
- A simulated phase overrun exits 124 and emits exactly one stable `CI_PHASE_TIMEOUT` annotation
  naming the phase and budget.
- A simulated TERM-resistant child demonstrates that the phase deadline is soft and may complete
  late; the 45-minute job cap remains the hard bound.
- A simulated ordinary nonzero exit is propagated unchanged and emits no timeout marker.
- The automatic CI run passes foundation, release hardening, build, Playwright, cleanup, and the two
  unchanged compose smoke jobs.
- No test is skipped, retried, waived, given a longer assertion timeout, or allowed to continue on
  error.
- The implementation PR records the three measured durations; unexpected new tail growth becomes a
  separate performance issue rather than another timeout increase in #1534.
- A Playwright timeout marker is attributed only after its reporter output is inspected; the marker
  alone is never treated as an infrastructure waiver.

## Non-goals

- No application, test, mock, Playwright config, worker-count, reporter, or database change.
- No job split, matrix, cache redesign, test sharding, new action, helper script, or dependency.
- No correction or closure of #1127, #1509, or any other issue.
- No diagnosis, workaround, rerun, or merge decision for PR #1482. Its e2e failures remain that
  branch's responsibility and are not evidence for increasing this task's phase budgets.
- No board mutation or unrelated CI cleanup.
