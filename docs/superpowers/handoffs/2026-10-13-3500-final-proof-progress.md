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

Installed runtime-context at `730979b97` passed three of four cases: the News capture and
tool-grounded remediation now pass. Screenshot pasted-text guidance still fails.
The complete typecheck passed for the News repair.

## ACP roots found by installed proof

The ACP engine discarded `agent_message_chunk` and emitted replies only after completion;
no timing adjustment can prove streaming overlap under that contract. It now emits cumulative
reply snapshots with one stable ID and sequence, then replaces them with authoritative final
text and usage. The check-turn reader uses the latest snapshot. Failed prompts discard unread
partial replies and reject late chunks, preserving structured-generation failure semantics.
The failure regression failed with this protection removed and passed after restoration.

Independent inspection of the installed `codex-acp@1.10.0` bundle verified that it ignores
`session/new._meta.systemPrompt`. The persona now travels through the existing spawn RPC to
the owner-switched file writer, which writes the host-derived chat working directory's
`AGENTS.md` before the Codex adapter starts. Only OpenAI chat uses this file; absent persona
clears it. Workshop files and shared homes are untouched. Runtime type checks precede effects.
Actual installed instruction loading remains to be proved by the refusal case.

ACP engine, check-turn and runner tests passed 63 tests in three files; stream identity tests
passed 18. Independent product source review found no remaining blocker. These repairs still
require a rebuilt installed image, complete live acceptance and final-head gates before merge.

## Latest installed diagnosis and repairs

At `9bb60235e`, scoped DB proof passed 122 tests in 8 files on clean inputs.
Installed destination proof passed edits, delivery history and reconnect/draft/focus checks,
but failed before its first partial packing reply. Target loss was not reached.
Source diagnosis found reopened side chats excluded ordinary stream records because their
`liveThreadId` remained unbound. An admitted send now binds its confirmed destination and
clears the previous stream. Matching background arrivals survive in the fallback snapshot,
including through failed sends and retries. The regression failed before the streaming fix;
the arrival-preservation assertion also failed before its repair.

The runtime-context diagnostic passed two cases and failed two: screenshot refusal omitted
pasted-text guidance, and the News map result's error declarations fell outside its retained
500-character activity excerpt. The persona now explicitly gives pasted-text guidance whenever
a user requests a screenshot. The News assertion still requires actual uploaded error metadata,
a correct remediation reply, correlated successful current-view activity, and a correlated
nonempty map result naming `news.add_source`, JSON capability and economy tier. No response
is rewritten and no context is intercepted.

Newly selected News and quote-step fixtures use the shared real-model setup in strict mode.
The non-admin map case uses a separate admin context to provision and pin the model for the
second owner; the second owner's authenticated requests verify every capability and the actual
completed map-tool activity. Deterministic prerequisite/override cases remain unchanged.
The NewsAPI credential prerequisite is now supplied through a local owner-only environment
file after Ben used a one-time hidden-entry script. No credential value enters this document.

The file-size check found three files just over its limit. The drawer's unchanged waiting
indicator moved to its own component; three direct agent-home preparation tests moved to their
own test file; an inaccurate build-start-time comment was removed from `AcpHost`.

Regenerate trigger selection: the current baseline selects 21 blocking specs, including seven
added by the News/ACP repairs. Audit-feeds remains declared deterministic feedback fixture
proof, and CLI-terminal exercises actual PTY commands without model inference. Do not describe
these as real-model inference proof. Fresh installed receipts, full foundation, serialized
browser proof, three consecutive complete #3151 runs, CI and independent review remain required.

## Follow-up verification repairs

At `19543fb05`, clean scoped DB proof passed 122 tests in 8 files. Full foundation
finished with 17,229 passing unit tests, one failure and three skips; the failure was a
stale six-argument spawn expectation after optional persona forwarding. The expectation
now includes the seventh argument. This is not a full-foundation pass.

Installed runtime-context passed all four cases. Destination proof reached meaningful
streaming text but failed a sequential Stop check after reminder appearance; target loss
was not reached. A bounded MutationObserver now records visible reminder, visible Stop,
and meaningful new packing text in one observation. Prompt and schedule are unchanged;
failed overlap observations still fail acceptance.

Credentialed News failed before key submission: the classifier treated registered NewsAPI
as a publisher rather than an aggregation service. Only existing registry hosts (including
the supported www alias) receive the service classification. Active-provider policy approval
remains required. A reviewed-service cache suffix prevents old publisher-only verdict reuse;
the returned model fingerprint remains unchanged. New policy checks failed against the old
implementation, then the repaired policy/source/preview/protocol suites passed 83 tests in
four files. Final installed credential validation and the later selected fixtures remain
unproved. Fresh exact-head gates and rebuilt installed proof are still required.

At `47ed4154f`, scoped DB passed 122 tests in 8 files on clean inputs. The rebuilt
installed image passed News preview, key connection and healthy-source display; refresh
logged 41 collected candidates and a published 37-article snapshot. UAT then timed out
checking a field absent from its response: `NewsHeadline` exposes snapshot canonical
domain as `sourceKey`, not `canonicalDomain`. The helper now uses the shared overview
DTO and both arrival/revocation assertions check `sourceKey`. Rotation and revocation
were not reached. All later specs were not run. Full foundation was stopped (143)
before this harness correction, so it supplies no final receipt.

At `a4f20d996`, real source article arrival and rejected-key preservation passed. The
revocation assertion failed because the test clicked revoke while valid replacement was
still in flight: it accepted the already-visible Connected badge as completion. Request
logs show DELETE completed before the replacement POST completed, leaving Connected.
The serial journey now waits for the successful replacement response and form closure
before revoking. Concurrent replacement/revocation safety is not established by this test.
The disposable stack and copied auth volumes were removed; all later specs were not run.
