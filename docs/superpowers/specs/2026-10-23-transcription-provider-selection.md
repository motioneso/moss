# Instance transcription provider selection

Approved direction: Ben requested moving transcription into AI providers and
clarified on 2026-10-23 that an admin chooses one provider for everyone. Task #3601,
part of production acceptance #3565. Work stays in
`~/Jarv1s/.claude/worktrees/vocci-meeting-preferences`.

In Settings → Admin → AI providers, the Transcription group offers a single
provider/model selection using existing configured API providers and models with
the transcription capability. Reuse the existing Group, Field, Select, Button and
Note primitives; no new screen or stylesheet. Loading/error states disable saving
and expose Retry. A missing saved model remains visibly unavailable until changed.

The existing Voice endpoint remains the default for upgraded instances, including
its stored key, model and enabled state. A saved model selection uses the selected
provider's current credential directly. It does not duplicate keys or change chat
routing. Admin pins still take precedence. Only active OpenAI-compatible API-key
models on an active admin-owned provider with a credential may be selected. A
missing, disabled, revoked or incompatible selection fails closed; never switch to
another provider silently. Explicitly selecting Existing voice endpoint removes
the selection and restores the existing endpoint behavior. Only admins can change
the instance selection.

Normal transcription and timestamped Meeting imports use the same capability
resolver. Preserve language forwarding, cancellation, route-change guards and
hold review/Send consent. Correct the confirmed audio metadata defect: retain the
uploaded audio MIME type and give known containers matching multipart filenames,
preserving bytes and unknown formats' existing behavior.

Acceptance: real settings selection and reload, real transcription request to the
selected provider, legacy endpoint preservation, admin/non-admin checks, no fallback
on disabled selection, pin precedence, and unchanged chat routing. Record independent
Standards/Spec review and live proof before merge. Device production setup and real
pending-transfer/reboot acceptance remain tracked separately in #3565.
