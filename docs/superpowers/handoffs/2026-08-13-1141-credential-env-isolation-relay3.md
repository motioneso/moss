# Relay 3 — #1141 credential-env isolation

**Issue:** #1141. **Risk tier:** security. **Branch/worktree:** this one,
`1141-credential-env-isolation`. **Coordinator:** Herdr agent, re-resolve fresh via `herdr agent
list` — confirm by label "Coordinator" or agent name containing "coord" (last confirmed as
`coord-overnight-20260810-97 [3ba4fe]`, but panes/refs reflow — do not trust that ref blindly).

## Status: PR #1601 open, QA-1141 verdict **RED**. Do not re-request QA until all 3 blocking items below are fixed.

PR: https://github.com/motioneso/moss/pull/1601 (repo redirects motioneso/Jarv1s → motioneso/moss).
QA verdict comment: https://github.com/motioneso/moss/pull/1601#issuecomment-5277550777

Build itself is done and green locally (gate VF_EXIT=0, trio green, rebased onto origin/main at
`455e756af`). What's blocking merge is CI status + UAT policy + PR wording — **no code changes to
the fix itself are needed**, only wrap-up hygiene.

## The 3 blocking QA findings — status of each

### 1. RESOLVED (relay 4) — pre-existing flake, waived with evidence, not a regression
Found **issue #1607** ("Flaky/pre-existing: chat-drawer-surface.test.tsx 'resets state on a flip
in both directions' fails full-suite-only"), filed 2026-08-13 09:57 against an unrelated PR
(#1606, vault-ingestion) — exact same assertion/line/failure, independently confirmed there as a
pre-existing full-suite-only timing race in the already-merged #1533 chat-drawer code, with zero
diff overlap. Combined with #1601's own diff-scope exclusion (never touches chat-drawer files),
this is conclusively a pre-existing repo-wide flake, not caused by this PR. Posted as a PR comment
with full evidence: https://github.com/motioneso/moss/pull/1601#issuecomment-5287343919 (links
#1607, does not re-litigate root cause there). Compose deployment smoke already confirmed flake
(passed on rerun). **No further action on item 1 — move to item 2.**

<details><summary>Original investigation checklist (for reference, now resolved)</summary>

### 1. CI foundation job failed TWICE IDENTICALLY — do not rerun a third time, investigate for real
Two jobs failed on the original push (run `31678621320`). `gh run rerun 31678621320 --failed` was
triggered once already. Results as of 2026-08-13 (end of relay 3):
- **`Compose deployment smoke`: now PASS (3m22s) on rerun.** Treat as confirmed flake — no further
  action needed on this one.
- **`Verify foundation and app`: FAILED AGAIN, same exact test, same line, same assertion**, on the
  rerun (7m15s — a real full run, not a short-circuit):
  `tests/unit/chat-drawer-surface.test.tsx:525:85`, test `"resets state on a flip in both
  directions"`, `AssertionError: expected false to be true` on
  `findByAriaLabel(rendererB, "Start private chat")?.props["aria-pressed"]`. Full log:
  `gh run view 31678621320 --job 94618331912 --log-failed`.
  **This is now two identical failures in CI — per the box-wide CLAUDE.md rule ("Two identical
  failures → stop and rethink. Never retry-loop a failing command or patch."), do NOT run
  `gh run rerun --failed` a third time.** It reproduces consistently in CI despite passing 3/3
  locally, which points at a real CI-only condition (scheduling/timing under CI's CPU/memory
  contention, a `act()`/microtask race that only loses under load, or something about run order/
  parallelism in CI's vitest invocation) — not random flakiness. Diff-scope exclusion still holds
  (this PR never touches that file or its dependencies — confirmed via `git diff --stat
  origin/main...HEAD` = `provider-probe.ts`, `provider-probe.test.ts`, `main.ts`,
  `engine-host.ts` only), so this is very likely a **pre-existing flaky/timing-fragile test that
  the PR happens to be unlucky enough to keep tripping**, not something this PR's diff caused.

**Next step — actually investigate, don't just rerun again:**
1. Check whether `chat-drawer-surface.test.tsx:525` (or that whole suite) has failed on *other*
   recent PRs/CI runs unrelated to #1141 — `gh run list` across recent runs on other branches, or
   check if there's an existing tracked flaky-test issue for it. If it's already known-flaky
   elsewhere, that's real evidence this isn't diff-caused, and the path is to **waive**: note it
   explicitly in the PR body/comment as a documented pre-existing flake with a link to evidence
   (not just asserted), and consider filing/linking a separate flaky-test issue if none exists —
   do not silently ignore it.
2. If it's never failed elsewhere, dig into *why* CI reproduces it and local doesn't — likely a
   timing assumption in the test (`act()` + `await Promise.resolve()` double-microtask wait around
   line ~510-525) that's marginal under CI's slower/contended scheduler. Read the test (`tests/unit
  /chat-drawer-surface.test.tsx` lines ~470-530) and the component logic it's asserting against; if
  there's a real race, that's `systematic-debugging` territory (a separate, unrelated fix — not in
  scope for #1141, would need its own commit/PR unless trivial and clearly safe to bundle).
3. Either way, this must be resolved (with evidence, not assumption) before re-requesting QA —
   QA explicitly declined to call it for us.

</details>

### 2. Blocking UAT specs never run — this is real, own PR body claim was wrong
Confirmed via the actual trigger lookup (not the QA agent's word):
```
gh pr diff 1601 --name-only | .claude/skills/coordinate/resolve-uat-triggers.sh
```
Returns:
- `blocking  tests/uat/specs/1133-chat-attachments.uat.spec.ts`
- `blocking  tests/uat/specs/cli-terminal.uat.spec.ts`
- `blocking  tests/uat/specs/runtime-context.uat.spec.ts`
- `advisory  tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`

These trigger because `packages/chat/**` is broadly mapped to those 3 specs (uat-trigger-map.tsv
lines 28-33) plus `packages/cli-runner/**` → `cli-terminal` (line 39) — the map doesn't
distinguish "backend-only, no UI surface changed" from a real UI diff, so the original PR body's
"no UAT spec needed" claim does not hold under the locked #1027 policy even though this change has
no new UI surface. **Not started yet — this is the main remaining work.**

Next steps (see `coordinated-wrap-up` skill step 3b for the general recipe, and project memory
`e2e-dev-uat-for-ui-features.md` / `uat-spec-gotchas.md` / `uat-reload-poll-and-psql-seed-traps.md`
/ `uat-spec-psql-role-trap.md` before touching seed data or psql — there are known traps: reload-poll
races, `-U postgres` not `jarv1s` for psql, seeded resets that break real signup):
1. Spin up a live dev instance per `dev-preview-recipe` skill/memory (record every PID you start —
   teardown by PID only, never by name pattern; prod's worker looks like a dev orphan in `ps`).
2. Run: `pnpm test:uat -- "1133-chat-attachments|cli-terminal|runtime-context"` (or one at a time)
   with `JARVIS_UAT_BASE_URL` set per `run-uat.ts`'s expectations. Capture a real `### FINAL rc=N`.
3. **Permanent policy (confirmed via coordinator mid-relay-3, applies beyond this PR too):**
   screenshots are removed from live-path proof entirely. Do NOT generate, capture, attach, or
   preserve screenshots for UAT/live-path proof — if any spec run produces `test-results/**`
   screenshot files, delete them before commit (never let stray generated artifacts land in a
   commit). This does **not** weaken the live-path assertion itself — still exercise the real UI
   on a live dev instance end-to-end, just prove it with: the UAT command + exit code
   (`### FINAL rc=N`), plus bounded DOM assertions/selectors that passed, bounded network call
   evidence (e.g. captured request/response for the relevant endpoint), bounded server/API log
   excerpts, and bounded DB query results confirming the expected state change — all pasted
   directly into the PR comment, not as attached files.
4. Post the live-path proof as a PR comment (`gh pr comment 1601 --body "..."`) — actual run output
   + rc + the bounded DOM/network/log/DB evidence above, not just "ran clean" and not screenshots.
5. Stop the dev instance, delete any seeded rows, confirm teardown before moving on.
6. The advisory spec (`1089-1090-chat-drawer-private`) is non-blocking but note whether you ran it
   too or explicitly skipped it and why.

### 3. Security claim overstated in PR body/release note — needs rewording, not code changes
QA is right: neither patched call site was ever reachable by ambient `HOME`:
- `packages/cli-runner/src/main.ts:176` goes through `buildCliRunnerChildEnv`, which already pins
  `HOME` explicitly before this PR.
- `packages/cli-runner/src/runner-io.ts:34`'s `{ ...baseEnv, ...opts.env }` layering also already
  controlled `HOME` on that path.

So this PR is **defence-in-depth** — closing a *theoretical* gap in how `provider-probe.ts` itself
resolves `HOME` when called directly, not "closing a live credential leak" as originally written.
**Action needed:** `gh pr edit 1601 --body "..."` (or `gh pr comment` correcting it if `gh pr edit
--body-file` no-ops — known trap, see memory `gh-pr-edit-body-silently-fails.md`, verify the edit
actually landed with `gh pr view 1601 --json body`) to reword:
- Summary section: change "so the probe cannot read or be influenced by the invoking process's
  real HOME" framing to something like: "adds explicit HOME isolation directly in
  `provider-probe.ts` as defence-in-depth — both current call sites already pinned HOME via
  `buildCliRunnerChildEnv`/`runner-io.ts` layering before this change, so this closes a
  theoretical gap (probe called directly, or a future call site that doesn't go through those
  helpers) rather than an actively-exploitable leak."
- Release note section: same correction — not "fixes a credential-isolation gap... the probe now
  runs against an isolated HOME" (implies a live bug); reframe as hardening/defence-in-depth.

## Non-blocking QA findings — worth a fast-follow issue, doesn't block this PR

QA found the **actual live version** of this bug class, untouched by this PR:
- `packages/module-registry/src/chat-multiplexer.ts:256-259` spawns via `createRealTmuxIo()` with
  **full `process.env`** (`tmux-bridge.ts:48`) — genuinely ambient-HOME-reachable in the host-dev
  onboarding path.
- Same pattern for the codex/gemini twins at `chat-multiplexer.ts:274` and `:287`.
- Also latent (non-blocking, `perUserUid` off by default): `engine-host.ts:348` builds session I/O
  from raw `process.env`.

**Action needed:** file a GitHub issue (title something like "chat-multiplexer: real-tmux spawns
inherit full process.env (ambient HOME) — same bug class as #1141") describing all 3 call sites +
the engine-host.ts:348 latent one, link it from PR #1601's body under "deferred/follow-up", tag
appropriately (probably security tier given the reachability). Filing an issue is fine to do
solo — **do not** start building the fix; that's new scope, needs its own spec/plan per
`docs/superpowers/specs/` process gate if it's more than trivial.

## After all 3 are fixed

1. Re-verify PR body reads correctly (`gh pr view 1601 --json body`).
2. Message the coordinator (re-resolve fresh, see above) something like: "PR #1601 updated after
   QA-1141 RED verdict — CI re-verified green (or: still investigating X, see below), 3 blocking
   UAT specs run with proof at <comment link>, security framing reworded, fast-follow issue
   #<NN> filed for the chat-multiplexer ambient-HOME gap. Ready for QA re-run." Ask them to
   re-dispatch QA-1141.
3. Still never merge, touch the board, or close #1141 yourself — Ben's explicit sign-off tier.

## Key facts (don't re-derive)

- Scope is deliberately HOME-only for `provider-probe.ts`; PATH and codex/gemini probes inside
  that file are out of scope (rationale in the plan's Decisions section) — this is separate from
  the chat-multiplexer.ts finding above, which is a different file/call path entirely, not
  something this PR's scope excludes.
- No node_modules install needed — already present in this worktree.
- Plan: `docs/superpowers/plans/2026-08-13-1141-credential-env-isolation.md` (committed
  `33f4b4832`), approved by Fable.
