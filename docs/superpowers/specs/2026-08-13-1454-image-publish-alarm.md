# Spec — #1454 alarm when a main merge does not reach `:edge`

Date: 2026-08-13
Issue: #1454 (`task`)
Status: proposed — awaiting approval
Scope: `.github/workflows/` only. No runtime code, no change to what is allowed to publish.

## Problem

Prod tracks the rolling `:edge` tag with Watchtower unattended, so every merge to `main` is
expected to reach users without anyone watching. The `publish` job
(`.github/workflows/ci.yml:255-259`) declares `needs: [verify, compose-smoke,
prod-compose-smoke]`; when any dependency fails **or the run is cancelled**, `publish` is skipped.
A skipped job is not a failure, so nothing attributes the miss to the release: between 2026-08-06
and 2026-08-13, four consecutive `main` merges never reached `:edge` and prod silently ran the
#1439 image throughout (evidence table in #1454).

The gate is correct — a red `verify` must keep blocking `:edge`. The silence is the defect.

## Decision summary (locked)

1. **Companion workflow, not an in-run job.** A new workflow
   `.github/workflows/edge-publish-alarm.yml` triggered by `workflow_run` on CI completion, scoped
   to `main` pushes. See "Rejected: in-run `if: always()` job" for why the obvious alternative
   cannot work.
2. **The signal is a GitHub issue plus a red alarm run.** When a `main` CI run completes with any
   conclusion other than `success`, the alarm job (a) opens — or appends to an already-open —
   issue labeled `edge-publish-alarm` naming the head SHA that did not reach `:edge`, and (b)
   exits non-zero with an `::error` annotation, so the Actions list shows a red run whose name
   states the miss.
3. **Self-resolving.** When a `main` CI run completes with conclusion `success`, the alarm job
   closes any open `edge-publish-alarm` issue with a comment naming the SHA that reached `:edge`.
   A stale standing alarm trains people to ignore it; recovery must be observable too.
4. **The publish gate is untouched.** The alarm workflow gets `issues: write`, `actions: read`,
   `contents: read` — never `packages: write`. The implementation diff must show zero changes to
   the `publish` job or its `needs`.
5. **Verification is observational but safe.** The issue's suggestion of merging a known failure
   to `main` is replaced by cancel-then-rerun of the implementation PR's own merge run
   (Acceptance, below). Nothing broken lands on `main`; `:edge` ends at true head-of-main.

## Rejected: in-run `if: always()` job

The smallest-looking fix — an alarm job in `ci.yml` with `needs: [publish]` and
`if: always() && github.ref == 'refs/heads/main'` — fails on exactly the dominant historical
cause. Three of the five misses in #1454 were **run cancellations**, and on cancellation GitHub
re-evaluates `if` conditions only for _currently running_ jobs; a downstream job still queued
behind `publish` is cancelled (or worse, left zombie-queued —
[actions/runner#4411](https://github.com/actions/runner/issues/4411)) rather than started
([workflow cancellation
reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)).
`always()` jobs also resist cancellation
([community #25789](https://github.com/orgs/community/discussions/25789)). The one case an in-run
job does cover — red `verify` — is the case where the run is already visibly red. Steelmanned and
rejected: it is simpler, but it cannot alarm on the failure mode that caused the incident.

A scheduled drift check (compare the `:edge` image's revision label against head-of-main on a
cron) would catch even runs that never started, but needs GHCR digest parsing and a polling
cadence — more surface than one alarm justifies. Recorded as the fallback if `workflow_run` is
ever observed insufficient; not proposed now.

## Platform semantics the design rests on

- A `workflow_run`-triggered workflow only exists once its file is on the **default branch**, and
  always executes the default-branch version — so it cannot be live-tested from a PR branch;
  verification happens immediately after merge
  ([events docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)).
- The trigger fires on `completed` for **every** conclusion, including `cancelled` — this is what
  makes it immune to the in-run job's blind spot.
- Scope guard lives in the job condition, not only the `branches:` filter:
  `github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'`.
  This excludes PR runs and `v*` tag releases regardless of filter subtleties.
- On a `main` push, run conclusion `success` ⟺ `publish` succeeded: push events always classify
  `docs_only=false` (`ci.yml:38-42`), `publish` has no `if`, and every other non-skipped job is
  one of its dependencies. So the alarm condition is simply `conclusion != 'success'`.
- A re-run emits a fresh `completed` event, so a rerun that publishes triggers the recovery path.

## Alarm content contract

Everything rendered from the `workflow_run` payload and the Actions jobs API — no model
involvement anywhere in this feature.

- Issue title: `ALARM: main <short-sha> did not reach :edge`.
- Issue body: full head SHA, head commit title, the `publish` job's conclusion for that run
  (`skipped` / `cancelled` / `failure`, read via the jobs API), a link to the run, and the
  reminder that prod continues running the previous `:edge`.
- Dedup: at most one open `edge-publish-alarm` issue; subsequent misses append comments to it.
- Label `edge-publish-alarm` is created once at implementation time (`gh issue create` fails on a
  missing label).

## Acceptance

- A merge to `main` whose `publish` is skipped, cancelled, or failed produces a red
  `edge-publish-alarm` run **and** an open labeled issue naming the head SHA — confirmed by
  observation, not by reading YAML.
- A subsequent successful `main` publish closes the open alarm issue with the recovering SHA.
- A red gate still blocks `:edge`: the implementation diff contains no change to the `publish`
  job.
- Safe observation method (replaces the issue's merge-a-known-failure suggestion): after the
  implementation PR merges, `gh run cancel` the CI run of that very merge commit — the alarm must
  fire on the cancelled path, the hardest case — then `gh run rerun` it so `publish` completes and
  the recovery path closes the issue. **Never re-run an older `main` run to test**: if it went
  green it would repoint `:edge` at a stale SHA.

## Out of scope

Recorded in #1454 and deliberately not here: splitting build from release (inert `:main-<sha>`
push + re-tag), exempting `main` from cancel-in-progress (no `concurrency` block exists in
`ci.yml` today; cancellations observed have been manual or timeout-driven), and any non-GitHub
notification channel — Telegram/webhook would add a service and a secret for one alarm, against
the constraint in the handoff. GitHub's native notifications on the alarm issue reach the owner;
an out-of-band ping, if ever wanted, is a subscriber to GitHub notifications, not a workflow
change.
