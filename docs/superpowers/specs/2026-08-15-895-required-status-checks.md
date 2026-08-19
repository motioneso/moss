# #895 — make the gate binding: required status checks on `main`

**Status:** Draft for Ben's approval. Authored 2026-08-15.

## The problem is still fully open, and it is worse than the issue says

The issue was filed on 2026-07-09 after PR #893 merged to `main` with red CI, silently stopping
`:edge` from republishing. It proposed marking `verify:foundation` a required status check.

Verified against the live repo on 2026-08-15:

```
gh api repos/motioneso/moss/branches/main/protection   -> 404 "Branch not protected"
gh api repos/motioneso/moss/rulesets                   -> []
```

`main` has **no branch protection rule and no ruleset of any kind**. Nothing is required, nothing
is enforced, and any push or merge lands regardless of CI state. The issue's root-cause section
hedged between "not configured as required" and "admin-bypassed"; it was the former, and five weeks
and several hundred commits later it is still the former.

Two consequences the issue did not name:

- **`gh pr merge --auto` is unusable today, and the repo knows it.** Two committed plans carry the
  warning verbatim: `docs/superpowers/plans/2026-07-18-fin-06-tables-migration.md:751` and
  `docs/superpowers/plans/2026-07-18-1167-module-db-query.md:1122` — _"NEVER `gh pr merge --auto`
  (VF is not a required check and would be skipped)"_. Auto-merge waits only for **required**
  checks; with none required it merges immediately. Fixing #895 retires that trap and makes
  auto-merge safe, which is a real workflow gain and not just a compliance box.
- **The gate is currently enforced by agent discipline alone.** The coordinate skill's merge step
  is a bare `gh pr merge <PR> --squash --delete-branch`
  (`.claude/skills/coordinate/SKILL.md:329`). Whether a PR was green when it merged depends
  entirely on the coordinator having polled `gh pr checks` first. That is a convention, and
  conventions do not survive a tired agent at 3am — which is precisely how #893 landed.

## Goal

Make a red PR unable to reach `main`, with an escape hatch that is deliberate and auditable rather
than a flag on a merge command.

## Non-goals

- Changing what CI runs, how long it takes, or the `docs_only` scope detection. The existing job
  graph is taken as given.
- Requiring image publish on pull requests. Publish failures on `main` are already covered by the
  #1454 edge-publish alarm (`.github/workflows/edge-publish-alarm.yml`); duplicating that as a
  30-minute PR-blocking check buys nothing.
- Requiring review approvals, signed commits, or linear history. Those are separate policy
  questions and bundling them here makes the change harder for Ben to say yes to.

## The conditional-skip problem, which is the whole design

CI does not run the same jobs on every PR. `.github/workflows/ci.yml:19-62` has a `changes` job
that emits `docs_only`, and the downstream jobs gate on it:

| Job (`name:`, which is also the check-run name) | Condition                                            | `ci.yml`   |
| ----------------------------------------------- | ---------------------------------------------------- | ---------- |
| `Detect change scope`                           | always                                               | `:19`      |
| `Verify docs`                                   | `docs_only == 'true'`                                | `:63-68`   |
| `Verify foundation and app`                     | `docs_only != 'true'`                                | `:94-99`   |
| `Compose deployment smoke`                      | `docs_only != 'true'`                                | `:156-161` |
| `Prod compose deployment smoke`                 | `docs_only != 'true'`                                | `:191-196` |
| `Build and publish images`                      | `needs: [verify, compose-smoke, prod-compose-smoke]` | `:255-259` |

So on any given PR, either `Verify docs` is skipped or the other three are. Naming a job that did
not run as a required check is the classic way to deadlock a repository, and it is the single
decision this spec exists to get right.

Observed behaviour on merge commit `389e96488`: `Verify docs` reports as a real check run with
conclusion `skipped` — it is present in the checks API, not absent. That matters, because GitHub
blocks forever on a required check that never reports, while it treats a reported `skipped`
conclusion as satisfied. **This is a load-bearing behavioural assumption and must be proven
empirically, not trusted** — see exit criterion 2.

## Design forks

### Fork 1 — ruleset, or classic branch protection?

**Decision: repository ruleset.**

Steelmanning classic protection: it is what the issue proposes, it is a single `PUT` to
`repos/{owner}/{repo}/branches/main/protection`, and every StackOverflow answer is written against
it. For a one-branch, single-owner repo it is genuinely simpler.

Rulesets win on two properties this repo needs. They are **enumerable** — `gh api
repos/motioneso/moss/rulesets` lists them, so a future agent or audit can detect that the rule was
removed or weakened; classic protection is a 404-or-object, which reads identically to "never
configured" and "deliberately deleted". And they have **bypass actors as first-class, listable
config**, which Fork 4 depends on. Classic protection's `enforce_admins` is a single boolean with
no record of who used it.

### Fork 2 — which check to require?

**Decision: require exactly one aggregate check, added to `ci.yml`. Do not require the individual
job names.**

_Option A — require the four job names directly._ Zero code change, exactly what the issue asked
for, no added runner time (relevant: the CI time budget was its own spec,
`docs/superpowers/specs/2026-08-10-1534-ci-verify-time-budget.md`).

_Option B — add one `CI gate` job with `if: always()` and `needs:` on every other job, which
fails unless each needed job concluded `success` or `skipped`. Require only that check._

Option B is the recommendation, and Option A fails on two counts that are not about effort:

1. **A required check name is remote config; a job name is in-repo code, and they drift silently
   in the dangerous direction.** Rename or delete a job in `ci.yml` and the required check simply
   stops appearing — GitHub blocks on the missing name (annoying but safe) or, if the name was
   removed from the ruleset to unblock, stops gating entirely (silent, and exactly the #895
   failure mode again). With Option B the `needs:` list lives in the repo, is reviewed in the PR
   that changes it, and adding a job without adding it to `needs:` is a visible diff.
2. **Option A hard-codes the conditional-skip semantics into remote config**, so the docs-only path
   and the code path are gated by different sets of names. Option B collapses that to one name that
   is correct under both.

The aggregate job must **fail closed on `cancelled`**. A cancelled job is not a skipped job — in
this repo a `cancelled` conclusion has meant a 35-minute job timeout, i.e. a genuine failure
wearing a neutral-looking label. Treating `cancelled` as pass would reintroduce #895 through the
one door most likely to open under load. The accept-list is `success` and `skipped`; everything
else, including `cancelled`, `failure`, `timed_out`, and an empty result, fails.

The aggregate job carries `needs: [changes, docs-gate, verify, compose-smoke, prod-compose-smoke]`
and deliberately **excludes `publish`**, per the non-goal above.

Contract, as a decision rather than an implementation:

- File: `.github/workflows/ci.yml`, one new job.
- Job id `ci-gate`, `name: CI gate` — this exact string becomes the required check name and must
  not change without updating the ruleset in the same change.
- `if: always()`, so it runs even when a needed job fails or is skipped.
- `runs-on: ubuntu-latest`, `timeout-minutes: 5`. It evaluates `needs.*.result` and exits non-zero
  on any value outside the accept-list; it must name the offending job in its failure output, or
  it converts five distinct failures into one unreadable one.

### Fork 3 — require branches to be up to date before merging?

**Decision: no.** The issue proposes yes; this spec recommends against, and this is the fork most
worth Ben's attention because it is a genuine trade, not a clear win.

The case for yes, stated fairly: it is the only thing that catches a semantic conflict where two
PRs are each green in isolation and broken together — the migration-collision class the issue
names by name.

The case against, which this repo's operating conditions make decisive: with a fleet merging
several PRs a day, every merge invalidates the up-to-date status of every other open PR, forcing a
rebase and a **full CI re-run** on each. That serializes the fleet behind one queue and multiplies
the CI cost that #1534 was written to contain. Meanwhile GitHub already runs `pull_request` checks
against `refs/pull/N/merge` — the merge result, not the PR head — so the common stale-base case is
_already_ covered without the setting.

What the setting would add over that is narrow: conflicts against commits that landed _after_ the
check ran. For the migration-collision case specifically, the repo has better-targeted defences —
the migration numbering invariant, and the cluster-global DDL serialization work in #1013/#1632.
Paying a fleet-wide serialization tax for a case that has a purpose-built guard is the wrong trade.

If Ben prefers yes anyway, GitHub's merge queue is the correct mechanism rather than the raw
setting, and that is a larger change deserving its own spec.

### Fork 4 — who may bypass, and this repo's uncomfortable specific

**Decision: enforce with no bypass actors. The escape hatch is a deliberate ruleset toggle.**

There is a fact here that the issue does not account for and that changes the answer.
`gh api repos/motioneso/moss` reports `admin: true` for the authenticated account, and every agent
in the fleet authenticates as **`motioneso` — the same account as Ben**. There is no token-level
distinction between Ben-the-human and an agent running `gh`.

The consequence is direct: any bypass granted to "repository admin" is granted to every agent. A
ruleset with admin bypass enabled would let `gh pr merge --admin` sail through, and #895 would be
fixed on paper and unchanged in practice. Since the entire point of this issue is removing a
_silent_ path to a red `main`, a bypass that is one flag on a routine command defeats it.

So: no bypass actors. The escape hatch — and there must be one, because the #895 incident was
itself resolved by a direct push to `main` (`33270eef`) that this configuration would block — is
to set the ruleset `enforcement` to `disabled` via `gh api`, land the hotfix, and re-enable. That
is two deliberate privileged calls, both in the audit log, versus one easily-typed flag. Loud is
the feature.

**This is the decision most likely to need Ben's input**, because it constrains him too. It is
recorded as a recommendation, not a settled call.

## Ordering — a hard constraint, not a preference

The workflow change and the ruleset must land in this order, and the reverse order bricks the repo:

1. Merge the `ci-gate` job to `main` **first**.
2. Let it run to completion on `main` at least once, so GitHub has observed a check run by that
   name.
3. **Then** create the ruleset requiring `CI gate`.

Requiring a check name that has never reported puts every open pull request into "Expected —
waiting for status" permanently, including the PR that would fix it. Step 1 is a normal PR that
merges under today's unprotected `main`; that is fine and is the only window in which it can
happen easily.

## Buildability — read this before dispatching a lane

This issue splits cleanly into an agent-buildable half and a Ben-gated half, and forcing either
into the other's shape is how it goes wrong.

**Agent-buildable (Fork 2, step 1 above).** The `ci-gate` job is an ordinary `.github/workflows`
change on a branch with a PR. It is testable in the most direct way available: the PR that adds it
exercises it, and a deliberate red PR proves it fails. A build lane can own this end to end.

**Not agent-buildable (Forks 1, 3, 4, step 3 above).** The ruleset is a privileged repository
settings write affecting every future merge in the repo. The token technically permits it — so an
agent _could_ — but it is a change to a shared system with repo-wide blast radius, and the
correct thing is Ben's explicit go-ahead on the four fork decisions first, then either Ben applies
it or Ben authorizes a specific agent to apply that specific call. It must not be folded into a
build lane as an implied step.

There is also nothing for `verify:foundation` to say about a ruleset: it has no code, no tests, and
no local reproduction. Treating it as buildable would produce a lane that reports green having
proven nothing.

## Risk tier

**`routine`**, mechanically: the diff is one CI workflow job, and no trigger in the tiering table
matches — no migration, no cross-module contract, no export/deletion path, no job-payload shape,
no auth/RLS/secret/network-exposed surface.

Two caveats that are about authorization, not tier, and should not be confused for one:

- The **ruleset application** is admin-privileged and repo-wide, and needs Ben's sign-off
  irrespective of the tier of the code change.
- The live-path gate does not bind here — nothing user-facing changes. The equivalent proof is
  exit criterion 2 below, and it is not optional.

## Exit criteria

1. `CI gate` appears as a check run on `main` with conclusion `success`, at a commit at or after
   the merge of the workflow change.
2. **Empirically proven, both directions, before the ruleset is trusted:**
   - a deliberately-red throwaway PR (e.g. an unformatted markdown file, reproducing #893's exact
     failure) shows `CI gate` **failing** and the PR unmergeable;
   - a docs-only PR — where `Verify foundation and app`, `Compose deployment smoke` and
     `Prod compose deployment smoke` are all skipped — shows `CI gate` **passing** and the PR
     mergeable. This is the deadlock check, and it is the reason the skipped-check assumption above
     is not simply trusted.

   Both throwaway PRs are closed without merging; the check-run conclusions are recorded on #895.

3. `gh api repos/motioneso/moss/rulesets` returns a non-empty array, and the ruleset targets `main`
   with `required_status_checks` containing exactly `CI gate` and an empty bypass list. Recorded on
   the issue as the literal API response, since "I configured it" is not evidence.
4. The two committed plan warnings about `gh pr merge --auto`
   (`docs/superpowers/plans/2026-07-18-fin-06-tables-migration.md:751`,
   `docs/superpowers/plans/2026-07-18-1167-module-db-query.md:1122`) are corrected or annotated as
   superseded — they become actively wrong the moment the ruleset lands, and a stale warning that
   forbids a now-safe command is its own small tax.
5. `.claude/skills/coordinate/SKILL.md:329` is reviewed against the new reality: with a required
   check in place, the merge step can safely use `--auto`. Update it or record why not.

Verification for the workflow change, unpiped, expected `EXIT=0`:

```bash
pnpm format:check > /tmp/fc-895.log 2>&1; echo "EXIT=$?"
```

No full-gate run is required for a workflow-only diff, but CI will run it on the PR regardless —
which is the point.

## Relationship to other work

No file overlap with #1589 or #1013. The only shared surface is `.github/workflows/ci.yml`, which
#1589 does not touch. The #1454 alarm (`.github/workflows/edge-publish-alarm.yml`) is a separate
file and a complementary mechanism: #1454 catches a publish that failed on `main`, #895 stops the
red commit that would have caused it from reaching `main` at all.
