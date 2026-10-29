# Shared Meeting vocabulary: approved best-effort choice

Part of #3584. On 2026-10-24, Ben answered the originating vocabulary-design
request: **“Approve and best effort”**, and confirmed approval in the owning chat.
The original response is retained privately in the existing needs-ben reply route.
No further general design approval is required for this choice.

This selects the best-effort alternative in the
[reviewed proposal](2026-10-24-meeting-vocabulary-proposal.md), rather than its
recommended strict supported-target contract. No vocabulary product implementation
has shipped. The feasibility research remains evidence about provider contracts,
not evidence about the configured provider's behavior.

## Controlling product decision

- Provide the owner's shared Meeting spelling list with explicit Save/Clear in
  the existing Meetings settings experience. Explain that spellings accompany
  upcoming Meeting audio and may help recognition without guaranteeing a match.
- Apply the list through actual live Meeting clips, short normal imports and
  long-import windows. Preserve the existing per-request preference timing,
  owner scope and selected transcription route. Hold/raw chat voice stays separate.
- Use optional best-effort standard prompt hints. A compatible endpoint may
  silently ignore them; keep transcription working in that case. Unknown semantic
  support must not itself cause the strict variant's ASR rejection or unavailable
  setting. Do not promise support from a URL/model name or an HTTP 200 response.
- Preserve explicit Save/Clear, record-based acknowledgements, saved drafts on
  errors, deterministic term serialization and retained original transcripts.
  Do not replay recordings or rewrite retained text to demonstrate the setting.
- The proposed strict metadata/verification lifecycle and rejection of later
  incompatible targets are **not selected**. Those paragraphs in the original
  proposal are historical alternatives, not implementation requirements.

## Technical work before release

The implementing agent must reconcile the implementation plan to this choice,
capture the initiative, trace current code with graph-first discovery and commit
the bounded plan before product changes. Reuse existing preference/ASR seams and
the authored design system; update the app map in the product PR.

Establish safe complete-hint bounds and language handling, including the proposed
explicit matching transcript-language experience. Best effort is not permission
to exceed documented wire/token limits, silently truncate, choose another provider
or invent vocabulary accuracy. Provider HTTP rejection is distinct from silently
ignored hints: specify and verify its handling in the plan instead of inheriting
the strict variant or inventing an unreviewed audio resend.

Required proof includes actual selected-route multipart transport, empty omission,
all three Meeting consumers, hold/raw voice independence, owner-scoped persistence,
save/reload/clear/error UI and safe request failures. Use verify-gate for DB work.
Disclose provider stand-ins and separately state any actual-provider linguistic
limits. Independently review immutable Standards/Spec heads, resolve findings,
pass applicable checks/required CI and exercise the assembled real UI before merge.

The physical adapter check is separately recorded in
[its evidence](../../evidence/vocci/2026-10-24-adapter-recovery-physical.md).
This decision authorizes no reinstall, extra outage, new recording/replay, deletion,
hold enrollment, reset/rebind, reboot, firmware or server deployment. Preserve the
whole existing queue and keep #3565/#3584 open. Virtual Android remains deferred.
