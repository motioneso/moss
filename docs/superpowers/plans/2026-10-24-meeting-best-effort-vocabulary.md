# Best-effort shared Meeting vocabulary

Part of #3584, which remains open alongside #3565. Authority: Ben's “Approve and
best effort”, recorded in the controlling
[decision](../specs/2026-10-24-meeting-vocabulary-decision.md). The original
proposal's strict selected-target support lifecycle is not selected. One bounded
vertical slice; no production deployment, phone operation or recording replay.

## Current seams

Verified after clean fast-forward to `1a79c74b4`. The graph MCP tools are not
exposed in this session; the installed codebase-memory CLI failed to connect to
its active daemon within its connection deadline. Bounded source reads supplied
the following evidence rather than treating an old graph as current.

| Capability                                  | Current source                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner-scoped preferences and partial writes | `packages/meetings/src/preferences.ts:22`, `preferences-routes.ts:17`; structured-state stores through `DataContextDb`, no new table needed      |
| Shared REST schemas                         | `packages/shared/src/meeting-preferences-api.ts:12`; reject additional fields                                                                    |
| Upcoming live speech                        | `packages/meetings/src/capture-service.ts:808`; reads language per non-silent request                                                            |
| Upcoming short imports                      | `packages/meetings/src/recording-import-service.ts:273`; only normal Meeting imports read preferences                                            |
| Upcoming long windows                       | `packages/meetings/src/recording-window-service.ts:77`; each window reads preferences, hold bypasses them                                        |
| Actual configured route                     | `packages/ai/src/configured-transcription.ts:120`; existing capability resolver, pins/legacy routes, sealed credential and dispatch revalidation |
| Multipart request                           | `packages/ai/src/adapters/http-api.ts:189`; model/file/language and timestamp options                                                            |
| Shared UI                                   | `packages/ui/src/field.tsx:1`, `select.tsx:4`, `styles/components-forms.css:22`; textarea CSS exists but React primitive is missing              |
| Existing Settings lifecycle                 | `packages/meetings/src/web/meeting-settings-state.ts:44`; session-scoped drafts, canonical PUT and query cache                                   |
| Assistant approval                          | `packages/meetings/src/action-presentations.ts:209`; preference presentation/version includes saved state                                        |

## Decisions

1. Add required response `transcriptVocabulary: readonly string[]` (default `[]`)
   and optional partial-update field to the existing preference contract. Store
   under `meetings.transcript-vocabulary` through the existing owner-scoped store;
   no migration or new deployment setting. Existing installs keep empty behavior.
2. One spelling per line. Trim surrounding whitespace, discard blank lines and
   exact duplicates, preserve case/order. At most 20 normalized terms. Reject
   embedded control characters, unpaired surrogates and line separators inside a
   term. Bound raw inputs before normalization. Serialize exactly with `, `;
   no instructions, prior transcript, identities or extra context.
3. **The complete serialized prompt is at most 200 UTF-8 bytes**, including every
   separator. Never truncate. This is a conservative byte-level BPE upper bound,
   not a claim that characters equal tokens: each encoded byte has a base token,
   and BPE merges only reduce the number. A Whisper wrapper's leading space adds
   one byte, so the bound is 201 tokens, below both the documented 224 and the
   inspected faster-whisper 223 context slices. Private executable proof examined
   all 256 base byte symbols in the cached multilingual Whisper tokenizer at
   revision `c3058b475261292e64a0412df1d2681c06260fab`, SHA-256
   `6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca`.
   Its 1,006 deterministic ASCII/Unicode/multilingual/random cases satisfy that
   bound (largest observed 129 tokens). This does not establish an arbitrary
   endpoint's tokenizer, lower limits, hint support or recognition quality.
4. Nonempty vocabulary requires an explicit transcript language. The user supplies
   spellings in that language; Moss does not infer the language of proper names.
   Reject a nonempty save with automatic detection, and reject clearing language
   while keeping saved terms. Empty clears always work. Recheck this invariant
   when assembling each request; invalid settings fail safely before audio fetch.
5. Read language and vocabulary through one canonical Meeting ASR-options method,
   used per non-silent live clip, normal short import and normal long window.
   Forward optional `prompt` through the existing configured AI port and HTTP
   adapter. Validate the bounded prompt at the configured port before fetch too.
   Empty vocabulary omits prompt completely. Hold and raw voice never consult it.
   Existing route selection, pin/legacy resolution, dispatch fences, audio bounds,
   cancellation and post-response route validation remain authoritative.
6. A compatible endpoint may silently ignore prompt. Do not infer support from a
   provider name, URL, model or HTTP 200; do not add a support registry or block
   unknown semantic support. HTTP rejection is different: preserve the existing
   safe failure classification and **one request only**, without stripping hints,
   switching provider or resending audio. Existing live gap/normal terminal-import
   behavior remains; settings changes affect later requests, not retained text or
   completed/failed imports. Network/rate-limit backoff stays as implemented.
7. Add shared `Textarea` over the authored `jds-textarea` primitive. Put a small
   vocabulary editor beside transcript language in existing Settings → Modules →
   Meetings, with explicit Save vocabulary and Clear vocabulary. Display matching
   language advice, transmission scope and best-effort limits; show validation
   before saving. Preserve draft on load/save/network errors and remounts within
   the same authenticated session; prevent overlapping preference writes. Clear
   persists empty and acknowledges the actual returned record. Keep keyboard,
   mobile width, light/dark and a park theme usable. No provider availability gate.
8. Extend approval presentations with individual before/after spelling fields and
   effective language validation. Update manifest settings/feature/errors/remedy
   declarations and generated app-map/UI catalogue in the same PR.

## Determinism and boundaries

All UI validation, saved acknowledgements and progress render from draft/request/
persisted records, never model output. The model has two existing jobs only:
transcribe audio and (when enabled) summarize the retained Meeting transcript.
Neither model determines save success. No new guidance or injected chat turn.
Vocabulary goes to the selected audio endpoint as additional request content;
no provider-retention or recognition guarantee. Queue payloads remain metadata
only. Preserve original audio/text, hold destinations and owner scope.

The whole recovery queue remains: unresolved package replacement; physical range/
offline and interrupted-upload proof; separately opted-in production hold;
reminder/endurance; other approved missing Meeting processing; proven exact-source
deletion; original-preserving enhancement; firmware recovery and streaming.
The one completed adapter check must not repeat. Installed companion 20261027 and
the separately deployed copy source remain untouched. Virtual Android is deferred.

## Delivery and verification

Commit this plan before product writes, then independently review the bounded
decisions. Implement contracts/persistence/request path first, then Settings and
approval/app-map changes, then one assembled proof. Tests must fail when their
respective wiring/validation/owner isolation protections are absent.

- Unit cases: normalization/dedup/case/order/Unicode and exact 200-byte boundary;
  all separators counted, 201 rejected without truncation, malformed input, empty
  omission, explicit-language policy, actual multipart model/language/prompt,
  ignored hints accepted, HTTP rejection exactly once, route changes still gated;
  preference draft/save/reload/clear/error and approval before/after fields.
- Isolated integration: owner isolation, defaults/partial writes, live speech
  hints (silence no call), short import and per-window updated hints; hold/raw
  independent. Existing transcripts/checkpoints retained.
- Real live UI: fresh isolated owner signup → actual Settings → language → Save →
  reload → validation/error/draft/retry → Clear. Run real normal recording import
  through Moss's unchanged API/service/configured adapter to an explicitly
  disclosed third-party ASR stand-in recording actual multipart requests. Prove
  short and multiple long windows, plus real capture path where available.
  No intercepted Moss responses. This proves transport, not linguistic benefit;
  no configured production endpoint or private recordings used.
- Static: `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck`,
  `pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:ui-catalogue`,
  `pnpm build:app-map` and web build, expected exit 0.
- DB tests/live runtime only under the **verify-gate skill**, using
  `scripts/run-gate.sh start --gate test:integration:3584` (expected launch exit 0)
  and one detached `scripts/run-gate.sh wait --follow` (expected completion 0).
  Use an isolated gate script for assembled UI proof; claim all owned server ports
  with devports and stop/release them afterward. Never pipe verification commands.
- Pin immutable base/head/evidence; independent code-review Standards and Spec,
  retain findings, fix/re-review, attach live proof, required exact-head CI green,
  then merge under standing authorization. Keep #3565/#3584 open. Verify successor
  execution/install/immutable ID before any further ownership transfer.

Kill gate owner: vocabulary builder. Stop release if complete-hint bounds,
language/selected-route transport, owner isolation, UI persistence/error proof or
required reviews/CI fail. Missing semantic hint support alone is not a kill gate.
An unavailable physical device does not block this software slice.
