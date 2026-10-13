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
- #3135 removes a debug-only lookup for the editable model button, which becomes a locked
  display under the admin pin. Original acceptance assertions remain.
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
- Scoped lint/format checks pass for the harness repairs. Final clean committed-head
  foundation/scoped/browser/image/live gates and independent final review remain required.

## Remaining acceptance work

Run all fourteen blocking specs from PR #3509, regenerate trigger selection after edits,
and require three consecutive complete #3151 runs. Track each spec's actual exit.
The selected legacy specs include scripted providers and explicit `test.fixme` cases in
runtime-context and attachments; those cannot be represented as real-model, no-skip proof.
Resolve their acceptance paths explicitly before declaring readiness. Do not weaken original
assertions, invent model output, omit notifications/Workshop, or merge #3507 before #3500.
