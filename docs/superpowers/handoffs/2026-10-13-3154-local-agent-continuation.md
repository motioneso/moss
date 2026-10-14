# Finish scheduled/proactive work with local agents

Current status: 2026-10-13. Parent: #3096. Integration PR: [#3154](https://github.com/motioneso/moss/pull/3154).

## Start here

The reviewed source is pushed in three draft PRs. Finish actual local database, final-image and installed UI/worker proof before merging them. Hosted CI and independent source review are green at the pins below, but the final full foundation and live acceptance are still incomplete. These are **code-complete, unverified** features, not completed roadmap work.

Use local Docker, the supported browser harness and an existing real Codex sign-in. Stop investigating the cloud browser-download problem. Do not spend money, add a paid fallback, rewrite Moss responses, substitute screenshots for assertions, or omit Workshop/notification proof. Existing subscription allowance only; capacity exhaustion is a blocker to report.

First finish #3500, then compose and finish #3507, then finish inert-agreement #3508. Remaining feature waves are listed below; they have not been built by this handoff.

## Exact published inputs

All three PRs currently target `integration/scheduled-proactive` at `8c4b1aff52ee83967ab668e5d3f0a74e760e5a87`. #3154 targets `main`.

| PR                                                   | Branch                                     | Published head                             | Published tree                             |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| [#3500](https://github.com/motioneso/moss/pull/3500) | `scheduled/3148-side-chat-destination`     | `11e7fd7585125a8c9acfdab3ea3e4aedda280f3c` | `f22df850b1c42de7ddf11e579972d8d219025684` |
| [#3507](https://github.com/motioneso/moss/pull/3507) | `scheduled/3138-repeating-useful-checks`   | `9725e019d4a87c886d9cf8646e940e9dff79fcf2` | `f9dd9b19605389e1db13238fb1bf151e67235adf` |
| [#3508](https://github.com/motioneso/moss/pull/3508) | `scheduled/3142a-bounded-action-agreement` | `d9f89c209f72c2d0305604dc87085f28e5a40f33` | `7cd63610e60c68fd8d8b236d951dff3ba703a11b` |

The publication audit has all three open, draft and unmerged, with 19 successful and 3 skipped checks and five successful workflows per head. Image build/publication was skipped; hosted green does not prove a final installed image. Local source trees match these published remote trees. #3154 currently exposes no checks for its current head and reports `mergeable=false`; reconcile the actual integration/main state before final acceptance. Re-read GitHub before acting; this document is a checkpoint, not live status. Independent source review found no remaining identified blocker on these published inputs. No GitHub review submission is claimed. Earlier local commit IDs can differ because publication preserved exact source trees; compare the published tree, not an older local SHA.

## Repository rules and source references

Read `AGENTS.md`, `CLAUDE.md` and `docs/DEVELOPMENT_STANDARDS.md` first. Check `.agents/skills` if present; this checkout instead contains `.agents/rules/moss-ui.md` and relevant skills under `.claude/skills`.

Read these relevant skills in full:

- `.claude/skills/verify-gate/SKILL.md`: all DB-touching checks go through `scripts/run-gate.sh`.
- `.claude/skills/shared-checkout/SKILL.md`: coordinate before tree-wide Git operations; explicit-path commits only.
- `.claude/skills/coordinate/SKILL.md` and its `uat-trigger-map.tsv` / `resolve-uat-triggers.sh`: ownership, proof and change-selected UAT.
- `.claude/skills/design-system/SKILL.md` before any UI repair.

Accepted scope and detailed lane context:

- `docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md`
- `docs/superpowers/plans/2026-10-08-scheduled-proactive-dispatch-seams.md`
- `docs/superpowers/plans/2026-10-08-scheduled-proactive-migration-decisions.md`
- `docs/superpowers/plans/2026-10-08-scheduled-proactive-implementation-state.md` (historical ledger; verify current frontier on GitHub)
- `docs/superpowers/plans/2026-10-12-3148-side-chat-destination.md` (its current-state section supersedes older experimental designs)
- `docs/superpowers/plans/2026-10-12-3151-scheduled-owner-read.md`
- `docs/superpowers/plans/2026-10-12-3152-configured-source-report.md`
- #3507: `docs/superpowers/plans/2026-10-13-3138-repeating-useful-checks.md` and `docs/superpowers/handoffs/2026-10-13-3138-repeating-useful-checks.md`
- #3508: `docs/superpowers/plans/2026-10-13-3142a-bounded-action-agreement.md` and `docs/superpowers/handoffs/2026-10-13-3142a-evidence.md`

This dated current-status checkpoint **supersedes the stale pending scoped-DB statements** in the #3138 and #3142a committed evidence documents and [#3500's historical pause comment](https://github.com/motioneso/moss/pull/3500#issuecomment-6138324087). The newer isolated scoped-DB results below did execute. It does not supersede unresolved full-foundation, final-image or installed live-proof blockers. Older documents retain historical failures; neither ledger replaces fresh final-head proof.

## Local checkout and pinning

Use a clean, agent-owned worktree. Do not switch, reset or stash another agent's checkout. The paths below use the repository's required public documentation convention; adjust the owned worktree suffix locally if needed. These commands do not modify an existing shared worktree.

```bash
set -euo pipefail
cd ~/Jarv1s
git fetch origin main integration/scheduled-proactive \
  scheduled/3148-side-chat-destination \
  scheduled/3138-repeating-useful-checks \
  scheduled/3142a-bounded-action-agreement

git worktree add -b local/3500-final-proof ~/Jarv1s-scheduled-3500 \
  origin/scheduled/3148-side-chat-destination
cd ~/Jarv1s-scheduled-3500
test "$(git rev-parse HEAD)" = 11e7fd7585125a8c9acfdab3ea3e4aedda280f3c
test "$(git rev-parse HEAD^{tree})" = f22df850b1c42de7ddf11e579972d8d219025684
test -z "$(git status --porcelain)"
node --version
pnpm --version
docker version
pnpm install --frozen-lockfile
```

Use analogous isolated worktrees for #3507 and #3508, replacing branch, head and tree with the exact table values. If the remote moved, stop and reconcile the new delta; do not silently label its receipts as proof of the pins above. Record installed dependencies/toolchain, dirty status and the actual tested tree. Never force-push a reviewed feature branch.

## Parallel ownership

One coordinator owns the integration frontier, migration assignments, PR publication and merge decisions. Each writer gets its own worktree and explicit file ownership. Read-only reviewers may run concurrently; they do not commit corrections into a builder's tree.

1. **Destination proof owner:** #3500 only. Own its local gates, final image, 14 selected live specs, any narrowly scoped repairs and public evidence.
2. **Repeating-read owner:** #3507 only. Initially inspect its 0321 composition requirements and repeat-check proof. Wait for #3500 to merge before editing the composed trigger/runner/DTOs. Then own that composition and fresh checks.
3. **Agreement proof owner:** #3508 only. Own inert-agreement tests and proof. No execution handler, reminder/job creation, Resume, deletion or action-scope editing. Reconcile on the latest integration before final proof; serialize shared chat/Settings/manifest edits with the other writer.
4. **Independent reviewers:** split security/concurrency/SQL authority from product/contracts/app-map/UI. Review final bytes after every repair or composition. Require intended-failure controls, not just green tests.

Do not co-edit `packages/chat/src/reminders/*`, `scheduled-reads/runner.ts`, live persistence, shared scheduled-task DTOs, Settings composition, chat manifest or schema inventory. Explicitly transfer ownership between lanes. Gates use independent DB servers; give every UAT its own claimed port, image tag and disposable project. Serialize resource-heavy builds/browser runs when local capacity is constrained. No worker may count another worker's in-progress run as passing.

## Supported commands and terminal verdicts

`package.json` defines:

- `verify:static`: lint, formatting, file-size/design/UI/app-map audits, dependency/migration checks, typecheck and app-map build.
- `verify:foundation`: `verify:static`, all units, migrate, UAT seeds and all integration tests. It excludes CI's separate browser suite.
- `test:integration:3148`, `test:integration:3138`, `test:integration:3142a`: current lane-scoped database suites.
- `test:uat`: `tsx tests/uat/run-uat.ts`, which accepts spec filenames in caller order, provisions each disposable stack, and stops at the first failure.

Run these as separate unpiped commands. Expected clean-source exit is 0.

```bash
pnpm verify:static

# Choose the scoped script for this worktree.
scripts/run-gate.sh start --gate test:integration:3148
scripts/run-gate.sh wait --follow

# Required complete foundation on the final, frozen inputs.
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow

# Browser suite is separate, not implied by foundation.
CI=1 pnpm test:e2e
```

Run `wait --follow` as one background-capable agent tool invocation; use the tool's ongoing-session support rather than inventing a shell wait loop. If another gate starts in the same worktree, pass the exact launch log to `wait --follow --log <returned-log-path>` so receipts cannot cross. Check the returned exit: 0 pass; 1 actual failed gate; 2 dead run; 3 still running on bounded waits; 4 start/usage/environment failure. A failed launch has no test verdict. Use `scripts/run-gate.sh stop --log <returned-log-path>` only for an owned run that must be stopped.

Never run DB tests/migrations directly, manually CREATE/DROP databases, set the gate marker yourself, pipe a gate to tail/tee/grep, or infer liveness from process listings. The wrapper owns throwaway pgvector Postgres and cleanup. Record `### COMMIT`, `### DIRTY`, `### FINGERPRINT`, toolchain, DB/server identity, exact command and final sentinel. Changed or unknown inputs invalidate reuse. Scoped DB proof is not a full-foundation pass.

If memory requires it, the approved typecheck contract can run with `NODE_OPTIONS=--max-old-space-size=4096`; record that toolchain setting and terminal exit. Do not replace broad checks with narrowed checks after an OOM or missing native dependency.

## Real installed proof configuration

Read `tests/uat/provisioner.ts`, `provisioned-run.ts`, `real-chat-env.ts`, `model-tier.ts` and `specs/real-chat-signin.ts`. The provisioner builds the checked-out standard Dockerfile by default, creates isolated Compose resources, captures failure evidence before teardown, and removes the stack. Keep build enabled for final proof. Record the actual image digest and source/harness tree.

Required local prerequisites: Docker/Compose with pgvector, the lockfile toolchain, Playwright's supported Chromium, and installed Google Chrome plus a real display session for #3134. Use the normal supported local browser installation; the cloud's alternative-browser smoke is not a UAT receipt.

Claim a free port with the existing local `devports` tool in 5180–5299. The accepted plan uses `devports claim sched-3148`; consult the installed tool's help for the actual returned port and release operation. Do not guess its output format. Set that numeric result as `CLAIMED_PORT` in the shell below.

```bash
export JARVIS_UAT_CLAIMED_WEB_PORT="$CLAIMED_PORT"
export JARVIS_IMAGE_TAG="uat-scheduled-$(git rev-parse --short HEAD)"
export JARVIS_UAT_REAL_CHAT_PROVIDER=codex
export MOSS_UAT_REAL_CHAT_MODEL=gpt-6-luna
export JARVIS_UAT_REQUIRE_REAL_CHAT=1
export MOSS_UAT_CAPTURE_OFF=1

# Only when CODEX_HOME is set and the default auth location is absent:
# export JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE="$CODEX_HOME/auth.json"

pnpm test:uat 3148-side-chat-destination-real.uat.spec.ts
```

The auth override carries a filename, never credential bytes. The user approved the existing supported disposable Codex-auth copy; use only that harness and its teardown. Do not print/read credential contents into logs, shell arguments, evidence, prompts or the repository. Do not add persistent access or manually duplicate sign-ins. Do not set `JARVIS_UAT_REAL_CHAT_CONFIGURED` yourself; provisioning sets it after successful configuration. The strict flag makes missing real chat fail Activity rather than skip.

**All model tiers must actually use Codex gpt-6-luna.** `MOSS_UAT_REAL_CHAT_MODEL` pins the discovered economy chat override only. It is not an all-tier routing override. Before live acceptance, use existing disposable model/service configuration seams to bind economy, interactive, reasoning and relevant structured/worker paths to that same provider model; verify effective routing and model-activity records. Read `packages/ai/src/capability-route-routes.ts` and model/router contracts before adapting proof setup. A narrow reviewed harness change may be required because this snapshot has no all-tier environment switch. Do not invent one or claim the shell exports alone enforce it. Preserve production provider-agnostic behavior and original assertions. If exact existing-allowance routing is unavailable, report blocked rather than widening price/provider/model.

#3134 is intentionally different: `3134-reminder-notifications.uat.spec.ts` launches a **headed persistent Chrome** profile with service workers allowed and notification permission. The default incognito/headless context cannot substitute. Assert real push/browser display, quiet release, muted chat-only result and removed-device behavior; a Notifications database row alone is insufficient.

## #3500 required live suite

The current #3500 diff resolves to these 14 **blocking** specs. Generate the selection again after every source change:

```bash
git diff --name-only 8c4b1aff52ee83967ab668e5d3f0a74e760e5a87 HEAD > /tmp/scheduled-changed-paths.txt
.claude/skills/coordinate/resolve-uat-triggers.sh < /tmp/scheduled-changed-paths.txt

pnpm test:uat \
  3148-side-chat-destination-real.uat.spec.ts \
  3135-reminder-edits-real.uat.spec.ts \
  3136-repeating-reminders-real.uat.spec.ts \
  3133-reminder-controls-real.uat.spec.ts \
  3133-settings-reminders-real.uat.spec.ts \
  3134-reminder-notifications.uat.spec.ts \
  3151-scheduled-owner-read.uat.spec.ts \
  3152-configured-source-report.uat.spec.ts \
  1089-1090-chat-drawer-private.uat.spec.ts \
  1133-chat-attachments.uat.spec.ts \
  2890-model-activity-chat-turn.uat.spec.ts \
  moss-assistant-name.uat.spec.ts \
  runtime-context.uat.spec.ts \
  workshop-chat-handover.uat.spec.ts
```

The runner stops at first failure. Track each spec separately, including exit/assertion, so later entries are not silently reported as run. Re-run remaining entries after diagnosing a failure. All blocking specs must execute and pass on the final inputs; no skips, screenshots, intercepted responses or omitted Workshop/notifications.

#3151 additionally requires **three consecutive clean runs of its complete live spec**, including source removal/refusal. Run it twice more after a first clean suite result, without intervening source/harness/model changes. Any failure resets the clean sequence. Preserve original failures and apply the existing refusal/stop rule; do not use endless prompt tuning or change expectations to accommodate a refusal. Distinguish intended refusal after source removal from failure to save the authorized request.

The #3148 proof must assert atomic refusal of combined destination plus text/timing/repeat/stop edits, every saved term unchanged, standalone moves both ways, exact durable histories, live/reconnect dedupe, focused draft preservation, arrival beside a real reply, failed target recovery and Settings DOM layout. #3504 remains the separately tracked reliable combined-edit follow-up. It must not leak back into the fallback scope or become an excuse for more tuning.

#3126's accepted side-chat **overlay** remains distinct from existing Conversations drawer controls. A destination-routing proof using the drawer does not establish overlay/navigation acceptance. Keep that distinction in evidence.

## Evidence already available, and what it does not prove

The newer cloud checkpoint verified actual isolated scoped DB execution:

- #3500: exact published-head positive checks at `11e7fd7585125a8c9acfdab3ea3e4aedda280f3c` passed save 59; destination 122; cancellation/context/delivery 160; scheduled-report 47. Negative controls at byte-identical runtime predecessor `c07c081128e2d218580fbed3f019599aeed7d237` reproduced SQLSTATE 40P01 and lock-order assertion failures, then passed after protection restoration. These negatives are predecessor evidence, not final-head mutation reruns; run fresh controls if relevant compared inputs differ.
- #3507: 65 scoped DB tests; the selected positive bundle passed 11, protection removal produced 9 intended failures, restoration passed 11. Both near-maximum and maximum integer streak seeds saturated correctly through real queue/history paths.
- #3508: 56 scoped DB tests; 34 SQL probes with restoration; seven guard removals failed as intended, including consume-twice protection.

Static/type/build checks passed for the reviewed source. These counts belong to the recorded inputs and commands; they are not fresh local receipts or a full integration acceptance claim.

Historical incomplete/failed proof stays visible:

- #3500 full foundation stopped in browser-dependent units before UAT seeds/full integration; it never passed the entire chain.
- #3508 broad foundation hit missing native PTY/browser dependencies; a native-PTY retest then hit model capacity. It is not a green full gate.
- Cloud browser download remained HTTP 403 even after the network allowlist was republished. Installed Chromium 154 with Node Playwright 1.60 passed only five standalone DOM smoke assertions. No Moss UAT follows from that smoke.
- No final-image installed live UAT is certified for these three PRs. Earlier plans retain unexplained first missing-report/asset failures and later repaired/harness races; later passes do not establish a cause for an unexplained earlier failure.

Post fresh final-head scoped/full/browser/live results. Do not mark historical failures fixed/flaky/preexisting without evidence, and do not transfer a standalone receipt onto a composed source tree.

## Serial composition and merge gates

Before **each** merge: re-read PR/base/head, fetch current integration/main, audit migration collisions and sequential SQL overrides, review source delta, run required exact-head checks and live proof, verify remote head/CI and record public evidence. The source-defined collision command is `pnpm check:migration-numbers` (`scripts/check-migration-collisions.ts`); retain its base-branch findings as well as the local inventory.

```bash
gh pr view 3500 --repo motioneso/moss \
  --json state,isDraft,headRefName,headRefOid,baseRefName,mergeable,url
gh pr checks 3500 --repo motioneso/moss
pnpm check:migration-numbers
```

Replace 3500 with the lane PR. Re-read the exact head after any push before interpreting check results. After an authorized repair, publish with a normal explicit branch push, for example `git push origin HEAD:scheduled/3148-side-chat-destination`; a non-fast-forward rejection requires coordination, not force. Keep the PR draft until its evidence and all gates satisfy readiness. A clean Git merge does not prove that later SQL preserves earlier trigger authority.

1. **#3500 first.** Complete its scoped/full/browser/image/live gates and final independent review. Migration 0320 owns destination checks and canonical lock order. Keep `destination_title` immutability, destination share-lock validation and stored occurrence message-thread identity. Only then may the coordinator merge.
2. **#3507 after #3500.** Merge the current integration branch into the feature branch in its owned worktree, preserving published history and normal no-force pushes; do not rebase already-published commits. Compose 0321 with 0320; do not blindly let 0321 replace `app.enforce_chat_reminder_update` with the old Main-only body. Preserve authorized destination edits, `app.check_chat_reminder_destination`, title immutability, lifecycle/version and fixed-reminder rules while adding recurring-read advancement and no-message completion. Preserve destination checks in every runner load, including final posting, canonical owner/drawer-before-reminder/destination lock order and rollback reacquisition. Keep provider work outside DB transactions. History, notifications and pending context use each stored message's original `thread_id`; broaden message-bearing outcomes to delivered/failed/refused while quiet/expired stay message-free. Broaden acknowledgment of posted failed/refused results without dropping actor/exact-destination guards. Preserve destination DTO fields and both SQL/manifest/catalog entries. Adapt obsolete one-time-read and mutation assertions deliberately. Re-run independent review, authority-removal controls, actual composed DB gates, full foundation and live proof. Include recurring reads moved after earlier results, target loss during a run, and failed/refused history/context/notification after moving, plus `3138-repeating-useful-checks-real.uat.spec.ts` and every newly selected blocking spec.
3. **#3508 after the composed foundation.** Reconcile on current integration, preserving 0320/0321 and adding only new 0322. Re-run its scoped gate, full foundation, trigger-selected UAT and `3142a-bounded-action-agreement.uat.spec.ts`. Prove ordinary typed proposal/decline/revision/reload/current yes, exact inactive Settings scope, no Resume/job/effect, actual gateway write refusal and unchanged task past the agreed time. It ships **inert approvals only**; #3142 remains incomplete until #3142b. No actions may run from these records.

Use ordinary pushes to feature branches and retain branch protection. Feature PRs squash into `integration/scheduled-proactive`; the final #3154 uses a **merge commit** into `main`, after the complete integration/main reconciliation and final gates. Do not force, use admin bypass, enable auto-merge or deploy. Pin the exact merge candidate (for GitHub CLI, `gh pr merge <PR> --squash --match-head-commit <verified-head>`; final #3154 uses `--merge`). Recheck the integration tip after each squash and rerun changed/composed inputs. Do not merge simply because hosted CI is green. Tracker completion belongs to the coordinator and requires the whole accepted outcome.

## Remaining feature waves

Revalidate native GitHub blockers and fit against the latest integrated source before dispatch. The following are **remaining work**, not implementation claims:

1. #3139a and #3142b
2. #3139b and #3143
3. #3140, #3141, #3144 and #3147
4. #3466 / #3126 completion
5. Whole-integration two-axis review, main reconciliation, complete static/foundation/browser/installed acceptance, then #3154 merge commit into main

Retain original acceptance and dependencies, including whole-#3137/webmail acceptance or an explicit source/account availability limitation. New features need approved plans, truthful app-map updates in the same PR, isolated worktrees, TDD, independent review, required authority negatives and real installed proof. This handoff does not approve unrelated scope or fill gaps by inventing a workflow engine.

## Cleanup and the report to send

Use only disposable owners/tasks/fault setup and the provisioner's real API/DB paths. Faults are disclosed, exercise actual production reads, and are removed afterwards. Never bypass runtime RLS or test on production/shared development data. Public evidence contains no credentials, private hostnames, LAN addresses, personal paths or raw private source/model text. Describe security controls with bounded assertion results and digests.

Allow supported teardown to remove copied owner/shared Codex auth and temporary copies, then Compose volumes/networks/containers. Verify cleanup succeeded; report any credential cleanup error immediately. Stop only owned processes/browser profiles, release owned ports and delete owned scratch output. Keep worthwhile plans/evidence tracked and pushed in PRs; leave the worktree clean. Never sweep another lane with `git add -A`, broad cleanup or tree-wide resets.

Send the coordinator:

- PR, exact remote head/tree, integration base and migration ordering
- New corrections/composition and independent source-review findings; identify any GitHub review actually submitted separately
- Every command with terminal exit, clean/dirty status, fingerprint, toolchain/DB identity and CI run/check links for that exact head
- Actual installed image digest, provider/model/all-tier routing evidence, each executed UAT assertion and #3151 clean-run sequence
- Intended-failure mutation, failing assertion, restored-source digest and restored passing verdict
- Failed/blocked/never-run stages, unresolved historical observations and precise remaining acceptance
- Cleanup result, resources/ports released and current worktree status

Keep the summary short, with bounded detailed receipts on the PR. If a merge gate fails or requires authority beyond the task, report the exact blocker and leave the PR draft and unmerged.
