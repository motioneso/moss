# Plan — #1784 truthful chat action-outcome chip

**Task issue:** #1784 (bug, task — Part of #1252)
**Spec:** `docs/superpowers/specs/2026-08-30-1784-chat-outcome-chip.md` (approved 2026-08-30)
**Branch/worktree:** per fleet assignment; slices share one worktree and one PR.
**Size:** one build slice, one agent session.

## Seams check (file:line citations, current `origin/main` @ e947239ea)

- `apps/web/src/chat/message-row.tsx:220-227` — the defect. `RecordRow`'s `action_result` branch
  renders the standalone line with the inline two-state ternary:
  `outcome === "executed" || outcome === "allowed" ? "Changed" : "Not changed"`.
- `apps/web/src/chat/message-row.tsx:121-135` — `activityVerb(record: TranscriptRecord): string`,
  already exported, already returns the four canonical labels for `action_result`:
  `allowed` → "Allowed", `executed` → "Executed", `error` → "Failed", else "Denied". This is the
  #1661 vocabulary the spec mandates reusing; no new map is written.
- `apps/web/src/chat/use-chat-stream.ts:42-51` — `TranscriptRecord` with
  `outcome?: "executed" | "denied" | "error" | "allowed"`; the same union is validated on the live
  stream (`use-chat-stream.ts:254-257`) and on parse (`use-chat-stream.ts:314-317`).
- `apps/web/src/chat/chat-drawer.tsx:777` — `recordsFromMessages()` restores terminal
  `action_result` records (with outcome) from message history, so the one rendering change covers
  both live and restored records; no restore-path change is needed.
- `packages/ai/src/gateway/types.ts:36` — gateway record retains the four-value outcome (cited by
  the issue); producer side is untouched.
- `tests/unit/chat-drawer-activity.test.tsx:1-115` — the focused test seam. Already renders
  `Thread` to HTML via `renderToString`, already asserts `activityVerb` for all four outcomes and
  history restoration. The new assertions extend this file.

No new platform capability, component, CSS class, or contract is needed.

## Task 1 — chip reuses the canonical outcome label

**File:** `apps/web/src/chat/message-row.tsx`

In `RecordRow`'s `action_result` branch (lines 220-227), replace the two-state ternary inside
`<span className="chatd-peek__kind">` with `activityVerb(props.record)`. Markup, classes, and the
surrounding `role="status"` line stay exactly as they are. The stale `#1888` comment at line
206-207 ("everything else stays the one-line \"Changed\" note below") is updated to say "one-line
outcome note" so it stops naming the removed label. Delete nothing else; add no new function.

Result per outcome: `executed` → **Executed**, `allowed` → **Allowed**, `error` → **Failed**,
`denied` → **Denied** — identical for live-stream and history-restored records because both paths
produce the same `TranscriptRecord`.

## Task 2 — regression test

**File:** `tests/unit/chat-drawer-activity.test.tsx` (extend, do not fork)

Add one test rendering `Thread` with two standalone terminal records,
`{ kind: "action_result", text: ..., outcome: "allowed" }` and
`{ kind: "action_result", text: ..., outcome: "error" }`, asserting on the HTML:

1. contains `>Allowed<` and `>Failed<` (the standalone chip text, element-delimited so the
   assertion cannot match record body text);
2. does **not** contain `Changed` — this single substring also excludes `Not changed`
   (`"Changed"` with capital C is not a substring of `"Not changed"`), so both misleading labels
   are locked out with one assertion; keep an explicit `not.toContain("Not changed")` as well for
   legibility.

Why it fails against a broken implementation: against current `main`, the `allowed` row renders
`>Changed<` (assertion 2 fails) and the `error` row renders `>Not changed<`; against a future
regression reintroducing a second display map, the element-delimited labels in assertion 1 fail.
Record body text in the fixtures must avoid the words "Changed"/"Allowed"/"Failed" so assertions
bind to the chip only.

Existing tests in the file continue to cover `activityVerb` itself and history restoration.

## Determinism boundary

All chip text renders from the recorded `outcome` field — never from model output, and the model
has no job in this change (zero model jobs; no guidance text is added anywhere). No claim about
world-state is inferred: the chip reports the observed outcome only.

## Verification (unpiped, expected exit codes)

```bash
pnpm test:unit tests/unit/chat-drawer-activity.test.tsx > /tmp/1784-test.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
npx tsc --noEmit > /tmp/1784-tsc.log 2>&1; echo "EXIT=$?"                                            # expect EXIT=0
npx eslint apps/web/src/chat/message-row.tsx tests/unit/chat-drawer-activity.test.tsx --max-warnings=0 > /tmp/1784-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1784-fmt.log 2>&1; echo "EXIT=$?"                                           # expect EXIT=0
```

Full gate before PR-ready, via the `verify-gate` skill only (never unscoped):
`pnpm verify:foundation` run per that skill's procedure; expected exit 0.

## Live-path proof (exit criterion — user-facing, required before merge/Done)

On the live dev instance (`http://192.168.50.36:5173`), through the real UI: log in, ask the
assistant to perform an action that produces a terminal `action_result` (e.g. a settings write via
chat — the same flows the existing UAT specs `tests/uat/specs/1264-settings-self-operation.uat.spec.ts`
exercise). Capture bounded DOM evidence of the standalone action-result line showing the outcome
label (**Executed** for a completed write), and — by denying one request — a **Denied** row.
Evidence (assertion output or bounded DOM snippet, not screenshots) posted as a `gh pr comment`
per the Live-Path Gate. Without this artifact the status is code-complete, unverified.

## Release note

Category: Fixed. Title: "Chat action labels now say what actually happened". Description: the
small label next to an assistant action now reports Executed, Allowed, Failed, or Denied instead
of guessing whether something changed.

## Kill gate

Single slice, no phase 2. Stop-the-line observation: if the live-path check shows any outcome
rendering a label other than the four canonical ones, or live vs restored records diverging, stop
and re-diagnose before opening the PR. Owner: the build agent; escalate to Ben only if the
four-value contract itself turns out not to hold on the live path.

## Open questions

None. Every capability is cited above; the spec resolved chip visibility (keep for all four
outcomes) and label wording.
