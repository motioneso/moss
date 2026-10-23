# Vocci recording management: fresh-session handoff

## Start

Ben accepted the installed Hardware settings build and requested a new session for
its next to-do. Own the next slice on `feat/vocci-recording-management`, in the
isolated worktree `~/Jarv1s/.claude/worktrees/vocci-recording-management`.
The previous session is finished with implementation; preserve its branch.

1. Install dependencies with `pnpm install`. Read AGENTS.md, CLAUDE.md,
   docs/DEVELOPMENT_STANDARDS.md and the approved scope in
   docs/superpowers/specs/2026-10-23-android-hardware-settings.md.
2. Read the private runtime handoff at
   `~/.local/state/moss/vocci-recording-management-handoff/runtime.md` before device
   access. It identifies the authorized phone, existing setup, prior proofs and
   already-extracted protocol audit. Reuse them; no new sign-in is needed.
3. Check live GitHub status for task #3584, draft PR #3586 and prerequisite #3576.
   Use the repo plan-build workflow for a bounded implementation plan for group 3.
   The flat Hardware direction and recording-management scope are approved; request
   clarification only for material unresolved behavior outside that scope.
4. Trace inventory, admission, queued delivery and source identities using the graph,
   then finish the targeted legacy individual-delete audit. Build the safe parts
   without waiting for optional protocol support. Record unsupported deletion honestly.
5. Implement, run focused checks, install and exercise real native UI, preserve the
   configured account/queue, update app-map declarations, and open a separate stacked
   draft PR against `feat/vocci-hardware-settings`. Keep #3584 open for remaining work.

## Next slice and acceptance

Implement group 3: individual ring recordings under Hardware → Vocci ring → Ring
storage, with inspection and an explicit durable exclusion from delivery. Deletion
is conditional on verified legacy protocol support.

- List actual saved audio sources using the existing serialized service connection.
  Activity reads snapshots and submits explicit commands; it owns neither GATT nor
  the delivery journal. Preserve per-field observation times, stale/unknown states
  and ring/account identity guards. Bound inventory and UI work.
- Inspect available recording metadata truthfully, including completion/delivery
  state where known. Keep ring sources, phone copies and Moss Meetings distinct.
- Exclusion must survive restart/reinventory and bind to the exact source and owner.
  Define what happens if delivery is already in progress or completed. Preserve
  pending, failed and interrupted audio and existing Main-chat destination/consent.
- A selected-recording delete needs a validated legacy command, exact-source
  confirmation and fresh post-command inventory verification. Determine the complete
  audio/sidecar bundle; avoid leaving ambiguous partial-source state.
- `deleteRingFile` names in the official app can refer only to local DB deletion;
  other builders can be V3-only. Follow the actual legacy transport call chain.
  Never use erase-all, factory reset, unbinding or a guessed opcode as a substitute.
- Hardware validation may delete only an explicitly authorized disposable sample.
  Valuable or unidentified user recordings must survive. If no safe command can be
  established, ship inspection/exclusion and document deletion as unavailable.
- Add meaningful regression coverage for exclusion persistence, identity, restart,
  admission/transfer races and deletion framing if supported. Keep existing queue,
  recovery, long audio, hold consent and phone-retention checks intact.
- Match the approved flat list and authored design system; maintain system dark
  mode, font scaling, readable status, back navigation and accessible confirmation.
  Use the design-system skill and docs/design-system.md before UI changes.

## Base and evidence

The product base is `b32e26256786e2f54c6c59d76f73d873507076cc` plus this handoff.
PR #3586 is open/draft, stacked on #3576 and guided setup. Dependencies remain
explicit; neither their presence in this branch nor green CI means production release.

Implemented first slice: Hardware launcher; existing automatic delivery and hold
choices; timestamped battery/recording/storage/version observations; separate phone
cleanup; connection help, ring guide and About; optional one-hour recording reminder.
Automatic delivery, retry/resume, restart recovery and normal-recording Meetings
already exist. Opening Hardware starts neither delivery nor hold input.

Evidence recorded on PR #3586:

- Host protocol/telemetry/reminder/PCM checks, including generated two-hour WAV,
  and development APK build passed on the product implementation.
- Physical legacy telemetry and installed DeviceChecks passed. The info request
  also aligns ring time; it is non-destructive, not strictly read-only.
- Final installed APK passed 21 native traversal assertions, including dark mode,
  1.5 font scale, cleanup cancel and preference round trips, plus seven Start/Stop
  assertions. Configuration and queue entries stayed intact.
- Full local verify:static passed before the final Java-only switch fix. Its APK
  was rebuilt and the installed regression suite passed afterward.
- Physical one-hour reminder/background endurance is still unverified.

At handoff, Android CI, static, both browser shards and both compose smoke checks
passed for b32e26256. The unit job failed before test execution during dependency
installation (exit124 while apt was unpacking); integration shards were partly
running. Recheck current checks and logs rather than carrying this status forward.
The older browser installation failure is superseded by the new passing shards.

## Guardrails and deferred work

Follow shared-checkout before commits; use explicit paths and keep the worktree
clean/pushed. You are not alone in the repository: preserve others' changes and
adjust your implementation to them. Use graph-first discovery and bounded reads.
Read reverse-engineer-anything before further shipped-APK analysis, and verify-gate
before any DB-touching checks. All dev servers require a devports reservation.
No screenshot, fake data or intercepted response substitutes for live-path proof.
No new agent is needed unless Ben or an applicable skill explicitly requests one.

Retain the existing mobile layout and Main chat. Hold remains separately opted in,
with transcript review and explicit Send; responses are text. No repeat setup proof
or email code should be necessary. Avoid repeated unlock requests: extend timeout
before requesting an unlock, then restore the saved settings during cleanup.

Shared Meeting language/vocabulary/enhancement preferences, firmware compatibility
and recovery, streaming, and reminder endurance are later slices. Existing summary
settings already use the instance default model. Do not add settings the ASR pipeline
cannot honor or invent available firmware updates.
