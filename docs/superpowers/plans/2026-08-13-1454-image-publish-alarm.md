# Plan — #1454 `:edge` publish alarm

**Issue:** #1454 (`task`).
**Spec:** `~/Jarv1s/docs/superpowers/specs/2026-08-13-1454-image-publish-alarm.md`.
**Risk:** CI-only; no runtime code, no user-facing surface, no data access. The one hazard is
touching the publish path by accident — the exit criteria forbid it.

## Seams check (verified on this branch)

- `.github/workflows/ci.yml:255-259` — `publish` has `needs: [verify, compose-smoke,
prod-compose-smoke]` and no `if`; any dependency failure or run cancellation skips it silently.
- `.github/workflows/ci.yml:296-298` — `:edge` is computed only for `refs/heads/main`, with
  `push=true`; `pr-*` tags are built but never pushed (`push=false`, line 300-301).
- `.github/workflows/ci.yml:3-9` — CI triggers on push to `main`, `v*` tags, and `pull_request`.
- `.github/workflows/ci.yml:38-42` — push events always classify `docs_only=false`, so on `main`
  every `publish` dependency runs; run conclusion `success` ⟺ publish succeeded.
- `ci.yml` has **no `concurrency` block**, and `git log -S cancel-in-progress --all -- ci.yml`
  is empty — it never had one. Observed cancellations are manual or timeout-driven (a timed-out
  job also reports `cancelled` — memory `cancelled-ci-conclusion-is-a-job-timeout`). The alarm
  must treat `cancelled` as a first-class miss, not an anomaly.
- No notification machinery exists anywhere in `.github/workflows/` (grep for
  `notify|alert|webhook|telegram|slack`: zero hits). This alarm is net-new; nothing to reuse.
- `gh` with `GH_TOKEN: ${{ github.token }}` is the established in-workflow API pattern
  (`ci.yml:32-44`).
- `gh label list` — no alarm-suitable label exists; `edge-publish-alarm` must be created (Task 2).
- `.github/workflows/weekly-release.yml` — own `concurrency` group, tag/pages releases only; no
  interaction with `:edge`.
- Platform facts (GitHub docs, cited in the spec): `workflow_run` workflows execute only the
  default-branch version; cancellation re-evaluates `if` only for currently _running_ jobs, so a
  queued `always()` job downstream of `publish` does not reliably fire
  ([actions/runner#4411](https://github.com/actions/runner/issues/4411)); a re-run emits a fresh
  `completed` event.

## Determinism boundary

No model involvement. All alarm text renders from the `workflow_run` event payload and the
Actions jobs API. There is nothing for a prompt to do here and none is added.

## Task 1 — add `.github/workflows/edge-publish-alarm.yml`

One workflow, one job. The trigger, permissions, and condition blocks are decisions (verbatim);
step internals are behaviour contracts to be written against the real runner.

```yaml
name: Edge publish alarm

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

permissions:
  contents: read
  actions: read
  issues: write
```

Job `alarm`, `runs-on: ubuntu-latest`, `timeout-minutes: 5`, with job-level condition:

```yaml
if: github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'
```

Step contracts (single script step, `GH_TOKEN: ${{ github.token }}`; event fields passed via
`env:`, never interpolated into the script body — same injection posture as `ci.yml:29-35`):

1. **Recovery path** — if `workflow_run.conclusion == 'success'`: find open issues labeled
   `edge-publish-alarm`; for each, comment `":edge published from <sha>"` and close it. Exit 0.
2. **Alarm path** — otherwise: read the triggering run's jobs via
   `gh api repos/$REPO/actions/runs/$RUN_ID/jobs` and extract the `Build and publish images`
   job's conclusion (may be absent when the run died before job creation — report `never ran`).
   If an open `edge-publish-alarm` issue exists, append a comment; else create the issue per the
   spec's content contract (title `ALARM: main <short-sha> did not reach :edge`). Then emit
   `::error title=Edge not published::main <sha> did not reach :edge (publish: <conclusion>)`
   and **exit 1** so this run is red in the Actions list.

Behaviour test cases (each stated with why it would fail against a broken implementation):

- Cancelled `main` run → issue opened naming the run's head SHA. Fails if the implementation used
  an in-run `always()` job (never fires on cancel) or filtered on `conclusion == 'failure'` only.
- Second consecutive miss → comment on the existing issue, still exactly one open alarm issue.
  Fails if dedup queries by title instead of label, or forgets state entirely.
- Successful `main` run with an open alarm → issue closed with the recovering SHA. Fails if the
  recovery path is missing (stale standing alarm).
- `v*` tag release run and PR run → no alarm activity at all. Fails if scoping relies only on the
  `branches:` filter.

## Task 2 — create the label (one-time, at implementation)

```bash
gh label create edge-publish-alarm --color B60205 --description "A main merge did not reach :edge"; echo "EXIT=$?"
```

Expected `EXIT=0` (or already-exists on retry — acceptable; record in the PR).

## Task 3 — pre-merge verification (this repo's own gates)

The change is one new YAML file; CI's docs-only filter will not apply (path under `.github/`), so
the full gate runs. Locally, before the PR:

```bash
pnpm format:check > /tmp/1454-fmt.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

```bash
pnpm check:file-size > /tmp/1454-size.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

## Task 4 — post-merge observational proof (the real e2e for this feature)

A `workflow_run` workflow cannot fire from a PR branch, so the live proof runs immediately after
the implementation PR merges, using that merge's own CI run. **Only ever cancel/re-run the
current head-of-main run** — a green re-run of an older run would repoint `:edge` at a stale SHA.

1. Capture the run id for the merge commit:
   `gh run list --workflow CI --branch main --limit 1 --json databaseId,headSha; echo "EXIT=$?"`
   — expected `EXIT=0`, `headSha` = the merge commit.
2. `gh run cancel <id>; echo "EXIT=$?"` — expected `EXIT=0`.
3. Within ~5 minutes of the CI run reporting `cancelled`, expect: a red `Edge publish alarm` run,
   and `gh issue list --label edge-publish-alarm --state open --json number,title; echo "EXIT=$?"`
   — expected `EXIT=0` with exactly one issue whose title names the merge short-SHA.
4. `gh run rerun <id>; echo "EXIT=$?"` — expected `EXIT=0`. After CI completes green: `publish`
   succeeded, and step 3's issue is closed with the recovery comment
   (`gh issue list --label edge-publish-alarm --state open` returns empty).
5. Record the transcript of 1–4 on the implementation PR (bounded textual evidence, no
   screenshots) — this is the feature's live-path artifact.

## Kill gate

**Observation that ends the line:** after the implementation merge, the cancel test (Task 4 step 3) produces no red alarm run within 5 minutes of the CI run completing as `cancelled`. That means
the `workflow_run` trigger model is wrong in practice — stop; do not iterate blind on YAML. The
fallback (scheduled `:edge`-digest drift check, recorded in the spec) needs its own decision.
**Call:** Coordinator, escalating to Ben with the observed event payloads.

Phase 1 (this plan) ships alone. The "considered, not proposed" items in #1454 (build/release
split, main cancel-in-progress exemption) are not planned until this alarm has been observed
firing and recovering in production traffic.

## Exit criteria

- Alarm observed firing on the cancelled path and recovering on the success path (Task 4).
- `git diff` of the implementation PR touches only `.github/workflows/edge-publish-alarm.yml` —
  zero changes to `ci.yml` or the publish gate.
- Verification transcript recorded on the implementation PR.
- #1454 commented with the evidence and the board updated.
