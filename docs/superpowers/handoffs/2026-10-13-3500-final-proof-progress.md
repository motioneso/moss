# #3500 final proof progress

PR #3509 remains the governing handoff. This checkpoint records harness repairs and exploratory
results; it is **not merge readiness**. #3500, #3507 and #3508 remain draft and unmerged.

## Disposable target-loss fixture ruling

On 2026-10-13 Ben approved: "Allow the bounded disposable fixture (recommended)".
The exception permits bootstrap deletion of only the newly created owner side chat in the
disposable UAT stack. Migration 0277 intentionally forbids ordinary runtime chat DELETE;
no production grants or deletion API are changed. The fixture validates identifiers, matches
the owner, excludes Main/private/non-drawer chats, and asserts exactly the target was deleted.
All subsequent failure, history and recovery assertions use production owner paths.
This is an explicit exception to PR #3509's "Never bypass runtime RLS" fault-setup rule.

## Harness repairs

- Real-chat setup uses the existing owner admin pin and verifies chat, tool-use, JSON and
  summarization routes select the discovered economy model with reason `admin-pin`.
  Final runs must request Codex `gpt-6-luna`; provider fallback is not authorized.
- #3135 removes a debug-only lookup that assumes an editable model button. Original acceptance
  assertions remain; model identity is checked through effective routes and activity.
- #3148 adds full-task equality for combined text/time/repeat/stop refusal, focused-draft
  checks on shown-side arrival, actual offline/reconnect catch-up with durable identity,
  observed arrival during a real reply, and executed model-activity identity checks.

## Exploratory results

- Scoped #3148 database gate: 122 tests passed in 8 files, exit 0, pinned source
  `11e7fd7585125a8c9acfdab3ea3e4aedda280f3c`, dirty harness inputs.
- Broad browser run with four workers: 268 passed, 19 failed, 1 skipped. Failures mainly
  showed the app loading; cause is not established. One failed Settings case passed alone.
- Complete browser rerun with one worker: 287 passed, 1 skipped, exit 0. Same suite and
  assertions, temporary configuration changes only the server to a claimed dev port and
  output paths. The skip is not a complete no-skip live acceptance receipt.
- Initial installed #3148 run verified model routing, atomic text refusal, standalone
  destination moves, exact queue history/UI delivery and layout. It failed at the runtime
  DELETE fixture with SQLSTATE 42501, before the approved bootstrap repair.
- Installed run at `7a36af4dc` passed all four combined refusals and standalone moves, then
  failed waiting 90 seconds for a reminder due in 90 seconds. A 120-second bounded wait
  subsequently passed delivery, exact histories and focused draft preservation.
- That subsequent run failed the offline-only fixture: the established SSE socket continued
  receiving arrivals despite Chromium offline mode. The repaired fixture restarts only the
  disposable app service while the browser remains offline, then checks actual reconnect.
- The complete typecheck command passed after making the shared JSON reader accept both
  browser and API response methods. Later assertion/fixture edits still require final checks.
- Scoped lint/format checks pass for the harness repairs. Final clean committed-head
  foundation/scoped/browser/image/live gates and independent final review remain required.

## Remaining acceptance work

The clean `d873055407b4bd02d35a08d57af20d3f2af3b1d8` scoped database gate passed
122 tests in 8 files, exit 0. Input fingerprint:
`2828d15fa03184c88d90410956abf3d7a72623c761e9c068840e47e6f9201305`;
Node 22.22.2, pnpm 10.6.2, PostgreSQL 17.11. The corresponding foundation run was
stopped with exit 143 before changing its inputs; it is not a completed receipt.

The installed run on that head passed combined refusals, standalone moves, durable
delivery and draft checks. Service-restart reconnect reached catch-up and preserved
the draft/focus, then failed because its history filter counted the saved confirmation
alongside the delivered reminder. Reconnect and overlap history filters now require
the delivered event. Independent product review also identified a completion/history
ordering race: the packing reply check now examines both newly appended bubbles,
while retaining exact durable message ID/body assertions and observed streaming overlap.
The overlap and target-loss steps were not reached in this run.

Concurrent browser traces contain `ERR_NETWORK_CHANGED` on imported modules while
the page remained at Loading Moss. Disposable Docker network changes occurred during
this run; serialize the next browser receipt with Docker provisioning/cleanup. This
is an observed transport failure and a candidate cause, not a product regression verdict.
The installed image ID was
`sha256:edf88bbc080ceb7d7d7b99df66667080b80b13de2581b7307d8826004a1bfaa5`.
These assertion repairs require fresh final-head checks and live proof.

The clean `450cac1a6` scoped gate also passed 122 tests in 8 files, exit 0.
The corresponding foundation was stopped with exit 143 after preflight found a
second legacy-harness contract mismatch. ACP activity records do not carry an
executed outcome: tool calls and results are linked by `toolCallId`, and failed
updates also produce result records. Attachment and News proof now require
correlated positive result data: filename/content, available Settings view, and
the News error/remediation identifier in returned map items. Persisted result
text is capped at 500 characters, so the view/map checks tolerate truncated JSON
and Markdown tables. These repairs are not yet live-validated.

The next installed #3148 attempt completed reconnect catch-up, draft/focus and
durable identity checks. Overlap was inconclusive: starting the fixed packing
request less than five seconds before due left no meaningful reply text before
the reminder arrived. The fixture now starts less than twenty seconds before due
to allow CLI startup, retaining the same prompt and every streaming/arrival
assertion. This is one bounded timing correction; no repeated prompt tuning is
authorized. Target-loss recovery and later specs were not reached. Source changed
in the legacy harness during this exploratory run, so it is not a frozen-head
acceptance receipt. Its built image ID was
`sha256:9ff3f87c4ac33eef2b2ab417b9d783e91517a34fe218caba23c4f64d85fef678`.

On `25c4d5016`, runtime-context passed its ordinary transport case, then three
later setups failed with HTTP 409 before their acceptance assertions. The first
setup had persisted an admin pin; production deliberately rejects user chat-model
override writes while pinned. The shared helper now uses only the existing admin
pin, retaining exact route checks for all four capabilities. Its redundant user
override helper had no other callers and was removed. This preserves production
configuration authority and requires fresh multi-case live validation.

Run all fourteen blocking specs from PR #3509, regenerate trigger selection after edits,
and require three consecutive complete #3151 runs. Track each spec's actual exit.
The selected legacy specs originally included scripted providers and explicit `test.fixme`
cases in runtime-context and attachments. Strict live-proof repairs select the pinned real
model and execute the previously deferred checks; their actual live results remain pending.
The News fault uses supported admin configuration to disable same-provider JSON fallbacks,
remove the pinned model's JSON capability temporarily, verify routing unavailable before chat,
and restore the exact capabilities and changed statuses. Grounding checks use the returned
assistant message's invoked-tool activity, not the offered tool catalog. Do not weaken original
assertions, invent model output, omit notifications/Workshop, or merge #3507 before #3500.

## News current-view repair and latest installed results

At `c1175efec`, runtime-context passed two cases and failed two behavioral assertions:
the screenshot refusal offered an upload rather than pasted text, and News prerequisite
context omitted the disabled Add source gate. The latter gate now exposes its existing
registered prerequisite/remediation metadata and visible copy to page capture. The News
manifest reflects this behavior. UAT waits for a successful actual page-context upload
containing both the copy and structured error before asking Moss; it fabricates no context.
Screenshot refusal accepts either apostrophe style but still requires pasted-text guidance.

The SSR regression was observed failing before the News repair. News settings and page-context
unit suites then passed 74 tests in two files. Independent product and authority source reviews
identified no remaining blocker in the repaired delta; installed validation remains required.

The separate installed batch passed all three attachment cases. Its subsequent #3148 run passed
combined refusals, destination moves, durable histories, focused drafts and real reconnect,
then failed before overlap proof: Stop generating appeared, but no new reply bubble appeared
within ten seconds. The approved single timing adjustment did not establish overlap. Target-loss
recovery and the later eleven specs were not reached. The disposable stack and all its volumes,
including copied CLI auth, were removed. No full foundation or final merge readiness is claimed.
