# Transcription provider selection — task #3601

Spec: `docs/superpowers/specs/2026-10-23-transcription-provider-selection.md`.

## Seams and decisions

- `packages/ai/src/repository.ts:1237` resolves all transcription consumers after
  admin pins. Its voice branch currently selects the dedicated endpoint. Add an
  explicit model binding before that default; do not revive old capability routes.
- `packages/ai/src/capability-route-routes.ts:113` already admin-gates model binding
  writes. Extend this route and the shared schema for transcription model selection;
  reject mode bindings and unsupported/private provider targets. Reuse atomic JSONB
  merge/removal in instance settings; no migration or credential copy.
- `packages/ai/src/repository.ts:616` lists configured assistant models. Keep legacy
  voice-provider isolation and generic model edits unchanged.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:538` loads provider/model lists;
  its existing voice group is the selection location. Reuse those records and shared
  controls, keep the custom endpoint form as the upgrade/default configuration.
- `packages/ai/src/transcription-routes.ts:116` drops MIME and
  `packages/ai/src/adapters/http-api.ts:180` drops the filename extension. A generated
  WAV failed with HTTP 400 at the real configured provider and succeeded with WAV
  metadata. Regression tests have already failed on the unchanged production code.

An alternative was copying a selected provider's credential into the old endpoint.
It would reuse the endpoint schema but create stale duplicated credentials after
rotation. A model reference uses existing live configuration and route fingerprints.

## Implementation and verification

1. Repair upload metadata; preserve raw bytes and timestamp/text-only behavior.
2. Extend explicit instance bindings and resolver, including shared-provider
   validation, no fallback, legacy endpoint default and admin pin precedence.
3. Add the admin selection using existing settings primitives; preserve selections
   while queries load/fail and report actual saved state. Update the app map.
4. Run focused unit regressions and isolated database integration tests through
   `scripts/run-gate.sh start --gate test:integration:3601` (expected exit 0), plus
   `pnpm verify:static` (expected exit 0). All checks unpiped.
5. Exercise the real Settings → AI providers path on an isolated live dev instance,
   select/reload a provider, submit generated audio through the real service and
   verify the selected destination. Disclose any third-party ASR stand-in. Independently
   review the exact commit against Standards and Spec; resolve findings, run CI and
   merge only after live proof. Production rollout is a separate verified action.

Determinism: selection/save/error feedback renders from records and request outcomes.
No chat turns or prompt guidance are added. Existing model jobs remain transcription
and summary generation. Kill gate: the implementing agent leaves the PR unmerged if
the real selection-to-provider path or legacy/pin protections cannot be verified.
