# Food tracking and nutrition estimates (#926)

**Status:** APPROVED by Ben 2026-08-18; revised 2026-08-18 under the product-owner distribution
ruling (see Module distribution model)  
**Issue:** #926  
**Primary verification seam:** install Food, log food through Chat or the Food page, inspect the
dated estimate, then query the same history through Moss

## Problem Statement

Moss users cannot currently keep a lightweight record of what they ate, see basic nutrition
estimates, or ask useful questions about that history. That makes it harder to notice eating patterns,
understand approximate calories and nutrients, or recall what preceded a Wellness check-in where
they recorded feeling sick.

The feature must stay honest about uncertainty. A description, voice transcript, or meal photo cannot
produce measured nutrition or establish that a food caused someone to feel sick. Moss should provide useful
estimates and chronological context without presenting either as medical fact.

## Module distribution model (product-owner ruling, 2026-08-18)

Every Moss-authored first-party module is **distributable and not installed by default**, and
distributable modules may also be third-party. Food is the first module specified under this model:
it ships as a distributable module package that a user (or instance owner) installs and then
enables, exactly as a third-party module would. Food must not assume compiled-in, always-installed
status anywhere in its manifest, lifecycle, or tests.

The purpose of this ruling is bigger than Food: it sets the ground rules for module development
generally. As Moss grows, users should be able to create their own modules without modifying the
core platform. Food is therefore the exemplar: it must be buildable using only the public module
platform contracts an outside author would have. Anywhere Food would need a privileged seam, a core
edit, or first-party-only access is by definition a platform gap — evidence for a blocker issue,
not a license for Food to be special.

Repository verification (2026-08-18) found the platform mechanics **largely already exist** on the
downloaded-module track: registry publish (`scripts/publish-module-registry.ts`), download → verify
→ stage pipeline, the four-phase privileged installer, fail-closed discovered→enabled status,
per-user disable with data retained, and structural account-deletion coverage derived from
`database.ownedTables`. Food therefore ships as a Moss-authored package on that existing track
(the `bundled` vs `downloaded` axis of #1312), and this spec does not respecify distribution. Only
the genuinely missing contracts are blockers, listed below with their filed issues.

## Planning Constraint (binding)

**#926 and its implementation plan contain only Food module-package work.** That means the Food
package itself: its manifest and lifecycle declarations, its owned SQL/migrations, application
services, repositories, UI, assistant tools, export/deletion declarations, and tests.

- Any generic core-platform capability that Food needs and that does not already exist is **not**
  #926 work. It becomes a **separate issue with its own approved spec**, and that issue **blocks
  #926**. The Food plan consumes the declared contract; it never carries the core implementation.
- This applies to capabilities already known missing (the Platform Blockers below) and to any
  further gap discovered during planning or build. Discovering a new gap mid-build pauses the
  affected Food work and files a blocker; it does not license a core edit inside the Food plan.
- Edits to core packages (`packages/ai`, `packages/jobs`, `packages/settings`,
  `packages/module-sdk`, `packages/module-registry`, `packages/wellness`, the web shell, the
  composition root) are out of scope for the Food plan, with one narrow exception: the small
  registration/wiring line a module contract explicitly requires every consumer to add, where the
  blocker's spec has already defined that seam. Even that exception is a smell under the
  third-party goal — a true outside author cannot edit core at all — so blocker specs (especially
  #1694) should prefer declaration-driven registration over per-module core wiring wherever
  practical.

## Platform Blockers (separate issues, verified missing 2026-08-18)

Blockers are scoped to the Food feature path they gate so text/history work is never serialized
behind photo or correlation work.

**Blocks all of #926:**

- **#1694 — Downloaded-module data export.** The JSON manifest ABI has no export declaration and
  `readExternalModuleExportRows` exists but is unwired, so a downloaded module's data never reaches
  the user's archive (deletion coverage, by contrast, is already structural and working). Food
  requires: its owned-table data in the owner's export with declarable sensitivity copy, assembled
  declaration-driven rather than by per-module hand-wiring in core Settings.

**Blocks only photo estimation (stories 5, photo parts of 15/23; text/voice logging, history, and
the Food page proceed without these):**

- **#1695 — Public module attachment contract.** Modules today have only `attachments.readText`
  (text extraction, null for images); there is no upload contract and no authorized binary/image
  read. Food requires: platform-level upload from the Food page and owner-scoped bytes+mimeType
  read for estimation, with Chat's existing Vault-backed behavior unchanged underneath — a declared
  contract, not a private Chat dependency.
- **#1696 — Structured-AI image input.** Moss already sends images to models inside Chat (the
  attachment tool's image content block); the structured path is text-only and no call site resolves
  the existing `vision` capability. Food requires: the structured contract accepts an authorized
  image alongside the prompt, resolves the user's vision-capable model by capability, keeps the
  schema-validation/repair contract, and is exposed through the module structured-AI RPC with its
  existing guards.

**Blocks only Food-page write interactions (page logging, correction, and deletion in stories
1/18/19/20; Chat-based logging/correction/deletion, the page's read/calendar/summary views, and the
durable estimation job proceed without this):**

- **#1699 — Module page write path.** A downloaded module's page can read (the REST tool-invoke
  route executes read tools) but cannot execute a write: the invoke route 403s any tool with
  `risk !== "read"` at the confirmation floor by design, and the manual queue-run endpoint is
  async-only with a 5-second per-actor singleton and no result channel back to the browser. Food
  requires: a contract letting a module's own page execute the module's reversible write tools
  under the install-granted self-operation policy with a synchronous result, and a defined
  page-originated confirmation flow for destructive tools (delete) — so the Food page and Chat can
  call the same module-owned commands with visible boundary validation.

**Blocks only the Wellness-correlation feature (stories 29–32):**

- **#1697 — Wellness check-in context port.** No check-in/symptom port exists, and every current
  provider port is a function-valued compiled-manifest field a downloaded module cannot consume.
  Food requires: an SDK-declared port returning owner-scoped check-in timestamps plus a bounded
  label from existing feeling/sensation fields, implemented by Wellness (which enforces its own
  enabled state and AI-read consent internally), wired at the composition root, and reachable from
  a downloaded module's execution context.

**Retired — verified already covered:**

- *Job payload allowlist keys* (formerly P4): the closed metadata-only allowlist already carries
  generic keys (`actorUserId`, `resourceId`, `idempotencyKey`, `kind`, `version`) that cover Food's
  estimation payload with zero additions. If planning still finds a missing key, or estimation
  stays synchronous, no core work exists here; only a genuinely new key would trigger a blocker.
- *Distribution/install/not-installed-by-default*: exists end-to-end on the downloaded track (see
  Module distribution model above). #1312 (bundled/downloaded rename) is a linked vocabulary
  prerequisite, not a blocker.

Blockers gate stages, not everything at once: planning for a Food feature path starts when its
blockers' contracts are approved; Food-package build may proceed against an approved contract
(e.g. authoring the manifest export declaration #1694 defines); but a path passes the live-path
gate and its stories count Done only when every core capability it consumes is merged and proven
live. Unblocked paths may proceed end to end.

## Solution

Add Food as a distributable module alongside Wellness, installed and enabled by the user. Once
enabled, a user can log a meal from the Food page or by telling Moss in Chat, using text, a photo,
or voice through the capture capabilities Moss already supports. The user may log during a meal,
immediately afterward, or for an earlier date and time.

The Food page provides a simple calendar/date view. Each day shows its meals, their estimated
nutrition, and estimated daily totals. The user can correct the meal description, consumed time, and
nutrition estimate or delete the record. Estimates remain clearly labeled and expose uncertainty
when the input is incomplete; Moss asks for clarification instead of inventing portions.

Food owns its records and reporting. Moss can answer bounded natural-language questions such as
“What did I eat this week?” and “How much protein did I average?” When Wellness is enabled, has an
already-recorded check-in, and the user has allowed the relevant AI access, Wellness may provide the
check-in time through the declared check-in context port (#1697). Food can then return meals
that preceded it. Moss describes chronology only and never claims causation or diagnosis.

## User Stories

1. As a Moss user, I want Food absent until I install it and to install and enable it independently,
   so that I opt into food tracking without changing unrelated modules.
2. As a user, I want Food reachable from the main navigation alongside Wellness once installed and
   enabled, so that I can find it where I expect while it remains a separate module. (Navigation
   placement only — downloaded modules cannot contribute panes to core Settings, and Food does not
   need to.)
3. As a user, I want to type what I ate on the Food page, so that logging a meal is quick.
4. As a user, I want to tell Moss in Chat what I ate, so that I can log food without navigating away.
5. As a user, I want to attach a meal photo from Food or Chat, so that Moss can estimate a meal when a
   description would be tedious.
6. As a user, I want to dictate a meal using Moss's existing voice input on Food or in Chat, so that I
   can log hands-free.
7. As a user, I want dictation to preserve its transcript rather than raw audio, so that it follows
   Moss's existing voice-data behavior; Chat-originated dictation may appear as text because Chat
   does not retain how composer text was entered.
8. As a user, I want a meal to default to the current time in my timezone, so that common logging is
   fast and dates are correct.
9. As a user, I want to specify or correct an earlier consumed time, so that delayed logging produces
   accurate history.
10. As a user, I want Moss to distinguish when I ate from when I created the record, so that late
    entries are not placed on the wrong day.
11. As a user, I want a saved meal to include my recognizable description, so that I know what the
    nutrition estimate refers to.
12. As a user, I want approximate calories, protein, carbohydrates, fat, fiber, sugar, and sodium for
    each meal, so that I get useful basic nutrition context.
13. As a user, I want nutrition values labeled as estimates, so that I do not mistake model output for
    measured facts.
14. As a user, I want Moss to identify missing portion or ingredient details, so that I understand why
    an estimate is uncertain.
15. As a user, I want Moss to ask a short clarifying question when a photo or description is too
    ambiguous, so that it does not invent a confident portion size.
16. As a user, I want to save the meal even when estimation needs details or fails, so that the food
    history is not lost.
17. As a user, I want a pending or failed estimate shown honestly with a retry action, so that a
    provider failure does not look like zero nutrition.
18. As a user, I want to correct the description, consumed time, serving details, or estimated values,
    so that my history can become more accurate.
19. As a user, I want corrections to update the daily totals, so that summaries agree with meal rows.
20. As a user, I want to delete a food record with confirmation, so that accidental or private entries
    can be removed.
21. As a user, I want a simple calendar or date selector, so that I can move through food history.
22. As a user, I want each selected day to show meals in consumed-time order, so that the record reads
    like a daily timeline.
23. As a user, I want each meal row to show time, description, capture source, estimate status, and
    nutrition breakdown, so that I can understand the record at a glance.
24. As a user, I want estimated daily totals for the selected date, so that I can understand the day's
    basic nutrition without adding values myself.
25. As a user, I want incomplete estimates excluded from numeric totals and disclosed, so that missing
    information is not silently treated as zero.
26. As a user, I want to ask what I ate over a date range, so that Moss can summarize my history in
    natural language.
27. As a user, I want to ask for average or total nutrition over a date range, so that I can inspect
    patterns such as average protein.
28. As a user, I want natural-language answers calculated from my structured food records, so that the
    answer matches the Food page rather than relying on conversational memory.
29. As a Wellness user with a check-in where I recorded feeling sick, I want to ask what I ate before
    it, so that I can inspect chronological context.
30. As a Wellness user, I want Moss to use only existing check-in feelings or sensations, so that it
    does not infer that I was sick from unrelated conversation or invent a new symptom record.
31. As a user, I want a check-in-context answer to state the check-in time and preceding meals without
    claiming a cause, so that Moss does not give unsafe medical conclusions.
32. As a user without Wellness enabled, a matching check-in, or required consent, I want Moss to explain
    what is missing, so that it does not fabricate a correlation.
33. As a user, I want my food records and meal photos private to my account, so that another user or an
    administrator cannot inspect this health-adjacent data.
34. As a user, I want explicit notice and consent before a configured AI provider processes my meal
    text or photo, so that estimation is not an invisible disclosure.
35. As a user, I want my configured provider and model routing honored for text, vision, and voice, so
    that Food does not bypass my AI settings.
36. As a user, I want food data included in my own export and removed through Food's deletion
    lifecycle, so that I retain control of it.
37. As a user who disables Food, I want its surfaces and tools hidden while its records are retained,
    and I want account deletion to remove them, so that lifecycle behavior is predictable.
38. As a user, I want Food history unavailable to unrelated modules and tools, so that enabling Food
    does not create broad health-data access.

## Implementation Decisions

All decisions below describe work inside the Food module package unless they explicitly name a
blocker contract Food consumes.

- Build Food as a Moss-authored module on the existing downloaded-module track, using the declared
  JSON manifest, navigation, web-entrypoint, tool, queue, permission, and lifecycle contracts.
  Place Food alongside Wellness in main navigation once installed. Keep Food-owned preferences and
  consent on the Food page; do not require a core Settings pane or speculative grouping field.
- Food owns its data, application services, UI, assistant tools, export declarations, and deletion
  declarations. Wellness must not import Food internals or read Food tables, and Food must not
  import Wellness internals or read Wellness tables. Food's only Wellness contact is the check-in
  context port contract (#1697).
- Add Food-owned, owner-scoped storage for meals and their nutrition estimates, with migrations in
  Food's own module SQL. A meal stores the consumed timestamp, separately records creation/update
  timestamps, preserves a bounded original description, records capture kind (`text`, `photo`, or
  `voice`), and has an explicit estimate state. `voice` is recorded only when the Food-page control
  can supply that provenance; Chat dictation arrives through the existing composer as `text`.
- Store the normalized estimate with the meal for calories, protein, carbohydrates, fat, fiber,
  sugar, and sodium using one canonical unit per nutrient. Store estimator/model provenance,
  estimate revision, and bounded uncertainty or missing-detail notes. Unknown, pending, and failed
  values are nullable—not zero.
- Treat the user's timezone as the boundary for calendar dates, daily totals, and natural-language
  date ranges. Following Wellness's established pattern, persist the consumed instant plus the
  intended local date and timezone offset at creation or correction so later timezone changes do not
  move a historical meal to another day. Use the shared timezone precedence and local-day helpers.
- Use the required Chat module's existing attachment upload and the existing voice-transcription
  contract. Food depends on stable platform contracts or injected ports, not Chat implementation
  files. Raw voice audio remains transient under the existing voice contract.
- Meal photos remain in the existing private attachment/Vault lifecycle. Food stores only the
  authorized attachment reference needed to estimate or display the meal; it does not copy image
  bytes into Food tables, logs, metrics, or job payloads.
- Text estimation uses the configured structured-AI/model-resolution path as it exists today. Photo
  estimation consumes the image-capable structured contract delivered by #1696 and the attachment
  upload/binary-read contract delivered by #1695; Food-package
  work is limited to invoking that contract with an authorized attachment reference and handling
  its results. Do not route Food-page photos through a synthetic Chat turn, and do not extend the
  AI package inside the Food plan.
- Do not add a nutrition database, barcode catalog, new provider, or bespoke estimation framework
  for this MVP.
- Text and voice inputs are normalized to bounded meal descriptions. The estimator must return
  either a valid structured estimate, a needs-details result with a bounded clarification question, or a failure;
  it may not fill missing portions with undisclosed certainty.
- Saving the meal and estimating it are separate outcomes. Persist a valid meal first. Estimation may
  complete in the request when practical or through the existing durable job path, but the visible
  contract is the same: `pending`, `needs_details`, `estimated`, or `failed`, with idempotent retry.
- If estimation uses a durable job, its payload contains only actor id, meal id, estimate revision,
  and idempotency metadata, using the existing generic allowlist keys (`actorUserId`, `resourceId`,
  `idempotencyKey`, `version`, `kind`) so no core allowlist edit is needed. Workers
  load private inputs under the actor context. Descriptions, nutrition, photo bytes, and
  transcripts never enter queue payloads.
- Direct Food-page logging and Chat logging call the same Food application command. The Food module
  exposes module-owned assistant tools for creating, listing/summarizing, updating, and deleting
  meals; Chat does not write Food tables directly. Page reads use the existing read-tool invoke
  route; page writes use the module page write path from #1699.
- Assistant tool execution uses the Gateway's active actor and permission policy. Reversible meal
  creation and correction may use the module's install-granted self-operation policy. Deletion is a
  destructive action and requires the existing confirmation flow.
- The create command accepts description and/or an authorized image attachment plus an optional
  consumed time and serving clarification. It rejects empty input, unauthorized attachments,
  unsupported media, invalid dates, unknown fields, and oversized text at the boundary.
- The create command requires a client-supplied idempotency key from both the Food page and assistant
  tool so a timed-out retry cannot duplicate a meal. Estimation retry targets an existing meal id and
  creates a new estimate revision; it never re-runs meal creation. Revision guards prevent stale
  asynchronous results from overwriting a newer correction.
- The Food page uses the existing shell and responsive primitives with a native date input or the
  simplest existing date control. It shows a date selector, estimated daily totals, and meal rows;
  it does not add charts, goals, streaks, scoring, or gamification.
- Daily totals sum only available estimates and are always labeled estimated. If any meal lacks a
  completed estimate, the response and UI disclose that totals are incomplete.
- Food exposes bounded read operations for meals and aggregate nutrition over an authorized date
  range. Moss answers historical questions from these structured results rather than unrestricted
  SQL, raw attachments, or chat-memory guesses.
- For “before I felt sick,” Food consumes the Wellness check-in context port (#1697). Food
  adds no symptom record and has no direct Wellness dependency; the port's interface, Wellness-side
  implementation, and composition wiring are the blocker's deliverable, not Food-plan work. The
  default preceding window is 24 hours unless the user asks for another range.
- Check-in-context answers use chronological language such as “you logged these meals before the
  check-in.” Prompts, tool descriptions, and UI must not say a food caused, triggered, diagnosed, or
  treated a symptom.
- AI estimation uses a Food-owned consent preference and Food-owned per-command/tool gates following
  the Wellness pattern, but defaults off until the user explicitly grants it because meal
  descriptions and photos are health-adjacent private data. The consent toggle lives on the Food
  page (a module-owned surface), not in core Settings. Wellness consent does not grant Food
  access. Wellness itself enforces its own enabled state and AI-read consent inside the provider port;
  Food never reads the Wellness preference key.
- Food tables use forced owner-scoped RLS with no administrator private-data bypass. Service and tool
  access must carry the active actor; caller-supplied owner ids are not trusted.
- Logs and metrics contain only bounded identifiers, capture kind, estimate state/revision, duration,
  nutrient-field presence, and error class. They exclude descriptions, transcripts, photos, nutrient
  values, check-in labels, and AI prompt/response bodies.
- Food declares export sections and account-deletion cascade tables in its own manifest; the
  export contract from #1694 assembles them declaration-driven. Export copy warns that food history is
  sensitive. Disabling Food hides its surfaces and tools while data is retained. Account deletion
  removes Food-owned rows; meal photos follow the existing Chat-attachment Vault lifecycle and are
  deleted with the account's Vault. A separate Food purge or per-photo delete operation is not
  added in this slice.

## Testing Decisions

- The primary acceptance test exercises external behavior through both supported entry points,
  starting from the module's real install path: install and enable Food, log food through Chat or
  the Food page, observe the dated meal and estimate on Food, query the same history through Moss,
  and optionally query preceding meals for an already-recorded Wellness check-in. Assert public
  responses and rendered behavior, not prompts or private helper calls.
- Run the primary contract with a typed breakfast, photographed lunch, and voice-transcribed dinner.
  Verify consumed dates in the actor's timezone, meal estimates, estimated daily totals, and matching
  historical answers.
- Lifecycle tests prove Food is absent before install, appears after install and enable, and that
  disable hides surfaces and tools while retaining data — all through the platform contract, not
  test-only shortcuts.
- Module/API integration tests cover text, authorized image, and voice-transcript creation; explicit
  historical timestamps; validation; idempotent retries; estimate state transitions; corrections;
  stale-revision rejection; deletion confirmation; and incomplete totals.
- Estimator contract tests use deterministic structured-provider fixtures for a complete estimate, an
  ambiguous portion requiring clarification, invalid structured output, unsupported vision, provider
  failure, and a successful retry. Tests assert state and schema, not model prose. Image-path
  fixtures exercise the #1696 contract from the consumer side only.
- UI tests cover enablement, empty state, date navigation, direct text/photo/voice entry, ordered meal
  rows, estimate/uncertainty labels, incomplete and failed states, retry, edit, delete confirmation,
  daily totals, keyboard behavior, and narrow-width layout.
- Assistant-tool tests prove Chat and Food use the same command/query behavior, permissions use the
  active actor, historical questions return structured records, and destructive deletion follows
  confirmation policy.
- Timezone tests cover a meal near midnight, daylight-saving transitions, late entry, day totals,
  range endpoints, and average calculations without depending on the server timezone.
- Cross-module tests prove Wellness shares only an authorized check-in timestamp and bounded label
  through the #1697 port, Food returns the configured preceding window, missing module/data/consent
  produces an honest explanation, and the answer never claims causation. Include Wellness consent
  unset with Wellness active while Food consent is unset, proving Food estimation remains off
  independently.
- Privacy tests use two actors and prove neither normal nor administrator context can read, mutate,
  export, or attach another user's Food data. Tests also prove Food cannot read Wellness tables and
  Wellness cannot read Food tables directly.
- Data-handling tests prove raw photos/audio, meal text, nutrient values, and check-in labels do not
  appear in logs or job payloads; AI routing and explicit Food consent are honored; disable retains
  Food data, and account deletion removes Food rows and the account Vault.
- The live acceptance run installs Food through the real install path, then logs typed, photographed,
  and dictated meals, corrects one estimate, checks daily totals, asks “What did I eat this week?”
  and “How much protein did I average?”, records a Wellness check-in, asks what preceded it, and
  verifies chronological/non-medical wording at desktop and narrow widths. Exercise microphone
  capture on a secure-context instance; otherwise verify the existing transcription endpoint
  directly and use its returned text in the Food-page flow.

## Out of Scope

- Core-platform implementation of any blocker capability: the export wiring (#1694), the module
  attachment contract (#1695), structured-AI image plumbing (#1696), the Wellness port's
  interface/implementation/wiring (#1697), and the module page write path (#1699) are delivered by
  their own issues, never inside #926.
- Diagnosing food reactions, allergies, intolerances, illness, or any causal relationship between a
  meal and a Wellness check-in.
- Medical advice, emergency guidance, treatment recommendations, or clinician workflows.
- Calorie or macro targets, diet plans, weight-loss programs, coaching, scores, streaks, or alerts.
- Barcode scanning, packaged-food databases, restaurant menus, lab-grade nutrition calculation, or a
  guarantee that estimates match measured values.
- Recipes, grocery lists, pantry management, meal planning, or automatic meal recommendations.
- Wearables, fitness trackers, health-platform synchronization, or other external integrations.
- Automatic illness detection from Chat or automatic creation of Wellness records from Food.
- Population analytics, cross-user learning, social sharing, or administrator access to private food
  history.
- Charts and a full nutrition-analysis application beyond the calendar/day list, meal estimates,
  daily totals, and bounded natural-language reports.

## Further Notes

- Nutrition values are decision-support estimates, not clinical measurements. Product copy should
  keep that distinction visible without overwhelming the simple logging flow.
- The deliberate MVP shortcut is model-based estimation using existing AI capabilities. Add a
  curated nutrition database or barcode source only when measured accuracy or user demand shows that
  estimates are insufficient.
- Food and Wellness may share neutral platform contracts and communicate through declared ports, but
  they remain separately installable modules with separate private data ownership and consent.
- Food is the first Moss-authored module specified under the distributable, not-installed-by-default
  ruling, and it doubles as the dogfooding pass for third-party module development: if Food cannot
  be built against the public platform contracts alone, a future outside author cannot either, and
  the missing capability belongs in a platform blocker. Where this spec and a blocker's platform
  spec disagree on lifecycle mechanics, the platform spec wins on mechanism and this spec wins on
  Food's required user-visible behavior.
