# w5c-chat-surface relay 5 → 6 — 2026-08-09

**Issue:** #1254, lane C. **PR:** https://github.com/motioneso/moss/pull/1492 (open, NOT merged).
**Coordinator:** Herdr label `Coordinator`, agent name `relay6-coordinator`, pane `w1:p3R` at last
resolve — **re-resolve fresh** via `herdr pane list` before messaging, pane ids are ephemeral.

## State: QA verdict is RED — code is fine, live-path proof missing

QA reviewed PR #1492: 5/5 tests pass, 0 blocking findings, invariants ok. **Only gap: no live-path
proof comment.** Full verdict: https://github.com/motioneso/moss/pull/1492#issuecomment-5236122617

Spec exit criteria (`docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` line
~130): **"#1254: a test proves a declared label renders and an undeclared tool falls back to its
name; live proof shows a human-readable approval card."** The plan's own "why no Playwright test"
section only argued against a *new automated e2e test* — it does NOT excuse the separate live-proof
requirement. That's on QA/coordinator's reading and I agree with it: two different exit-criteria
clauses, don't conflate them again.

**Non-blocking QA note (fold in, not required for merge):**
`packages/module-registry/src/external/validate.ts:653-654` checks
`isNonEmptyString(tool.description)` but has no equivalent check for the new `actionLabel` field —
`??` in the gateway fallback only catches null/undefined, so a module could ship
`actionLabel: ""` or a non-string and it'd reach the card unchecked.

## Why live proof needs a real manifest change (read before redoing this analysis)

No module currently declares `actionLabel` — it's a brand-new optional field with zero real
callers. Without at least one real manifest using it, there is nothing to screenshot; the
`wired-not-just-defined` memory trap applies directly (new prop can pass its own unit test while no
production caller ever passes it). **Decision: add `actionLabel` to a real job-search write tool as
part of this PR**, not a throwaway/reverted demo edit — this is genuinely in scope now because the
live-path gate demands it, and it's a one-line, additive, no-behavior-change display string.

Chosen target: `external-modules/job-search/jarvis.module.json`, tool `job-search.criteria.set`
(currently at file line ~77-96, `description: "Save what this job search is looking for — roles,
places, pay, and what you actually want."`, `risk: "write"`). This is the exact tool the plan used
as its illustrative example. Add `"actionLabel": "Update your job search criteria"` alongside
`"description"`. Triggered live via the job-search onboarding/criteria chat flow (see
`job-search-onboarding-interview-latency` and `job-board-query-one-title-per-request` memories for
how that flow behaves) — it's a `risk: "write"` tool so it produces a real approval card.

## Two tasks already created (task list has them, both still open)

- **Task #4** — Add actionLabel validation guard in `validate.ts`: alongside the existing
  `isNonEmptyString(tool.description)` check at line 653-654, add: if `tool.actionLabel` is
  present, it must be a non-empty string (mirror the description check's error-push pattern). Add
  one test case to whatever test file covers `validate.ts` today (grep for the existing
  `"assistant tool description is required"` assertion to find it — not yet located this relay).
- **Task #5** — Wire `actionLabel` into `job-search.criteria.set` per above.

## Next concrete steps, in order

1. Locate `validate.ts`'s existing test file (grep `"assistant tool description is required"`),
   add the actionLabel guard + a red→green test case (TDD, per this repo's own convention — see
   the two already-committed commits on this branch for the pattern).
2. Add `actionLabel: "Update your job search criteria"` to `job-search.criteria.set` in
   `external-modules/job-search/jarvis.module.json`.
3. Re-run the isolated gate (`verify-gate` skill — fresh DB, e.g. `jarvis_gate_1254c2`, unpiped,
   `### FINAL` sentinel) to confirm the validate.ts change and job-search manifest edit don't break
   anything. External module manifest changes may need a restage — check
   `module-discovery-needs-staged-package-dir` and `restage-drifts-module-out-of-the-nav` memories
   before assuming a plain file edit is picked up live.
4. Spin up / confirm a live dev instance is running — check `dev-instance-lan-spinup-trusted-origins`
   and `dev-preview-recipe` memories for the exact recipe (ports, trusted origins, Ben's dev login).
   Do NOT touch prod (`uat-docker-subnet-map` memory: 10.252 is PROD).
5. Sign in, open job-search, trigger `job-search.criteria.set` through the real chat/onboarding UI
   (not a script) so the approval card renders with `summary === "Update your job search criteria"`
   instead of the raw description. Screenshot cropped to the card — **do not pull a full-page
   screenshot into context**, view cropped regions only per box-wide CLAUDE.md rule.
6. `git add`/`git commit` the two changes (validate.ts + test, job-search manifest) by explicit
   path per `shared-checkout` skill — check `git status --porcelain` first, this is a shared
   checkout.
7. Rebase on `origin/main`, push, `gh pr comment 1492` with the screenshot + what was clicked
   through (per the live-path gate proof format in `coordinated-wrap-up` skill step 3b).
8. Re-report to coordinator (re-resolve pane fresh): PR #1492 updated, live-path proof posted,
   validate.ts gap fixed, ready for re-QA. Then STOP — don't merge, don't move the board.

## Relay trigger

Context-meter 70% fired right after creating tasks #4/#5, before any code was touched — clean
relay point, tree was already clean (both prior commits + this handoff are the only new commits).
