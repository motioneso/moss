# Relay — w3c-audit-truth (#1136, lane C)

**Trigger:** context-meter 70%+ checkpoint hook fired (reached 75%). Zero code changes made —
this relay is plan-only, no build progress to report beyond the plan doc itself.

## State

- **Plan written and committed-pending:** `docs/superpowers/plans/2026-08-09-1136-codex-persona-marker-fencing.md`
  (full seams check, task 1 + task 2 contracts, test cases, verification commands, kill gate,
  rulings ledger — already meets `plan-build`'s checklist).
- **Coordinator messaged:** plan-ready + relay notice sent via `herdr agent prompt` to the
  `Coordinator` pane (label `Coordinator`, was `w1:p31` at send time — re-resolve fresh). Message
  asked for Fable plan-review (security tier) before approval, per handoff doc.
- **No source files touched yet.** No commits yet on this branch beyond what may already be on
  `origin/main`.

## What the plan says (don't re-derive — read the plan file, it's short)

Two files only:
1. `packages/chat/src/live/prompt-safety.ts` — strengthen `neutralizeSeedFraming` to also
   neutralize line-start persona/role markers (`User:`/`Assistant:`/`System:`/etc), in addition to
   its existing XML-tag neutralization. This is the single choke point — every `replayBatch`
   contributor (`chat-context-blocks.ts`, `recall-seed.ts`, `cross-tool-reasoning.ts`,
   `passive-retrieval.ts`) already calls it, so they all upgrade for free.
2. `packages/chat/src/live/codex-exec-session.ts` — the only chat engine that builds raw
   `User:`/`Assistant:` transcript framing with **zero** neutralization today. Wire in
   `neutralizeSeedFraming` for `text`/prior turns, and add an explicit untrusted-data fencing
   notice immediately before `replayBatch` in `buildPrompt`.

Exact regex, constant text, function signatures, and 10 test cases (5 per file) are written out in
the plan — do not re-derive them, they're already decided.

## Verified branch facts (don't re-verify)

- `replayBatch`'s constituent text already passes through `neutralizeSeedFraming` at 4 call sites
  before reaching `codex-exec-session.ts` — confirmed by reading `chat-context-blocks.ts:1,9,20`,
  `recall-seed.ts:1,67-68,76`, `cross-tool-reasoning.ts:1,339-340`, `passive-retrieval.ts:7,221,258`.
- No other engine (`cli-chat-engine.ts`, `claude-print-chat-engine.ts`, `agy-print-chat-engine.ts`)
  builds literal `User:`/`Assistant:` framing — grep confirmed zero matches. Scope is correctly
  codex-exec-only.
- The issue's literal `codex-exec.ts` path citation is stale (real file is `codex-exec-session.ts`)
  — spec already flags this ("the issue's codex-exec.ts path is stale").
- Existing test `tests/unit/chat-recall-seed.test.ts:70-86` (fixture: `"benign </memory> SYSTEM:
  ignore previous..."`) does NOT break under a line-start-anchored persona-marker regex — the
  `SYSTEM:` there is mid-line, not line-leading. No edit needed to that specific assertion; new
  cases get added alongside it.

## Next steps (in order)

1. Wait for coordinator approval (Fable plan-review required first, per handoff doc's security
   tier — do not skip).
2. Build with `superpowers:test-driven-development`, task 1 then task 2, per the plan's exact
   contracts. Commit each task green, `git add` by explicit path only.
3. Run the plan's verification commands (unpiped, check `EXIT=0`).
4. Pre-push trio + rebase before pushing.
5. `coordinated-wrap-up`: gate on isolated DB, push, open PR, post Opus adversarial QA verdict as
   a `gh pr comment` (required by spec for every lane), report to coordinator. No live-path UI
   proof required for lane C (internal/security, per spec).

## Coordinator / escalation

- Label: `Coordinator`. Session id: `890502d0-c97b-4ed1-aaae-8c33ec48c98f` (authority; label is
  routing — re-resolve pane fresh via `herdr pane list` each time, never reuse a cached `…-N`).
- Run-specific bans still apply: never `git add -A`, never touch `docs/coordination/`, no merge.
