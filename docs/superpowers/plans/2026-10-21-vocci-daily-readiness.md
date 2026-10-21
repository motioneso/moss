# Vocci companion: daily readiness

Ben authorized continuing the companion to production polish on 2026-10-21.
This extends the approved Meetings/Main spec and task #3553; PR #3554 remains
draft. No merge, production deployment, ownership or firmware change is authorized.

## Delivery order

1. Remember an explicit Start/Stop choice. Resume a previously started foreground
   connection after boot/unlock or an app update when prerequisites permit. Stop
   disables automatic recovery. Maintenance actions cannot enable recovery and ask
   for Start while stopped. Force-stop still needs a manual launch. Expose
   battery restrictions, permission recovery and the official app handoff in the
   existing Park Press Connection section. Preserve queue identities and bindings.
2. Add opt-in automatic cleanup of completed local copies, after seven days, with
   an explicit on-screen explanation and manual cleanup still available. Never
   delete pending, failed or interrupted evidence, and retain deduplication
   tombstones. Clean orphaned atomic temporary files only for completed sources.
   Do not issue ring deletion commands or evict source identities to mask limits.
3. Replace injected Moss sessions with browser-approved Android linking. Reuse
   the existing verifier/approval exchange after reviewing its consumers; current
   Mac credentials must retain their existing boundaries. Android credentials need
   explicit upload/voice authority, owner pinning, revocation, expiry and a safe
   relink path. Never embed or scrape sign-in. Existing valid ring keys survive.
4. Provide a release build with production manifest, non-debuggable code,
   external signing and no test instrumentation. Preserve update identity; do
   not replace the installed original with an incompatible signing certificate.
5. Exercise installed native controls and actual backend routes, including
   interruption/restart, sign-out/expiry, wrong owner, cleanup exclusions and
   duplicate prevention. Run repository static checks and relevant isolated
   integration/browser checks. Record remaining physical endurance limits plainly.

## Native screen changes

Keep the existing ruled, numbered Connection / Voice messages / Local audio /
Recent deliveries layout, Archivo headings and 48dp controls. Connection shows
account linking and whether automatic restart is enabled. A Permissions and
background settings disclosure holds permission recovery, force-stop guidance,
battery settings and the official Vocci settings handoff action.
Local audio adds a switch labelled “Clear delivered audio after 7 days”, off until
chosen, and states that Moss copies and ring recordings are retained. Linking
opens the person's browser and returns to a visible pending/linked/relink status.

## Acceptance limits

The existing real short Meeting/Main proof and accepted simulated two-hour checks
remain the baseline. New claims require new evidence; generated fixtures are not
physical reboot/radio endurance or real long-form transcription evidence. Ring
space reclamation, fresh ownership, firmware parity and streaming remain distinct
from a polished existing-binding daily companion. Report incomplete work honestly.

## Verification receipts

- Canonical `test:companion` run `20261021-124701`, commit `3b4735409`,
  dirty fingerprint `e218eb4317e0`: exit 0, 80 tests across five files. Includes
  Android approval/session binding, distinct issuance, platform and mixed-cookie
  checks, logout and version metadata preservation. This is component evidence.
- Canonical `test:recording-live` run `20261021-125116`, same plan commit,
  dirty fingerprint `5f7a2430f12e`: exit 0. Fresh Firefox owner signup/onboarding
  and the installed isolated Android app exercised Connect/Cancel, browser Android
  permissions/Approve, credential replacement, generated normal and explicit voice
  uploads/replay, Active sessions revocation, relink and Disconnect. The replaced
  link left one visible Android session. Cookie removal and original owner were
  checked by the installed client. Connection-settings disclosure and retention
  switch persisted across activity recreation. No network interception was used.
- These auth/transport samples are generated 100 ms Opus silence with valid
  sidecar metadata and a synthetic ring configuration. There was no ring I/O or
  speech-recognition accuracy claim. Real ring/ASR/summary/Main evidence stays at
  its original baseline receipts; it is not relabelled as new-auth proof.
- Release packaging with a temporary test signing key passes signature validation,
  non-debuggable/TLS-only manifest checks and absence of instrumentation/check
  classes. The temporary key was removed. No production key was created and no
  release APK was installed over the configured companion.
- Phone timeout was restored. The original companion, actual ring binding and
  retained evidence were untouched; only the separate proof package was exercised.

Final static/security controls and CI are recorded on PR #3554. Until those
receipts and review are complete this remains draft, with no merge/deployment.
