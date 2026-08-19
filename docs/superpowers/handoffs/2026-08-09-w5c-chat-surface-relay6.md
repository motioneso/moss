# w5c-chat-surface relay 6 → 7 — 2026-08-09

**Issue:** #1254, lane C. **PR:** https://github.com/motioneso/moss/pull/1492 (open, NOT merged).
**Coordinator:** Codex session, verified fresh this relay via `herdr pane list`:
pane `w1:p42`, agent `codex`, `agent_session.value = 019fe9e2-7fc6-7243-9894-d258562db9a6`,
label `Coordinator`. **Ben confirmed this in person** — earlier warnings about other
Coordinator sessions/panes are superseded. Still re-resolve the pane fresh before messaging
(pane ids reflow); re-verify the session id matches before sending.

## Standing constraint — do not violate

User's explicit "Coordinator takeover" instruction: **do not report #1254 done on gate/CI green
alone.** Real live-path proof (screenshot + narrative posted as `gh pr comment` on #1492) is
mandatory before any "done" report.

## State: QA-RED gaps are CLOSED in code, gate is GREEN, NOT pushed yet, NO live proof yet

QA verdict (https://github.com/motioneso/moss/pull/1492#issuecomment-5236122617) found 2 gaps:
missing live-path proof (blocking), and no actionLabel validation guard (non-blocking, folded in
anyway). Both now addressed:

**New commit this relay:** `98b3ce953` — `fix(module-registry): validate actionLabel, wire it
into job-search.criteria.set (#1254)`. 3 files, +74/-0, verified via `git show --name-only HEAD`
contains exactly: `external-modules/job-search/jarvis.module.json`,
`packages/module-registry/src/external/validate.ts`, `tests/unit/external-validate.test.ts`.
Sits on top of the two prior commits from relay 4 (`07de16fcf`, `fbe53fa01` — see relay4 doc for
those). **Not rebased on latest origin/main yet, not pushed.**

- `validate.ts` (~line 654, after the `description` check): added
  `if (tool.actionLabel !== undefined && !isNonEmptyString(tool.actionLabel)) errors.push(...)`.
  TDD: 3 new tests in `tests/unit/external-validate.test.ts` (accept-with-label,
  reject-empty-string, reject-non-string) — confirmed RED before the fix (2 failed), GREEN after
  (27/27 passed).
- `external-modules/job-search/jarvis.module.json` — added
  `"actionLabel": "Update your job search criteria"` to the `job-search.criteria.set` tool
  (alongside its existing `description`). **Verified this tool still shows a real approval card
  despite `"executionPolicy": "auto"`**: `packages/ai/src/gateway/policy.ts` `resolvePolicy()`
  only auto-runs when the family (`profile_changes`) has been promoted to `trusted_auto` tier by
  the user — a fresh dev account has NOT done this, so `confirmAndRun` still fires and the card
  still renders. Don't re-derive this, it's confirmed by reading `policy.ts:29-57`.

**Full isolated gate green this relay** (via `scripts/run-gate.sh`, not hand-rolled): fresh DB
`jarvis_gate_w5c_chat_surface`, `### FINAL rc=0`, 187 test files / 1874 tests passed, 2 skipped.
Log: `/tmp/jarv1s-gate/w5c_chat_surface-20260809-230848.log` (may be reaped by now — don't rely on
it surviving, the sentinel result is what matters).

## Remaining tasks (task list has #7/#8/#9, all still open — #4/#5/#6 done)

**Task #7 — live dev instance proof (not started):**
1. Check `dev-instance-lan-spinup-trusted-origins` and `dev-preview-recipe` memories for the spin-
   up recipe (ports, trusted origins, Ben's dev login). Confirm whether a dev instance is already
   running before starting a new one (check via `ps`/ports, not by assuming).
2. **Job-search is an external module — a plain manifest edit is NOT enough for a live instance to
   see it.** Read `module-discovery-needs-staged-package-dir` and
   `restage-drifts-module-out-of-the-nav` memories in full before touching this. Required
   sequence, all three steps, in order:
   - Stage the hashable set into `data/modules/job-search`: `jarvis.module.json`, `package.json`,
     `dist/worker.js`, `dist/web/**`, `sql/**` (exact set per `hashExternalPackage` in
     `packages/module-registry/src/external/hash.ts`). Rebuild first if `dist/` is stale.
   - Restage (copy) — this alone will make the module fail-closed/drift-disabled if it was already
     enabled (`disabledReason: "package changed since it was enabled"`).
   - **Re-enable**: `POST /api/admin/external-modules/job-search {"enabled": true}` — this is the
     step that is easy to forget and leaves a dev instance that looks healthy everywhere except the
     one place the user looks (nav). Verify via `GET /api/modules` (job-search present) before
     moving on, not via `module_installs` row status (can lie).
3. Sign in as Ben's dev login (per the dev-instance memory), open job-search, trigger
   `job-search.criteria.set` through the **real chat/onboarding UI** (not a script/API call
   directly — the point is proving a human can reach this path). Wait for the approval card to
   render with summary `"Update your job search criteria"` (proves the new priority chain over the
   raw description).
4. Screenshot, **cropped to the approval card region only** — never pull a full-page screenshot
   into context, per box-wide CLAUDE.md. Save to disk, view the cropped region only.

**Task #8 — rebase, push, PR comment (not started, blocked on #7 for the screenshot):**
```bash
git fetch origin main && git rebase origin/main
git push -u origin w5c-chat-surface
gh pr comment 1492 --body "<live-path proof: what was clicked through + screenshot>"
```

**Task #9 — report to Coordinator (not started, blocked on #8):**
Re-resolve pane fresh via `herdr pane list` (don't reuse `w1:p42` blindly — reflows). Re-verify
`agent_session.value == 019fe9e2-7fc6-7243-9894-d258562db9a6` before sending. Report via
`herdr agent prompt <resolved-target> "..."`, terse result-first, per `coordinated-wrap-up` step 4
format: PR link, VF_EXIT=0 (187 files/1874 tests, gate DB `jarvis_gate_w5c_chat_surface`),
**Live-path: proof comment posted at <url>** (only say this if genuinely posted — do not claim it
if #7/#8 aren't actually done), branch pushed/rebased sha, Deferred: none, Teardown: <dev instance
PIDs stopped | left running and say why>, worktree reapable. Then STOP — don't merge, don't move
board.

## Relay trigger

Context hook fired at 70% right after the task #6 commit landed cleanly (`98b3ce953`), before any
dev-instance work started. Clean relay point — working tree is clean, nothing mid-flight.
