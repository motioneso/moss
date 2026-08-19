# Fable adversarial review — #926 Food tracking and nutrition estimates spec

**Date:** 2026-08-18
**Reviewer:** Claude Fable 5, independent adversarial spec review (read-only, pre-build)
**Spec:** `docs/superpowers/specs/2026-08-18-926-food-nutrition-tracking.md`
**Grounded on:** `a66aeacb5` (this branch, clean tree)
**Method:** every claimed reuse seam verified against the repository (module platform, Wellness,
Chat attachments/voice/vision, AI structured/routing/consent, jobs, RLS, export, timezone),
file-by-file, with five parallel repository sweeps plus direct spot-checks of each load-bearing
claim.

## Verdict

**APPROVE WITH REQUIRED CHANGES** — confidence 90%.

The spec's shape is right: a first-party optional module modeled on Wellness, owner-only forced
RLS, manifest-declared tools behind the Gateway's confirmation policy, structured AI estimation,
metadata-only jobs, honest uncertainty, and disciplined out-of-scope boundaries. Most claimed
seams are real and were verified present (inventory at the end). Three claims, however, name
machinery that does not exist — one of them (the Wellness "symptom") is a false premise the
cross-module feature is built on — and several smaller claims need wording that matches what the
repo actually provides. None require re-scoping; all are correctable in the spec text.

Build may start once the three blocking corrections (B1–B3) are folded into the spec.

## Blocking findings (required changes)

### B1. "Already-recorded symptom" names a Wellness record type that does not exist

The cross-module stories (29–32) and decisions rest on Wellness holding "symptom/check-in
timestamps" with a "bounded symptom label". Wellness owns exactly four tables
(`packages/wellness/src/manifest.ts:56-61`): check-ins, medications, medication logs, therapy
notes. A repo-wide search finds **no symptom concept anywhere**. A check-in
(`packages/wellness/sql/0082_wellness_checkins.sql`, `packages/shared/src/wellness-api.ts:29-43`)
carries `checked_in_at`, a core-emotion enum (happy/sad/fear/anger/disgust/surprise, migration
0088), free-string `sensations[]`, intensity/energy, and a note. The Wellness build plan
explicitly listed symptom journaling as out of scope
(`docs/superpowers/plans/2026-06-13-p5-wellness-module.md`). "I felt sick" maps at best to a
check-in whose sensations include something like "nauseous" — a fuzzy match over free strings,
not a symptom record.

**Smallest correction:** define the term in the spec. E.g. replace the port description with:
"For 'before I felt sick,' Wellness may expose a narrow, consent-aware port returning owner-scoped
**check-in** timestamps with a bounded label derived from the check-in's existing feeling and
sensation fields. Food adds no new Wellness record type; 'symptom' in user-facing copy means a
Wellness check-in the user already recorded." Update stories 29–32 and the cross-module tests to
say check-in. If Ben wants a true symptom record, that is a separate Wellness spec first.

### B2. Photo estimation's "existing" seams do not exist: the structured path is text-only and the vision capability is unrouted

Two claims — "uses the existing vision-capable attachment-read boundary" and "the existing
configured structured-AI/model-resolution path to produce a schema-validated nutrition estimate"
— are each individually grounded, but their intersection (schema-validated estimate **from a
photo**) has no existing seam:

- `generateStructured()` (`packages/ai/src/structured/generate-structured.ts:135`) and every
  structured adapter (`packages/ai/src/adapters/http-api-structured.ts:10,100,120,136`) carry
  `content: string` turns only. No adapter can send an image.
- The `vision` capability exists in the enum (`packages/module-sdk/src/ai-capabilities.ts`,
  `packages/shared/src/ai-api.ts:37`) and models are tagged with it
  (`packages/ai/src/model-discovery.ts:249`), but **no call site in the repository ever resolves a
  model with `capability: "vision"`**.
- The only path by which a model sees an image today is the chat engine's MCP lane: the
  `chat.readAttachment` tool returns `media: {kind:"image", base64}`
  (`packages/chat/src/attachment-tool.ts:29-33`, `packages/chat/src/mcp-transport.ts:196`). The
  module-facing attachment port is text-only and returns null for images by contract
  (`packages/module-sdk/src/worker.ts:127-133`).

**Smallest correction:** stop calling it reuse. Add to Implementation Decisions: "Photo
estimation requires extending the structured-AI path with image input: image content blocks in
the structured provider adapters, model resolution with the existing `vision` capability, and an
owner-scoped Vault image read for the estimator. The capability enum, model tagging, Vault
authorization, and schema-validation/repair loop are reused; the image plumbing is new and
in-scope for this feature." (Alternative — routing photos through a chat-engine turn — couples
the Food command path to the chat engine and should be rejected.)

### B3. Attachment "release on purge" and "retain-or-purge" name lifecycle machinery that does not exist

- Chat attachments have **no delete operation and no reference concept**: upload → optional
  `markSent` → read. The only deletion is a lazy sweep of _unsent_ uploads older than 24 h
  (`packages/chat/src/attachments-service.ts:273-297`); a sent attachment lives in the actor's
  vault until account deletion. "Releases Food-owned attachment references through the existing
  attachment lifecycle" therefore describes nothing that exists.
- First-party modules have no retain-or-purge choice. Disable is a deny row in
  `app.module_enablement` (`packages/settings/sql/0065_module_enablement.sql`,
  `packages/settings/src/repository.ts:267`) that touches no data, and
  `ModuleDeletionDecl.strategy` is `"cascade"`-only with purge explicitly deferred
  (`packages/module-sdk/src/index.ts:681-684`). The retain/purge choice the spec echoes exists
  only on the **external** module platform (`packages/settings/src/routes-module-registry.ts:168`),
  which a first-party Food module does not use.

**Smallest correction:** state the real model in story 37 and the lifecycle decision: "Disabling
Food hides its surfaces and tools and retains data (the platform's deny-row model). Food-owned
rows are removed by the account-deletion cascade via `dataLifecycle.deletion.tables`, and Food
declares `exportSections` like Wellness. Meal photos follow the existing chat-attachment vault
lifecycle (deleted with the account's vault)." If a user-initiated Food purge or per-photo
deletion is wanted, name it as new machinery — a deliberate delete operation on the attachments
service or a Food-owned purge command — and keep it small.

## Medium findings (required wording, no design change)

### M1. "Wellness AI consent" is a one-off preference key — and it is effectively default-on

There is no reusable per-module AI-consent mechanism: Wellness's is a bespoke preference key
`wellness.ai_consent_granted` with hand-wired per-tool gates
(`packages/wellness/src/ai-consent.ts:5-36`, `packages/wellness/src/tools.ts:20,56`). Its
tri-state default _inherits Wellness-active_, and the tool path passes
`fallbackWellnessActive: true`, so with no explicit choice Wellness AI access is **on**. The
spec's "explicit, user-scoped Food AI-processing consent" is therefore a deliberate divergence
from the only precedent, not reuse. Correction: say Food copies the Wellness pattern (a
`food.ai_consent_granted` preference plus per-tool and per-command gates Food wires itself) but
defaults to **off** until explicitly granted, and that the Wellness port implementation enforces
Wellness's own consent inside Wellness code — Food never reads the Wellness consent key.

### M2. Capture kind `voice` is not derivable for Chat-originated logs

Voice input is real and matches the spec's audio-transient claim (`MediaRecorder` →
`POST /api/ai/transcriptions`; raw audio never persisted/logged, only `{text}` returns —
`packages/ai/src/transcription-routes.ts:41-108`). But the transcript is inserted into the chat
composer's text field and sent as an ordinary typed turn (`apps/web/src/chat/composer.tsx:288-302`)
— the tool layer cannot distinguish dictated from typed text. Correction: capture kind `voice`
applies only to Food-page dictation (where Food's own control can tag it); a chat-dictated log
records `text`. Adjust story 6/7 wording and the tests accordingly.

### M3. The export seam needs a hand-wired call site, and metadata-only payloads need an allowlist entry

`dataLifecycle.exportSections` is real (`packages/module-sdk/src/index.ts:659-679`; Wellness
exemplar `packages/wellness/src/manifest.ts:258-272`), but the archive assembler is still
hand-assembled per module (`packages/settings/src/data-export.ts:87-125`) — Food needs an explicit
wiring entry in `@moss/settings`, which the boot assertion
(`packages/module-registry/src/index.ts:2010-2040`) will not add for you. Likewise the estimation
job's payload keys (e.g. `mealId`, `estimateRevision`) must be added to `ALLOWED_PAYLOAD_KEYS` in
`packages/jobs/src/pg-boss.ts:77` or `assertMetadataOnlyPayload` rejects the send. One sentence
acknowledging both wiring points prevents a mid-build surprise.

### M4. The live acceptance run's voice leg is blocked on insecure dev origins

`navigator.mediaDevices` is undefined outside a secure context, and the composer fails closed on
that (`apps/web/src/chat/composer.tsx:296-302`); dev instances served over plain HTTP on the LAN
cannot exercise the mic (known issue #1402/#1403, same secure-context class as weather/PWA).
Correction: the live run should prove the voice leg by exercising `POST /api/ai/transcriptions`
directly (or run on a secure-context instance) and say so, rather than leaving an untestable
step in the acceptance script.

### M5. "Creating and retrying a meal is idempotent" is underspecified

State the mechanism: the create command accepts a client-supplied idempotency key (both the Food
page and the assistant tool supply one), and "retry" means re-running estimation for an existing
meal id at a new estimate revision — never re-creating the meal. Without that sentence, a
Gateway tool retry after a timeout is a double-logged dinner. The revision guard against stale
async overwrites is already well specified.

## Low findings / advisory

- **L1 — Name the port pattern.** The "declared module boundary" should follow the existing
  provider-interface convention: interface in `@moss/module-sdk` (`scopedDb: unknown`),
  implemented and exported by `@moss/wellness`, wired at the composition root
  (`packages/module-registry/src/index.ts`) — exactly like `CommitmentExtractionProvider`
  (`packages/module-sdk/src/index.ts:723`, `packages/notes/src/commitment-provider.ts`) and
  Wellness's own `FocusSignalProvider`. This avoids a `food → wellness` package edge entirely;
  note `tests/unit/module-dependency-allowlist.test.ts` pins feature→feature edges at zero for
  Wellness, so a direct dependency would need allowlist justification the DI pattern makes
  unnecessary.
- **L2 — Timezone claims are solid; cite the conventions.** Stored per-user timezone exists
  (`/api/me/locale`, `packages/settings/src/locale-routes.ts:16-53`), the browser sends
  `X-Timezone` per request, and precedence is header → stored → UTC
  (`packages/shared/src/time.ts:34-40`), with `localDay()` as the only sanctioned instant→date
  conversion (enforced by `scripts/check-no-ambient-dates.ts`). `timestamptz` is the standard
  representation. Wellness additionally denormalizes `local_date`/`timezone_offset` (migration 0107) — Food should decide (one line) whether to copy that denormalization for its
  calendar queries or derive at read time; either is defensible.
- **L3 — Prompt/log hygiene has no global guard.** There is no pino `redact:` config or lint
  rule keeping prompts out of logs — only convention plus the job-payload allowlist. The spec's
  data-handling tests are therefore the actual enforcement for Food; keep them as written.
- **L4 — Chat dependency is safe.** Reusing `POST /api/chat/attachments` from the Food page has
  direct precedent (job-search resume upload) and Chat is `lifecycle: "required"`
  (`packages/chat/src/manifest.ts:28-34`), so Food cannot be enabled without its upload seam.
- **L5 — No unnecessary architecture found.** The estimate-state machine
  (`pending/needs_details/estimated/failed`), revision counter, and single shared create command
  are each load-bearing (async races, honest failure, Chat/page parity). The out-of-scope list
  is disciplined and matches issue #926's ask. Nothing to remove; resist adding a generic
  consent framework or attachment refcounting while fixing B3/M1 — the smallest thing that
  satisfies the invariants is per-module wiring, as Wellness did.

## Verified reuse inventory (claims that hold as written)

- Module manifest/nav/settings/routes/permissions/jobs/tools contracts: `MossModuleManifest`
  (`packages/module-sdk/src/index.ts:581`), Wellness as the reference implementation, registered
  in `BUILT_IN_MODULES` (`packages/module-registry/src/index.ts:1611`).
- Per-user optional enablement (deny-row model), nav/settings surfacing, module-gated routes.
- Gateway policy: `risk: "destructive"` always confirms (`packages/ai/src/gateway/policy.ts:36`);
  install-granted self-operation (`granted_at_install`,
  `packages/ai/src/gateway/self-operation.ts:478-492`); disabled module's tools vanish from the
  gateway (`packages/ai/src/gateway/gateway.ts:729-772`).
- Structured AI for text: `generateStructured` with Ajv validation and bounded repair retries,
  per-module service key resolution (`module.<id>`), provider-agnostic adapters including the
  CLI structured adapter.
- Durable jobs: metadata-only payload assertion, singleton/idempotency helpers, worker re-entry
  into RLS context via `registerDataContextWorker`; the commitments extraction job is the
  copy-ready template (`packages/commitments/src/jobs.ts`, `workers.ts`).
- Owner-only forced RLS exemplar to copy verbatim: `packages/sports/sql/0133_sports_follows.sql`
  / `packages/wellness/sql/0082_wellness_checkins.sql:34-60`, actor via `set_config` inside
  `withDataContext`; module SQL in the owning package's `sql/` run by `scripts/migrate.ts`.
- Voice transcription server contract (audio transient, `{text}` only) and per-user export
  (sync + async routes) both exist.
- Attachment upload from a non-Chat page (job-search precedent), Vault-rooted per-actor
  authorization by construction, image types first-class with magic-byte sniffing.
- Native `<input type="date">` is the established date-control pattern
  (`apps/web/src/tasks/task-details-dialog.tsx:382`), with calendar primitives (`day-cell`,
  `month-chip`) available if the day view wants them; no charting needed, matching the spec.

## Testing notes

The testing decisions are strong — external-behavior seams, deterministic estimator fixtures,
two-actor privacy proofs, timezone edges without server-tz dependence (supported by
`check-no-ambient-dates`), and log/payload leak checks. Beyond M2 (voice capture-kind assertions)
and M4 (voice leg on live dev), one addition: the cross-module tests should include the
**default-consent** case — Wellness AI consent unset (which today resolves ON via the
active-inheritance fallback) while Food consent is unset (OFF per M1) — proving Food's estimator
stays gated even when the Wellness port would answer.
