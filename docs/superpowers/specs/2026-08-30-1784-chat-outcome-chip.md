# #1784 — Truthful Chat Action-Outcome Chip

**Date:** 2026-08-30

**Status:** Approved by Ben — 2026-08-30

**Issue:** [#1784](https://github.com/motioneso/moss/issues/1784)

## Context

Chat renders terminal `action_result` records as a standalone line after the assistant reply.
`apps/web/src/chat/message-row.tsx` currently prefixes that line with a two-state chip:

- `executed` and `allowed` become **Changed**.
- `denied` and `error` become **Not changed**.

That display discards distinctions the existing contract already preserves. The gateway uses
`executed` only when it observed a successful tool result and `error` when the handler failed. For
native tools, `allowed` means only that Moss granted permission; the tool then runs outside the
gateway's sight. A failed write can also have changed state before failing, so **Not changed** is not
a safe description of `error`.

Issue #1661 fixed the same overclaim in the gateway notification text and the adjacent
`activityVerb()` rendering. Live records pass from `GatewaySessionRecord` through
`ChatGatewayNotifier` into the chat session, while terminal result metadata is retained in message
activity and restored by `recordsFromMessages()` after reload. Both paths preserve
`executed | allowed | denied | error`; only the standalone chip still flattens them.

## Goals

1. Make the standalone action-result chip report the recorded outcome without inferring whether the
   world changed.
2. Keep live-stream and history-restored records visually consistent.
3. Use the existing outcome wording established by #1661 rather than create another display map.
4. Lock the `allowed` and `error` behavior with a focused rendering regression test.

## Non-Goals

- Changing gateway execution, native-tool permission, assistant-action persistence, or audit-log
  behavior.
- Changing the four-value gateway/transcript outcome contract.
- Determining whether an allowed native tool later ran; Moss has no completion signal for it.
- Determining whether a failed write partially changed external or local state.
- Changing the action-result sentence produced by `ChatGatewayNotifier`, the **Behind the scenes**
  activity line, the Settings activity pane, layout, colors, or CSS.
- Adding a new chip component, outcome type, or shared abstraction.

## Resolved Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Chip meaning | Report the observed outcome, not a claim about state change | The contract knows execution/permission/failure/denial; it does not always know side effects. |
| Labels | `executed` → **Executed**, `allowed` → **Allowed**, `error` → **Failed**, `denied` → **Denied** | These are the canonical, cause-neutral labels already returned by `activityVerb()` after #1661. |
| Visibility | Keep the chip visible for all four outcomes | Permission, failure, and denial are meaningful terminal outcomes. Hiding uncertain cases would discard known information when truthful labels already exist. |
| Canonical mapping | Reuse `activityVerb(record)` in the standalone row | It already owns this exact four-state UI vocabulary; a second map caused the present drift. |
| Contract scope | No producer, persistence, DTO, or audit changes | All layers already retain the distinctions required by the acceptance criteria. This is a presentation-only bug. |
| Wording approval | No additional Ben decision is required beyond approving this spec | #1661 already established these labels on the sibling rendering, and issue #1784 explicitly permits outcome labels instead of change claims. |

## Architecture

### Existing outcome flow

1. `AssistantToolGateway` emits an `action_result`:
   - `executed` when a Moss tool handler returns successfully;
   - `error` when execution fails;
   - `denied` when permission or policy refuses the action;
   - `allowed` when native-tool permission is granted without an observable execution result.
2. For Moss-executed actions, the action audit independently records corresponding
   `success | failed | denied` facts. Native permission decisions remain assistant-action decisions;
   they must not be upgraded to execution success.
3. `ChatGatewayNotifier` converts the gateway record to a `TranscriptRecord` without changing its
   outcome, and `ChatSessionManager.injectRecord()` sends it live while retaining bounded terminal
   result metadata for the assistant message.
4. The frontend receives the same four-value outcome live. On reload, `recordsFromMessages()`
   restores terminal `action_result` records from persisted message activity with that outcome
   intact.
5. `Thread` sends the terminal record to `RecordRow`, which renders the standalone line.

### Display seam

The implementation changes only the label expression in `RecordRow`: it uses the existing
`activityVerb(record)` result instead of its private **Changed / Not changed** conditional. The
record text, DOM structure, `role="status"`, styling classes, special workshop result card, grouping,
and ordering remain unchanged.

This produces one outcome vocabulary across both chat renderings and makes future changes to that
vocabulary occur at one existing seam.

### Verification seam

`tests/unit/chat-drawer-activity.test.tsx` renders `Thread` to HTML today and already covers #1661's
outcome vocabulary. Extend that focused test so standalone `allowed` and `error` rows render
**Allowed** and **Failed**, do not render **Changed** for `allowed`, and do not render **Not changed**
for `error`. Existing assertions continue to cover `activityVerb()` and history restoration.

Because the change reuses existing markup and CSS, no new visual primitive or design-token work is
needed. The implementation is nevertheless user-facing, so its PR still requires the repository's
live-path proof through the real chat UI before merge.

## Exit Criteria

- A standalone `action_result` with `outcome: "allowed"` displays **Allowed** and never claims the
  action executed or changed state.
- A standalone `action_result` with `outcome: "error"` displays **Failed**, is distinguishable from
  **Denied**, and never claims state was unchanged.
- `executed` displays **Executed** and `denied` displays **Denied**.
- The same labels appear for live-stream records and records restored from message history.
- `RecordRow` reuses the existing canonical outcome-label function; no parallel mapping or contract
  change is introduced.
- The focused unit regression in `tests/unit/chat-drawer-activity.test.tsx` passes and would fail if
  either `allowed` or `error` returned to the current misleading label.
- Required frontend checks and live-path proof are green before merge.

## Hard Invariants Honored

- **Spec before build:** this document must be approved before an implementation plan is written.
- **Secrets never escape:** the display continues to use the existing bounded transcript outcome
  and text; it adds no raw handler output, tool input, credentials, or private audit data.
- **Provider-agnostic AI:** the outcome display does not depend on an AI provider or model.
- **Module isolation:** no module boundary or module-owned behavior changes; the shell renders the
  existing platform transcript contract.
- **A PR must never break prod:** no new setting, environment variable, migration, or deployment
  requirement is introduced.
- **Design-system guardrails:** existing `chatd-peek__line` / `chatd-peek__kind` markup and tokens are
  reused; no CSS or new visual primitive is introduced.
- **Live-path gate:** the user-facing fix is not merge-ready until exercised through the real chat UI
  and recorded on the PR.
