# Meetings recording types through chat — Phase 2a refinement

Part of #3777; refines Phase 2 of the [merged implementation plan](2026-10-26-meetings-any-recording.md).
Work stays in `~/Jarv1s/.claude/worktrees/meetings-build`. Commit and merge this plan amendment
before product changes. Filing/Memory/What Moss took and audio/Calendar remain required later slices.

## Entry and exit

Phase 1 is merged as PR #3785. Its real-model UI proof passed on clean `3d74df077`;
the full local gate passed with actual exit 0 on that same commit (receipt on the PR).
Its selection/staleness/manual-entry kill gate is satisfied. Preserve its existing manual-entry,
identity, owner choices and filtering behavior. Ship type configuration independently of filing.
Exit with full isolated gate, CI, app-map declarations, a release note and real configured-model
browser proof of chat add/rename/description/style/retirement, then reload/filter/regeneration.

## Verified seams

| Capability                                    | Current evidence                                                                                                                         | Decision                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Owner configuration and defaults              | `packages/meetings/src/recording-types.ts:62`                                                                                            | Extend this repository, no parallel settings store.                                                                   |
| Stable types and configuration revision       | `packages/shared/src/meeting-recording-api.ts:4`                                                                                         | Retain IDs, names, descriptions, style and retirement state.                                                          |
| Existing table and forced owner RLS           | `packages/meetings/sql/0335_meeting_recording_identity.sql:2`                                                                            | No new migration is needed for configuration writes.                                                                  |
| Same API available to ordinary chat actions   | `packages/meetings/src/manifest.ts:294`                                                                                                  | Declare one PUT route with authored presentation.                                                                     |
| Versioned deterministic approval              | `packages/meetings/src/action-presentations.ts:214`                                                                                      | Reuse the public presentation contract, pin all proposed fields and current revision.                                 |
| Summary style is chosen before classification | `packages/meetings/src/output-service.ts:120`, `packages/module-registry/src/meeting-output-runtime.ts:270`                              | Add bounded per-style focus guidance to the same inference; save the interpreted type’s effective style.              |
| Configuration invalidates in-flight identity  | `packages/meetings/src/output-service.ts:175`                                                                                            | Retain the reservation check and add a config-change concurrency test.                                                |
| Active-only selection and legacy identity     | `packages/meetings/src/web/recording-type-picker.tsx:61`                                                                                 | New selection excludes retired types; old chosen identity remains displayed.                                          |
| Server-side type filter                       | `packages/meetings/src/web/meeting-history.tsx:94`                                                                                       | Include retired types in history options so old records remain reachable.                                             |
| Complete chat read of configuration           | `packages/ai/src/gateway/output-validation.ts:10`, `:94`, `packages/module-sdk/src/index.ts:939`, `packages/chat/src/app-actions.ts:326` | Bound normalized pretty configuration to 12,000 UTF-16 units; prove GET/PUT result envelopes fit the 16,000-unit cap. |
| Real chat and action approval harness         | `tests/uat/specs/3065-app-actions-real.uat.spec.ts:137`                                                                                  | Exercise the actual drawer, approve only exact requested mutations, inspect saved API state.                          |

## Contracts and behavior

- Add `PutRecordingTypeConfigurationInput` and strict schema in the existing shared recording API:
  expectedRevision plus a complete list of types. Keep at most 32 total entries, at least one active
  entry, unique IDs and case-folded trimmed names, names up to 80 characters, nonempty descriptions
  up to 500 characters, only existing summary-template IDs and at most 65,536 UTF-8 serialized bytes.
  Also bound the normalized configuration actually persisted/returned to 12,000 UTF-16 units
  measured by `JSON.stringify(configuration, null, 2).length`. Reserve room for the public
  app-action result envelope under the gateway's 16,000-unit cap; assert the actual GET and PUT
  envelopes through public `renderToolResult` in a contract test. JSON escaping, astral characters,
  maximum entry count and maximum revision width are included. The rendered budget is independent
  of individual field limits: 32 maximal descriptions need not fit together. Reject excess with
  an explicit shorten-descriptions error. Retired entries consume count and rendering capacity;
  the 32-entry limit counts active and retired types, and restoring a retained type reuses its ID.
- Retain every existing ID in a replacement list. Removal means setting retired; no physical deletion
  or ID reuse. New IDs must be active and use the existing ID schema. New chat-created types default
  to general summary style unless the user requests another. Restoring a retired type is explicit.
- Keep validation in a focused `recording-type-config.ts`, shared by repository and presentation.
  The route runs that strict validator in preValidation, before Fastify/Ajv can remove unknown
  properties. Ordinary chat also uses its existing removed-field rejection boundary
  (`packages/chat/src/app-action-validation.ts:9`, `:96`).
- Export repository signature `put(db: DataContextDb, input: PutRecordingTypeConfigurationInput): Promise<RecordingTypeConfiguration>`. Serialize first writes with an owner-keyed transaction
  advisory lock, then read/compare revision and write. Two revision-zero requests cannot both win.
  Reads take the shared form of the same owner advisory lock for the caller transaction; this
  prevents a configuration write committing between a generation completion’s configuration check
  and its identity write. Writers take the exclusive form before any read, avoiding lock upgrades.
  App-action approval revalidation completes its own transaction before dispatching the route
  (`packages/chat/src/app-actions.ts:147`, `:271`, `:285`); it must not retain a shared read lock
  while waiting for that route’s exclusive write lock. Cover ordinary chat dispatch in live proof.
  Identical input returns the existing configuration without incrementing its revision.
- Add PUT `/api/meetings/recording-types` in `recording-routes.ts`, permission meetings.write, chat
  access write, content user_authored. GET also declares user_authored because names/descriptions
  are now editable user content. The existing app-action machinery handles consent and receipts.
- Add `recording-type-presentations.ts`. Reject query/params, unknown fields, invalid shapes and
  stale revisions. Show every changed type's before/after name, description, style and active state;
  list additions and retirements explicitly. Hash current and proposed configuration for the
  public presentation version. Internal revision/ID details never replace readable disclosure.
- Update `recording-declarations.ts` with the new route, configuration capability, validation and
  conflict errors plus chat remediation. Update manifest/route fixture expectations in the same PR.
- Preserve a recording's user-selected retired type during regeneration: model guidance permits
  that exact authoritative ID; validation permits it only when metadata proves the user selection.
  Automatically classified retired types remain invalid. New records and type changes use active
  types only. A retired selection remains visible with its latest name; history includes it.
- Style selection must work on the first automatic classification, not only after regeneration.
  Extend the existing fixed templates with concise style-focus metadata, keeping shared evidence
  rules once. For automatic interpretation, provide a bounded catalogue of the existing style
  focuses alongside the configured type-to-style mapping in the same generation call. User-selected
  types remain authoritative, including a retained retired choice. Save the effective interpreted
  type’s template ID/version on the output; do not keep the pre-classification general-style ID
  when the chosen type uses another style. Reject unknown style IDs and retain reservation/config
  revision checks. Keep type/style guidance in new `packages/meetings/src/output-guidance.ts`,
  exported through the module’s public index; the host runtime composes it with escaped evidence
  and retains transport/route checks. Extend `output-validation.ts`’s fixed style metadata and
  `output-service.ts`’s saved effective template selection. No second classification or summary call. The four focus descriptions plus
  added recording guidance together stay below the parent plan’s 150-word added-guidance budget.
- Type configuration edits refresh query data through the existing app-action refresh path
  (`apps/web/src/chat/use-action-query-refresh.ts:8`, `:29` invalidates the module root key); verify
  through the mounted Meetings screen, not only a helper invocation. Keep unknown/failed state visible.

## Determinism and model boundary

Saved configuration drives acknowledgements, receipts, menus and filter labels. Modules never
inject chat turns. This adds no model job: ordinary chat already interprets the user's request and
the existing summary call interprets recordings. Keep the parent plan's exactly two model jobs
(recording interpretation and future bounded filing discovery), added guidance below 150 words,
descriptive schemas, worked example and validation. Existing action cards provide before/after
acceptance for proposed user data; record writes never depend on the model claiming completion.

## Tests and discriminating failures

- Unit `meeting-recording-types.test.ts`: unknown keys, duplicate IDs/names, blank descriptions,
  invalid style, all-retired list, missing existing ID, oversize UTF-8, oversize rendered configuration,
  no-op, valid add/rename/retire. Accept a boundary-sized normalized configuration and round-trip
  its actual GET/PUT app-action envelopes through `renderToolResult` without truncation, including
  escaped strings and astral characters. Fail the test if public schema/envelope growth exceeds
  the gateway limit. Retired entries still count toward the 32-entry and rendering limits.
  Test the presentation's full before/after fields, stale revision rejection and version changes. Exercise first automatic classification into a
  non-general type: the real runtime prompt receives its focus and the saved artifact carries that style;
  changing an automatic type during reclassification selects the new style. This fails if style
  remains pinned to the pre-generation general or previous automatic template.
- Integration `meeting-recording-type-config.test.ts`: actual PUT/GET, simultaneous first writes,
  stale CAS, owner/admin separation, rename/retire, account export and delete. An in-flight summary
  cannot change identity after configuration changes; a competing configuration write waits until
  an already validating generation transaction commits. A user-retired selection survives real service
  regeneration; an automatic retired selection fails. These fail if the revision/owner checks are removed.
- Real browser `3777-recording-types-real.uat.spec.ts`: owner sign-in, real provider configuration,
  main chat, add Field notes, rename Brain dump, edit description/style, retire Other; assert requested
  action disclosure/receipt, real saved configuration, new-entry menu, retired history filter and
  reload. Create an explicit selected recording, retire its type and regenerate with the real model;
  assert retained identity and its configured style. Also classify a new untyped entry after
  setting a non-general style and assert its saved artifact’s style follows the interpreted type. Use no response interception, provider fixtures, screenshots or traces.

## Verification and kill gate

Run all database tests and full gate only through `.claude/skills/verify-gate/SKILL.md`:

```bash
scripts/run-gate.sh start --no-sweep
scripts/run-gate.sh wait --follow
```

Use canonical shared `/tmp/jarv1s-gate` logs and a task-owned `TMPDIR` with enough space.
Custom gate-log directories can lose live database containers to cross-directory cleanup
(open bug #3672); `--no-sweep` avoids removing other sessions' containers during our launch.
Expected exit 0; background the follow wait and retain its actual verdict. Claim a shared port with
`devports claim meetings-build`, pass the printed port as `JARVIS_UAT_CLAIMED_WEB_PORT`, and use the
existing real configured-model UAT runner. Record clean commit, exact command, route, assertions
and exit on the PR. Merge with `gh pr merge --squash --auto` only after green checks and live proof.

Stop and repair this slice if chat can overwrite a newer configuration, retirement loses old
identity/filter access, or real chat cannot complete the requested edit through the ordinary UI.
Builder owns this technical kill gate; product scope decisions stay with Ben.

## Rulings ledger

- Rejected separate per-operation chat tools: the existing declared API action path owns discovery,
  permissions, consent and persisted receipts. A duplicate tool would split those contracts.
- Rejected physical removal: recordings reference stable IDs outside foreign keys; deleting a type
  would lose its display name and make old history unfilterable. Retirement keeps that identity.
- Rejected unguarded upsert: checking revision before a first-row insert without a shared owner lock
  allows two callers to observe defaults. Serialize before read/CAS/upsert, including first writes.

- Found a deferred style seam: current complete() chooses one template before inference; the runtime
  includes only that template’s guidance. Phase 1 defaults all use general, so no editable style was
  promised there. Phase 2a must supply type-aware focus in the same call and record the actual effective
  style. Evidence: `output-service.ts:120`, `meeting-output-runtime.ts:270`, `:286`.

- Independent read-only seam review against `caeab7ee9` found no concrete blockers. It confirmed
  first-write CAS/lock ordering, resolver transaction completion before app-action dispatch,
  user-retired identity handling and the same-call first-classification style seam. Retain the
  drafted concurrency and real-chat tests; this review is not execution evidence or permission
  to skip the Phase 1 merge entry condition.

- Additional seam check: `apps/web/src/chat/action-request-card.tsx:190` maps all authored
  approval fields without slicing, and `packages/ai/src/gateway/pending-presentation.ts:65`
  requires complete human disclosure. Full per-type before/after fields fit the existing
  rendering contract; no custom approval screen or silent truncation is needed.

- Implementation guard for lock ordering: keep configuration row reading in a private helper.
  Public get acquires the shared owner lock; put acquires exclusive before reading and calls
  the private read directly. No shared-to-exclusive upgrade. Record metadata operations may
  already hold the recording row lock before reading configuration; configuration mutation
  must not acquire recording row locks in the opposite order.
- Preserve one permitted-type calculation for generation guidance and owning validation: active
  types plus the exact retained user-selected retired ID. New selection validation remains
  active-only. This avoids relaxing requireRecordingType for unrelated entry/change routes.

- Chat rendering review found an accepted 32-entry/500-character configuration can render above
  the 16,000-unit gateway cap (20,983 units for a representative app-action result). Adopted
  the separate 12,000-unit normalized configuration budget plus an actual public-envelope
  contract test. Cap occurs before HTML trust-boundary escaping (`output-validation.ts:94`),
  so escaped output growth after that point does not trigger truncation.
- Steelmanned paginated GET: supports larger inventories, but coherent full-list replacement
  requires every page at one revision and restart on change, and does not bound replacement
  output. Steelmanned per-type PATCH: smaller edits and better retained-type growth, but still
  needs bounded discovery, global uniqueness and revision CAS. The bounded full GET/PUT contract
  is the smaller adequate slice; revisit PATCH/pagination if actual capacity needs expand.
- Independent critic agreed the bounded contract is adequate only with actual GET/PUT envelope
  tests and normalized persisted/returned-value measurement. Retirement frees neither retained
  entry count nor rendering capacity; errors and app-map guidance must state these separately.
