# Ring text through normal automatic Main chat

Part of #3584. #3565 and #3584 remain open. Ben's controlling automatic-send
clarification is captured in the [spec](../../superpowers/specs/2026-10-24-vocci-normal-chat-input.md).
The [bounded plan](../../superpowers/plans/2026-10-24-vocci-normal-chat-input.md)
was committed and independently reviewed before product changes.

## Implemented boundary

Product head: `dc4ebd4ca1c4b53b973db21782998e3747ac465a`.
Base: `4f757bccc52cdc589dcf96cd07e360486a9d26f2`.
New nonempty versioned ring requests persist an immutable automatic-send policy,
then use the existing Main manager, availability/privacy fences, claim identity,
configured model, permissions and saved message pair. No browser mount or poll
submits messages. Migration 0333 defaults retained receipts to false; existing
pending/queued policies remain unchanged. No mass dispatch or fingerprint upgrade.

The drawer renders ring input in its canonical Thread/RecordRow transcript,
reconciles by turn/message identity, recovers missed completed pairs through owned
history, and preserves typed drafts and live activity. Retained legacy review
inputs have inline Send recovery; interrupted outcomes offer no resubmission.
Bounded keyset pages keep older pending inputs accessible beyond 100 receipts.
Owner/Main/privacy/selection fences control receipt queries. Chat, Meetings and
core app-map declarations describe the resulting behavior.

## Verification

Private raw artifacts are under
`~/.local/state/moss/vocci-recovery/normal-chat-input/`.
Frozen digests: `evidence-sha256.json`.

- Plan `9817284b7`: independent Standards 0 / Spec 0 before implementation.
- Product `df7e0667e`: Standards 0; Spec P2 identified older pending inputs appended
  after newer live turns. Product `dc4ebd4ca` fixes the ordering with older-date and
  equal-time-ID coverage; independent Standards 0 / Spec 0, including independent
  reproduction of the correction.
- Focused unit run: 52 tests in 5 files passed. After correction, 21 tests in 2
  UI/reconciliation files passed; these overlap the earlier run, not an additive
  total.
- Isolated `test:voice-requests`, gate suffix 20261024-092910: 234 tests in 10 files
  passed, exit 0. This is a dirty implementation receipt before product commit;
  fingerprint `9828e43402dc6783dfc82467a71c57f40230925ed5448092f0846eabafb75468`.
  It covers durable admission/claims/replay, legacy/new policy, no speech,
  pagination of 101 rows/equal timestamps, owner isolation/export, receiver, schema catalog,
  account lifecycle and canonical interrupted/action history. Container removed.
- Security negative control, suffix 20261024-092803: receipt RLS disabled only in
  the throwaway server; owner list/read/export assertions failed as expected,
  exit 1 (three failures), container removed. Normal protected run passed afterward.
- Isolated `test:normal-chat-live`, suffix 20261024-093651: exit 0, NORMAL CHAT LIVE PASS; clean product head above, fingerprint
  ea32a5aa8cc4e66b35dc7831eb8d8dc0eadd173f415c95ae3067fdd83942a81b,
  Node v22.22.2 / pnpm 10.6.2 / PostgreSQL 17.11. Throwaway container removed.
- Full local `verify:static` exited 0 (`static-r2.log`). It began before the
  final amendment and is not an immutable final-head receipt; required exact-head
  CI supplies the final static/integration gate.

## Assembled UI proof and limitations

Webwright `live/final_runs/run_3/` retains the executable (byte-identical to
the committed harness), eight-step action log and receipt. Actual UI Settings
saved Chat & briefing/transcription bindings for a newly signed-up disposable owner.
The real receiver accepted uncertain-time versioned generated audio, automatically
producing a normal user/reply pair with no Send/popup and preserving an unsent
typed draft. Exact envelope replay and browser reload preserved one canonical pair.
Private selection hid the pending text and deferred effects until Main. An actual
in-flight typed turn deferred two arrivals, which later completed serially.
Disabling the selected chat model caused real preclaim unavailability; restoring
it recovered queued input automatically. A pre-upgrade legacy fixture stayed
ready-to-send inline until its one-request recovery control was clicked. All six
voice turns matched exactly their reserved user/assistant message IDs. A 390-pixel
viewport asserted no horizontal transcript overflow. No voice POST occurred on
mount/reload; initial automatic input required no browser send endpoint call.

Generated sine audio/synthetic packet framing and disclosed loopback ASR/chat
stand-ins exercise Moss's real receiver, transcription adapter, durable jobs,
ACP runner, normal admission and message persistence. They do not establish speech
recognition quality, real-device framing or physical hold acceptance. No Moss HTTP
response was intercepted, rewritten or replayed. Browser service workers were
blocked; no PWA lifecycle claim. Narrow layout is a DOM width check, not a visual
or accessibility audit. The pre-upgrade legacy receipt is a disclosed fixture
inserted through owner-scoped DataContext only in the disposable gate database.

Retained failed live runs: run 1 used an obsolete Settings selector; run 2 passed
Settings/automatic input/draft/replay/reload/private deferral, then failed while
racing private exit with a redundant reload. The corrected harness waits for the
ordinary transition. Failures are not acceptance evidence.

## Review, release and remaining queue

Final immutable evidence review and exact-head required CI are required before
merge; local receipts do not replace them. No deployment is part of this PR.

Companion 20261027 remains installed; the previously completed physical outage was
not repeated. No phone, production recording/replay/deployment, hold enrollment,
reset/rebind/deletion/reboot/firmware or ownership write occurred. The production
copy source stays `967bee00b1aa2119bc8ea55aa4b402f48898a6ff`. Preserve signing/Keystore,
configuration, queues/exclusions/originals/completed imports/hold destinations,
enabled=true, hold=false, cleanup=false, timeout=120000 and official permission handoff.

The entire recovery queue remains: package replacement; physical out-of-range,
offline and interrupted upload; separately opted-in production hold;
reminder/endurance; other approved missing Meeting processing; proven exact-source
deletion; original-preserving enhancement; firmware compatibility/recovery and
streaming. Virtual Android stays deferred; #3565/#3584 stay open.
