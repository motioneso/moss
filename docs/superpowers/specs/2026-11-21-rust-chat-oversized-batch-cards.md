# Rust chat: oversized batch approvals and card errors

- Task: JS-395, follow-up to JS-390 (Finance chat cards).
- Status: proposed; phase 1 is this spec only. Ben/coordinator approval is required before code.
- Repository: `~/Jarv1s`. Build on current `origin/main` after approval, including parts 4b/4d.

## Problem and outcome

One tool call must remain one approval and one execution, even when its disclosure needs many
cards. The person must be able to inspect every item and every effect they approve. Never shorten
values, omit rows, or ask the model to split an atomic batch to fit a presentation limit.
A builder failure must reach the model as a tool error with a safe reason, rather than being
reported as a person's refusal. No failed presentation may authorize execution.

### Verified starting point

Read on this branch; these are source observations, not executed acceptance results:

- `rust-spike/module-host/src/chat_tools.rs`, `normalize_card`: 32 KiB serialized card,
  32 supplied fields, 4096 bytes per value, 8192 bytes for content. A raw target adds an Item field.
  `chat_manifest` also caps serialized tool arguments at 64 KiB.
- `chat_tool_card` returns `Ok(card.ok())`, losing builder/normalization/redaction errors.
  `rust-spike/shell/app/src/chat_tools.rs` replaces both missing cards and errors with generic text.
- `rust-spike/shell/app/src/runner_data.rs`, `raise_approval`, returns false on a builder error;
  the event handler sends `allow:false`. `rust-spike/agents/src/bin/moss-runner.rs` maps that
  to `Answer::Deny`; `agents/src/gateway.rs`, `call_tool`, reports that the person did not approve.
- Shell `Book::consume` binds actor, turn, module, tool and exact JSON parameters and consumes
  once. `ToolTurn::dispatch_with` checks offered names and single-use turn call IDs.
  The displayed version is retained in `Action` and passed to the host. Host
  `approved_chat_payload` mints/consumes its versioned grant under the serial lock.
- `shell/contract/src/lib.rs`, `ApprovalView`, and `shell/ui/src/chat_cards.rs` carry/render one
  fields vector and one content string per approval. Permission cards are a separate kind.
- `modules/finance/src/chat.rs` already continues values at UTF-8 boundaries but rejects the
  resulting card above the field/byte caps. Finance schemas include presentation-driven batch
  restrictions (for example `finance.import.apply` has `rows.maxItems: 1`).
- `module-host/src/runtime.rs` defaults guest messages to 1 MiB and guest memory to 64 MiB.
  Returning an unlimited card array in the current API would move the failure, not solve it.

## Ranked presentation options

| Rank | Option | Assessment |
| --- | --- | --- |
| 1 | Several numbered cards inside one approval group | Recommended. Clear item ranges, manageable layout on phones, bounded loading, one decision for the whole batch. More navigation, addressed with progress and Back/Next. |
| 2 | One scrolling card | Familiar, fewer controls. Long nested scrolling is harder on phones and makes the end easy to miss; virtualization needs accessible navigation and review tracking. |
| 3 | Full-width review sheet opened from chat | Most room for very large imports, but adds a modal/screen, focus lifecycle and navigation away from chat. Defer unless real use shows numbered cards inadequate. |

All options share the same backend presentation and one approval ID. Choosing a different layout
must never change execution semantics. Separate tool calls with separate Approve buttons are not
an option: they lose the original batch's all-or-nothing boundary.

## Plain mockups

Illustrative design sketches only, not screenshots or live proof. Example: one import of 60 rows.
Each item includes its complete supplied values and effects; compact rows here stand for those
labelled fields. The ellipses describe additional visible/scrollable content, never omitted data.
Use the existing Action request card, type, spacing, button and danger treatments from
`docs/design-system.md`; no new visual brand. Values wrap at phone width, without horizontal scroll.

### 1. Several cards, one approval group (recommended)

Desktop, 760px chat area:

```text
+------------------------------------------------------------------+
| Action request · Finance import                                  |
| 60 transactions · one batch · nothing changes until you approve    |
| Card 1 of 6 · Rows 1–10 · 0 of 6 cards reviewed                    |
| +--------------------------------------------------------------+ |
| | Row 1 · Date: Nov 20 · Name: Market · Amount: $25.00           | |
| | Account: Everyday · Note: [complete wrapped note]              | |
| | ... complete rows 2–10; scroll this card to its end ...        | |
| +--------------------------------------------------------------+ |
| [Back]                         [Review next card]                 |
| [Approve entire batch — disabled until all cards reviewed]        |
| [Reject entire batch]                                            |
+------------------------------------------------------------------+
```

Phone, 360px viewport (with normal page padding):

```text
+--------------------------------+
| Action request                 |
| Finance · Import 60 rows       |
| One batch                      |
| Card 1 of 6 · Rows 1–10         |
| Reviewed: 0 of 6               |
| +----------------------------+ |
| | Row 1                      | |
| | Date: Nov 20               | |
| | Name: Market               | |
| | Amount: $25.00             | |
| | Note: full text wraps      | |
| | ... scroll to row 10 ...   | |
| +----------------------------+ |
| [Back] [Review next card]      |
| [Approve entire batch] locked  |
| [Reject entire batch]          |
+--------------------------------+
```

Final card replaces Next with “Review complete”; Approve enables only after the full presentation
is valid and each card's end has been reached. Back and direct card navigation remain available.
This checks exposure to the details, not that a person read or understood them.

### 2. One scrolling card

Desktop, 760px:

```text
+------------------------------------------------------------------+
| Action request · Finance import · 60 transactions                 |
| +--------------------------------------------------------------+ |
| | Row 1 · Date / Name / Amount / Account / full Note             | |
| | Row 2 · all fields                                           | |
| | ... scroll through all 60 rows ...                            | |
| | Row 60 · all fields                                          | |
| +--------------------------------------------------------------+ |
| Reviewed through row 12 of 60                                     |
| [Approve entire batch — locked until end] [Reject entire batch]   |
+------------------------------------------------------------------+
```

Phone, 360px:

```text
+--------------------------------+
| Finance import · 60 rows       |
| +----------------------------+ |
| | Row 1                      | |
| | Date: Nov 20               | |
| | Name: Market               | |
| | Amount: $25.00             | |
| | Note: full wrapped text    | |
| | ... scroll all rows ...    | |
| +----------------------------+ |
| Reviewed through row 12       |
| [Approve entire batch] locked |
| [Reject entire batch]         |
+--------------------------------+
```

### 3. Review sheet opened from chat

Desktop, 1000px sheet:

```text
Chat: [Finance wants to import 60 rows] [Review entire batch]
+------------------------------------------------------------------------+
| Review Finance import                                      [Back to chat]|
| One batch · 60 rows · 12 reviewed                                        |
| Row | Date   | Name   | Account  | Amount | Full details (wrapped)       |
| 1   | Nov 20 | Market | Everyday | $25.00 | Full note and effects         |
| ... scroll all rows; no hidden or clipped cells ...                     |
| [Approve entire batch — locked until reviewed] [Reject entire batch]    |
+------------------------------------------------------------------------+
```

Phone, 360px full-height sheet:

```text
Chat: [Review entire batch]
+--------------------------------+
| [Back to chat]                 |
| Review Finance import          |
| 60 rows · one batch            |
| Row 1                          |
| Date: Nov 20                   |
| Name: Market                   |
| Account: Everyday              |
| Amount: $25.00                 |
| Note: full wrapped text        |
| ... scroll remaining rows ... |
| [Approve entire batch] locked  |
| [Reject entire batch]          |
+--------------------------------+
```

## Recommended host and shell contract

1. Introduce a host-owned `ApprovalPresentation`: shared fixed title/target/danger, one optional
   version, ordered sections with stable item and continuation labels, and a completeness marker.
   Keep `ApprovalCardRecord` as a legacy one-section input adapter. A module supplies data, never
   executable markup or approval IDs. Only one top-level version is allowed; conflicting section
   versions are invalid. Host-owned labels and escaping retain the current trust boundary.
2. Add an opt-in paged card-builder API declaration alongside the existing `card` API. Its first
   request uses the original validated parameters; subsequent requests use a host-held preparation
   handle and cursor. The module produces a frozen disclosure snapshot for those parameters and
   source version. The host associates that handle with actor, module, tool and exact parameters;
   it is not a runnable approval token. Each reply has ordered sections, next cursor or explicit
   completion, and the same snapshot identity/version. Reject gaps, duplicate/repeating cursors,
   changed identity/version and missing completion. Legacy cards become one completed section.
3. Preserve every value. UTF-8-safe continuations retain the same item identity, label and order.
   Pack sections to bounded transport chunks; the present byte/field limits become chunk targets,
   not aggregate rejection limits. Never cut a long note or content preview. The module must
   disclose every affected item/effect; the host cannot infer semantic coverage from arbitrary
   prose. Finance provides row counts and stable row indexes so coverage can be checked.
4. Prepare and validate the complete disclosure before making an approval actionable. For large
   presentations, spool account-private, sanitized sections behind the host-held snapshot rather
   than allocate all sections into the chat response. Shell fetches pages by approval ID/index
   through actor/turn checks, never by arbitrary file paths. Clean up on expiry, turn end, account
   removal and startup recovery. Resource exhaustion is a safe, distinct preparation failure,
   never a truncated card or an automatic split into smaller writes.
5. `Book` retains one `Record`, `Action`, expiry and runner ID for the whole group. Store the
   complete parameters server-side; `ApprovalView` exposes summary, page counts and presentation
   identity, with an authenticated page endpoint for full details. No client-supplied params,
   version, counts or section IDs can mint a grant. Record section exposure server-side against
   the frozen presentation; approve checks complete preparation and all sections exposed. Reload
   restores progress from the record. Exposure reports are client-controlled review aids, not a
   security boundary; complete disclosure, exact-call binding and host rechecks remain mandatory.
   Expiry or invalidation disables the entire group.
6. Keep `consume`'s exact JSON match, actor/open-turn match and single use. Keep offered-tool and
   call-ID checks and host rechecks of current installation, account enablement, policy and pinned
   version. All sections share one Approve/Reject footer. Reject, timeout, changed snapshot or any
   missing section affects the entire batch. One approval dispatches the original tool once;
   presentation paging never invokes a write. Atomic commit/rollback remains the module's batch
   transaction responsibility: do not claim the shared host makes a non-atomic handler atomic.
7. Use normal page/card scrolling with labelled regions, keyboard-operable Back/Next and direct
   card navigation. Announce “Card n of m”, put focus at the new card heading, retain visited
   progress and position, and enable approval only after complete exposure. Long sections scroll
   to their end before Next records exposure. Reject stays reachable while loading or on failure.
   On phones use stacked full-width actions and no horizontal tables. Do not add a separate
   decision per card. Avoid unbounded DOM growth by mounting the current card only.

### Size limits beyond the card

Removing only `normalize_card`'s checks is insufficient. The build must inventory the entire
argument/result/socket/guest path (including the current 64 KiB argument and 1 MiB runtime message
limits), and replace presentation-driven aggregate limits with chunked transport or host-held
staged data referenced by a bound handle. The canonical full argument value remains the identity
used for exact-call comparison; a handle cannot substitute for unvalidated or mutable parameters.
Staging must be actor-scoped, immutable and verified before dispatch, and the guest must consume
that same staged value inside one batch transaction. Replace the model-facing 64 KiB aggregate
argument rejection too: accept and validate the full tool-call value before bounded staging/guest
transport. Card paging cannot rescue arguments rejected at ingress; test that boundary explicitly.
No global runtime-limit increase or arbitrary
new maximum batch size is an acceptable substitute. Domain validation limits remain only when
justified by the operation itself, not by card capacity. This transport work is part of the build,
not a follow-up hidden behind a claim of unlimited batches.

## Card-builder failures must reach the model

Use an explicit result, not `Option` or a denial boolean:

```text
prepare -> Ready(presentation) | Failed(code, safe_message, recovery)
confirm -> Approved | Declined | PreparationFailed(safe_error)
```

- Host distinguishes missing builder, invalid arguments, adapter refusal, malformed/incomplete
  presentation, unavailable service and source-version change. Declared adapter errors use a typed
  public error envelope; ordinary traps/internal errors get host-owned messages, not raw anyhow
  chains, SQL, credentials or private paths. Apply existing chat sanitization to public errors;
  sanitization failure uses a fixed generic preparation error and cannot authorize execution.
- Shell `ChatTools::card` preserves the typed safe failure. `raise_approval` returns a typed
  outcome and creates no pending record for a failed preparation.
- Extend shell-to-runner `op:answer` with a distinct preparation-error outcome, correlated to the
  pending approval request ID. Update the runner pending channel, Moss confirm callback and
  gateway to preserve it. Keep native agent permission answers Allow/Deny; do not force public
  adapter errors into agent permission driver protocols. A separate Moss confirmation outcome
  avoids changing the meaning of the shared `Answer` enum.
- Gateway returns `isError:true` with the safe code/message/recovery for the original MCP call.
  No tool dispatch, no grant, no “person declined” wording. Explicit Reject remains an actual
  denial. Disconnects, malformed answers, timeouts and unknown IDs continue to fail closed.
- Recovery can say “Read the current revision and try again” or “Approval details could not be
  prepared; retry later.” Do not direct the model to split an atomic operation to fit cards.
  An adapter's safe validation guidance must survive end to end, rather than become generic text.

## Build scope and acceptance after approval

Host normalization/paged preparation, shell approval store and contract/page endpoint, Leptos
cards, runner wire protocol and Moss gateway outcome propagation ship together. Adapt Finance's
builder and remove only its presentation-driven schema caps/split guidance in the same build so
one actual oversized batch exercises the shared path. Before editing schemas, list each affected
Finance cap and its domain or presentation rationale in the build PR; include bulk categorize,
bulk confirm and import apply rather than assuming every array cap is a card workaround.
Audit legacy callers for compatibility.
Update core chat app-map declarations and Finance feature errors/remediations with the product
change; this docs-only phase deliberately changes no app-map behavior.

Required build evidence (not run or claimed in phase 1):

- First reproduce a supported Finance batch failing the old field/byte limits and demonstrate
  the same call succeeds after the change. Include more than 32 fields, more than 32 KiB,
  a value over 4096 bytes, multibyte continuation boundaries, and cross-transport-boundary cases.
- Assert every row/field/value round-trips in order without loss. Test multi-page source changes,
  repeated cursors, missing final page, interrupted loads, cleanup and reload. Approval stays
  disabled/ineligible on incomplete data; all pages belong to the same frozen presentation.
- Assert exactly one original tool invocation and one batch commit. Inject a failing middle item
  and observe rollback of the whole Finance batch, not partial success. Existing domain limits
  are distinguished from presentation limits.
- Negative checks: another actor, closed/wrong turn, altered/reordered array arguments, tool or
  module substitution, wrong version, replayed call/approval IDs and partial-card approval cannot
  execute. Observe protection tests fail with the relevant binding protection removed.
- Drive an ask-policy builder refusal through real shell -> runner -> gateway and assert the
  model's tool result contains the safe specific reason, with no dispatch/grant. Cover malformed
  builder replies, safe redaction, redaction failure, missing builder, native permissions and an
  actual person's Reject separately.
- Live installed Finance UI acceptance at desktop and phone widths: inspect first/middle/last
  cards, long values, review navigation, failure state, Approve/Reject, expiry and final stored
  effects through the real app. Screenshots are real build proof, not these design sketches.
- Run scoped Rust/format/contract checks and required project gates after implementation. Every
  heavy gate/live run takes the shared heavy-gate flock, with `CARGO_BUILD_JOBS=1` and
  `RUST_TEST_THREADS=1`; scripts/logs go to the task scratch directory specified in the brief.

## Phase 1 exit

Commit this spec, open a draft PR with Release note `Category: N/A`, notify coordinator pane t6n,
and stop at **Spec ready for Ben**. No implementation, heavy gates, live test, ready/merge request
or auto-merge in this phase. Recommendation and mockups await approval; the implementation may
need decomposition once the paged transport seam is reviewed.
