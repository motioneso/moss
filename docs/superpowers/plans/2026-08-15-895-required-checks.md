# Plan — #895: `ci-gate` aggregate required-status-check job

**Spec:** `docs/superpowers/specs/2026-08-15-895-required-status-checks.md` (approved; read via
`git show 4a63274cb:...` — not present on this branch's history, branch cut from `origin/main` @
`389e96488` predates that doc commit on `main`. Content verified current against this branch's
`.github/workflows/ci.yml`, see Seams check below.)
**Issue:** Part of #895
**Risk tier:** `routine` (per handoff — CI workflow config only)

## Scope (per handoff, narrower than the spec's full exit criteria)

**In scope — this lane builds:**

- The `ci-gate` job in `.github/workflows/ci.yml` (spec Fork 2, Option B).
- PR open, rebased on `origin/main`, `ci-gate` itself runs and passes on the PR.

**Out of scope — explicitly excluded by the handoff's collision notes and Buildability section
of the spec (Ben-gated / coordinator-only):**

- Applying the repository ruleset (`gh api .../rulesets`) that requires the `CI gate` check —
  admin-privileged, repo-wide blast radius, Fork 1/3/4 need Ben's sign-off first.
- The throwaway red/docs-only proof PRs (spec exit criterion 2) — those exercise the check
  _after_ this PR has merged and run once on `main` (spec Ordering section), not before.
- Correcting the `gh pr merge --auto` warnings in the two migration plans and
  `.claude/skills/coordinate/SKILL.md:329` (spec exit criteria 4-5) — spec says these "become
  actively wrong the moment the ruleset lands"; the ruleset isn't landing in this lane, so
  correcting them now would itself be premature/wrong. Left for the lane that applies the
  ruleset.
- `docs/coordination/` is coordinator-only — not touched.

## Seams check (file:line citations from this branch's HEAD)

- `.github/workflows/ci.yml:19` — job id `changes`, output `docs_only` (`:24`).
- `.github/workflows/ci.yml:63` — job id `docs-gate`, `if: needs.changes.outputs.docs_only ==
'true'`.
- `.github/workflows/ci.yml:94` — job id `verify`, `if: needs.changes.outputs.docs_only !=
'true'`.
- `.github/workflows/ci.yml:156` — job id `compose-smoke`, same condition.
- `.github/workflows/ci.yml:191` — job id `prod-compose-smoke`, same condition.
- `.github/workflows/ci.yml:255` — job id `publish`, `needs: [verify, compose-smoke,
prod-compose-smoke]` — spec's non-goal says do not require `publish`; confirmed absent from the
  `ci-gate` needs list below.
- No `ci-gate` job exists yet anywhere in `.github/workflows/` (`grep -rn ci-gate .github` →
  empty) — spec's core premise still holds, nothing drifted since spec authoring.
- This PR's own diff is exactly one file, non-docs (`.github/**` is explicitly excluded from the
  docs-only path at `ci.yml:47`) — so `changes` will classify this PR as full-gate, exercising
  `verify`, `compose-smoke`, and `prod-compose-smoke` for real on the PR itself. That's the e2e
  proof for this phase (see below); no separate throwaway PR is needed to prove the job runs.

## Task 1 (only task) — add the `ci-gate` job

**File:** `.github/workflows/ci.yml`, new job appended after `prod-compose-smoke` (`:191-253`),
before `publish` (`:255`).

Exact job contract (spec Fork 2, decision-level — this is the whole deliverable, not illustrative
code, so it's specified in full per the DDL exception in `plan-build` step 2):

```yaml
ci-gate:
  name: CI gate
  runs-on: ubuntu-latest
  timeout-minutes: 5
  needs: [changes, docs-gate, verify, compose-smoke, prod-compose-smoke]
  if: always()

  steps:
    - name: Check required job results
      env:
        NEEDS_JSON: ${{ toJSON(needs) }}
      run: |
        set -euo pipefail
        failed=""
        for job in changes docs-gate verify compose-smoke prod-compose-smoke; do
          result=$(echo "$NEEDS_JSON" | jq -r --arg job "$job" '.[$job].result')
          echo "$job: $result"
          case "$result" in
            success|skipped) ;;
            *) failed="$failed $job=$result" ;;
          esac
        done
        if [ -n "$failed" ]; then
          echo "::error title=CI gate failed::Required job(s) did not pass:$failed"
          exit 1
        fi
        echo "All required jobs passed or were skipped."
```

Decisions locked by the spec, restated so the code review has them without re-opening the spec:

- Job id `ci-gate` / `name: CI gate` — this exact string is the future required-check name; must
  not silently drift.
- `if: always()` — must still run and report when an upstream job fails or is skipped, otherwise
  GitHub never sees a conclusion to gate on.
- Accept-list is exactly `success` and `skipped`. Everything else — including `cancelled` — fails
  closed. `jq -r '.[$job].result'` on a job GitHub cancelled reports `cancelled`, which falls into
  the `*)` branch and fails; no separate case needed for it, but call it out in the PR description
  since it's the one spec explicitly worried about reintroducing.
- Names every offending job in the failure output (`$failed`), not just "something failed".
- `docs-gate` is in the `needs` list; on a non-docs PR (this one) it reports `skipped` — that's
  accept-listed the same as `success`, which is exactly the deadlock the spec's exit criterion 2
  is worried about. This lane can't run the reverse (docs-only) case — see Out of scope — but this
  PR's own run proves the non-docs half of that logic (`docs-gate` skipped, `ci-gate` still
  passes).

**Why this task alone constitutes the phase:** it's a single additive job in a single file with no
code-path dependents; there's nothing to split further and nothing to sequence it against (spec:
"No file overlap with #1589 or #1013").

## Verification

Unpiped, exit code checked, per spec's stated command and `plan-build` step 5:

```bash
pnpm format:check > /tmp/fc-895.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Local YAML sanity (catches a broken block scalar or indentation before spending a CI round-trip;
this repo has no `actionlint`):

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" ; echo "EXIT=$?"
```

Expected: `EXIT=0`.

**Phase e2e proof (plan-build step 4):** the PR itself, pushed to `origin`. Observe in `gh pr
checks <PR>`:

- `changes` → `success` (classifies this PR as non-docs since `.github/**` is excluded from the
  docs-only allowlist).
- `docs-gate` → `skipped`.
- `verify`, `compose-smoke`, `prod-compose-smoke` → `success` (full gate, since non-docs).
- `CI gate` → `success`, and its job log shows all five `needs` entries printed with their
  results.

This is the actual evidence for spec exit criterion 1 ("`CI gate` appears as a check run ... with
conclusion `success`") once this later runs on `main` post-merge — the coordinator's job, not
this lane's, per handoff.

No full local gate run is required for a workflow-only diff (spec says so explicitly); CI runs it
for real on the PR, which is the point.

## Kill gate

There is only one phase and one task. If `ci-gate` reports something other than the expected
`success` + skip pattern above on the PR (e.g. `docs-gate` reports something other than `skipped`,
or `ci-gate` fails despite all `needs` succeeding), stop and re-examine the `jq` expression/`needs`
list before pushing a fix — don't iterate blind on CI. Owner: this lane; escalate to coordinator if
the cause isn't obvious from the job log within one round-trip.

## Determinism boundary

N/A — no user-facing surface, no model involvement. CI config only.
