# Shared Meeting vocabulary — feasibility and proposed design

Task #3584, approved Android Hardware scope group 4. **Status: proposal for Ben's
decision; implementation is not approved by this document.** Research and current
source inspected on 2026-10-24 at base
`4e08402beb8879ceffd0e091199782f91b6555c8`.

## Conclusion

Shared vocabulary is feasible as an optional ASR spelling/context hint. Groq's
Whisper transcription contract and some self-hosted implementations support it.
Moss already routes live Meeting clips and normal imports through one configured
transcription port, but that port has neither a vocabulary input nor an option
support declaration. Its existing `transcription` capability does not establish
prompt support. Do not ship an inert preference or advertise arbitrary compatible
endpoints as supporting vocabulary.

Recommend an owner-scoped list of spellings in the existing Meetings settings,
used only when the resolved ASR target has an explicitly established prompt
contract. Unknown support keeps vocabulary unavailable while existing empty-list
transcription continues. The support contract, language policy and screen below
need approval and implementation planning before product changes.

This slice changes documentation only. It neither implements vocabulary nor
tests the configured production provider. No device, runtime or production action
was performed. #3565 and #3584 remain open.

## Current seams, verified in this worktree

The general `Jarv1s` graph returned an older preference definition without language.
A fresh worktree graph was indexed before tracing; these citations refer to the
current source, not that stale result.

| Concern                  | Existing source and observation                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared preferences       | `packages/shared/src/meeting-preferences-api.ts:12` defines language, audio source and summary choices. No vocabulary field; schemas reject additional properties.                                                                                              |
| Actor-scoped persistence | `packages/meetings/src/preferences.ts:22` reads/writes structured preferences with `DataContextDb`; `preferences-routes.ts:17` resolves the authenticated actor for GET/PUT. Reuse this ownership seam.                                                         |
| Settings and approval    | `packages/meetings/src/web/meeting-settings-form.tsx:94` owns language in the existing form; `action-presentations.ts:209` owns proposed preference changes. Extend both for any future vocabulary mutation.                                                    |
| Live clips               | `packages/meetings/src/capture-service.ts:808` reads language before each new speech request. Near-silence skips ASR.                                                                                                                                           |
| Short imports            | `packages/meetings/src/recording-import-service.ts:273` reads preferences only when `meeting_id` exists; hold voice requests omit them.                                                                                                                         |
| Long imports             | `packages/meetings/src/recording-window-service.ts:77` does the same per window. Existing checkpoints and retained transcript remain canonical.                                                                                                                 |
| Composition roots        | `packages/module-registry/src/meeting-capture-runtime.ts:53` and `recording-import-runtime.ts:32` pass the configured transcription port directly. No second Android preference store is needed.                                                                |
| AI boundary              | `packages/ai/src/configured-transcription.ts:49` accepts language/audio/route/dispatch, not vocabulary. `requireUsable` at line 67 requires active API-key OpenAI-compatible transcription configuration.                                                       |
| Wire request             | `packages/ai/src/adapters/http-api-transcription.ts:10` has no prompt input. `http-api.ts:195` builds model/file/language and segment timestamp fields; no vocabulary is sent.                                                                                  |
| Capability granularity   | `packages/module-sdk/src/ai-capabilities.ts:7` exposes broad `transcription`; `packages/shared/src/ai-types.ts:99` has a capability list but no transcription option metadata. No existing provider-neutral vocabulary capability was found in these contracts. |
| Other voice input        | `packages/ai/src/transcription-routes.ts:115` sends raw voice uploads through the HTTP adapter, independently of Meeting preferences. Keep that path and hold input outside this proposal.                                                                      |

Existing route pinning, configured-provider selection, credential use and dispatch
validation stay authoritative. Vocabulary must not choose a provider or bypass a
route change. Future support resolution must use the actor's actual selected route,
including pins and the legacy voice-endpoint path, rather than the instance's
dropdown selection alone.

## Provider evidence and limits

[Primary-source research](../../research/2026-10-24-transcription-vocabulary-provider-contracts.md)
records the exact contracts and pinned source references.

- Groq documents `prompt` for unfamiliar spellings/context on its Whisper models,
  a 224-token bound, matching audio/prompt language and segment timestamps.
- OpenAI Whisper has a similar prompt concept. Other transcription models differ
  in accepted options and response formats; prompt support alone does not prove
  compatibility with Moss's required timestamped response.
- faster-whisper's Python `initial_prompt`/`hotwords` are not an HTTP API. The
  inspected Speaches wrapper maps HTTP `prompt` to `initial_prompt`; a different
  local wrapper must be checked separately.
- No inspected contract supplies a general acknowledgement that vocabulary affected
  recognition. HTTP 200, accepting an unknown field, or seeing one glossary term
  in output cannot establish semantic support. Improvements remain probabilistic;
  unspoken-term insertion needs evaluation too.
- Tokens are not characters, bytes or term counts. A generic text-length cap does
  not establish a provider's token budget. Overflow behavior varies or is unstated.

> 🧠 **From Hindsight memory (Shared Meeting transcript language; Instance transcription provider selection)** — Shared language already reached live/import ASR and provider selection was instance-scoped. Current source above confirms these starting points.

A deeper memory lookup found no settled vocabulary
UI/limit/capability decision. A bounded search of `~/obsidian-vault/2 Areas/Moss`
found general Vocci/transcription notes but no vocabulary decision. Neither source
provides fresh design approval.

## Design fork

| Option                                                            | Strongest case                                                                                                        | Limitation and disposition                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always send optional standard `prompt`, following language        | Smallest extension through existing consumers; documented Groq/Whisper support; no new configuration surface.         | A configured compatible server may ignore it. Clear best-effort copy could make this an honest product, but it cannot offer an explicit supported/unavailable distinction. Viable only if Ben chooses that weaker promise. |
| Explicit selected-target support contract, then standard `prompt` | Preserves provider-neutral feature code and distinguishes unknown from supported without guessing from a vendor/name. | Needs AI-owned metadata, configuration/verification lifecycle and UI. **Recommended** for the requested supported capability; phase it before exposing a saved list.                                                       |
| Infer from URL/model name, or a successful probe                  | Little configuration and quick discovery for familiar targets.                                                        | Aliases, custom endpoints, model revisions and ignored fields invalidate the inference. Do not use as a support guarantee.                                                                                                 |
| Correct completed transcripts with another model                  | Could work when ASR lacks hints.                                                                                      | Changes evidence after recognition and introduces a different product workflow. Outside this slice.                                                                                                                        |

The recommended metadata is an ASR option contract owned by AI, not a new routing
capability or Meetings-specific provider registry. A declared contract must identify
the configured endpoint/model and verified timestamped-prompt behavior, budget
validator and language constraints. It becomes unknown when those inputs change.
An administrator's assertion is configuration, not measured accuracy; keep its
provenance distinct from executable transport proof and linguistic evaluation.
Default unknown must require no new deployment configuration and preserve today's
transcription when no vocabulary is requested. Exact storage/schema and legacy
endpoint coverage belong in the subsequent approved plan, not a guessed migration.

## Proposed experience for review

Keep Settings → Modules → Meetings, alongside Transcript language. No Android
screen or duplicate preference. Use the existing `Field`, `FormLabel`, `Button`
and status/error patterns. A multiline editor has no shared React primitive in
the inspected UI catalogue: establish one in `@moss/ui` before using it, following
the authored design system, rather than inventing module-local visual styling.

```text
Transcript vocabulary                       [existing settings section]
[Names and spellings, one per line                                  ]
[                                                                  ]
Sent with upcoming Meeting audio to your transcription provider.
Hints may help spelling; they do not guarantee a match.
[Save vocabulary]  [Clear vocabulary]
```

Proposed behavior, pending approval:

- Empty list means off; send no prompt. Explicit Save avoids writes on every
  keystroke. Clear saves an empty list. Save acknowledgements come from records.
- Treat entries as spellings, not free-form chat instructions. Trim surrounding
  space and remove exact duplicate entries, preserving case and order. Serialize
  deterministically; never add prior transcript, identities or unrelated context.
- Scope is the owner's future Meeting clips and normal imports, including future
  windows of an in-progress import, matching language's current timing. Do not
  rewrite retained text, restart failed imports, replay completed sources or send
  Meeting vocabulary with hold/raw chat voice input.
- Initial recommendation: one list, usable only with an explicit compatible
  transcript language. Automatic detection leaves vocabulary unavailable; show
  “Choose a transcript language to use vocabulary.” Multilingual lists/detection
  need separate design rather than assuming the prompt's language.
- Load/error/save/retry states preserve the draft. Unknown/unsupported target
  shows “Vocabulary isn't available with this transcription setup”; reject a
  nonempty save. Empty clears remain available even after a provider change.
- If saved terms exist and the target/language becomes incompatible, preserve
  them and show the unavailable state. Reject affected ASR requests before sending
  audio; do not silently drop terms or switch providers. Use existing failure
  semantics: live clips can become transcript gaps, and normal import attempts can
  fail terminally. Clearing the list or restoring support affects subsequent
  requests; it does not restart failed imports or fill earlier gaps. No resumable
  blocked state is proposed. Other users and empty-list transcription continue
  normally.
- Provider rejection uses the existing transcription failure path, with no retry
  that strips the hint. Show only safe failure codes; no private list/provider
  response in logs or job payloads. This is a proposed requirement, not a verified
  security claim about any deployed system.

Byte/entry caps are still a technical proof gate: select defensible UI bounds and
an exact selected-target budget validator before calling the implementation plan
ready. Validate the complete serialized hint, including separators. Never silently
truncate or equate a text cap to the documented token limit. If budget/language
support cannot be established for the first target, stop before exposing a setting.

Personal spellings are additional provider request content, possibly unrelated to
a particular clip. The form must explain that transmission. This research makes
no provider-retention, logging-confinement or recognition-quality guarantee.

## Decisions and delivery gate

Ben's concrete decision is whether to adopt this supported-contract design and
the proposed one-list/explicit-language/explicit-Save experience, including the
tradeoff that an incompatible later target rejects affected ASR requests: live
gaps and terminally failed normal imports are not repaired by clearing vocabulary
or restoring support. Those changes apply to subsequent requests. Alternative: choose
best-effort standard prompts, with that limitation explicit throughout the product.
This document's merge publishes research and a proposal; it does not approve either.

After a decision, record it, capture the initiative, complete the adapter budget
and language proof, then write/commit the repo plan-build implementation plan.
Do not begin product implementation from this draft alone.

Required future verification:

1. AI contract controls reject unknown/stale/unsupported routes and over-budget
   hints before fetch; empty defaults preserve existing behavior. Verify actual
   pin and legacy-endpoint resolution, not just instance selection.
2. Trace preferences through live clips, short imports and long windows to the
   actual multipart request; prove empty omission, hold/raw voice independence,
   per-window change timing and provider rejection without fallback.
3. Use actor-scoped preference integration and approval before/after coverage;
   any DB work requires verify-gate. Do not put list content in queue payloads.
4. Real isolated owner signup → Settings → save/reload/clear/failure/retry →
   normal recording pipeline, with actual UI and bounded textual assertions.
   Check phone width, dark/theme and keyboard behavior. A disclosed ASR stand-in
   proves Moss's wire contract only; actual supported-provider audio is separate.
5. Evaluate representative benign audio with/without relevant and unspoken terms.
   Record linguistic limits without demanding deterministic exact transcripts or
   treating a single matching term as proof. No production recording replay.
6. Update app-map behavior/errors/remediation in the product PR, independently
   review Standards/Spec at immutable head, pass static/appropriate runtime checks
   and required CI, then merge only with the applicable live-path proof.

Kill gate owner: the implementing agent. Missing product decision, missing
supported target/budget evidence, or failed real-path proof stops product release.
This docs-only feasibility slice needs formatting, file-size, no-dev-password,
diff checks and independent review/required CI; it makes no runtime claim.
