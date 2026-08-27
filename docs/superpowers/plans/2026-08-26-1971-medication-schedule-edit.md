# Plan — #1971: edit a saved medication schedule with the builder form

Spec: `docs/specs/1971.md`. Risk tier: sensitive (adversarial QA + Ben merge sign-off).

## Seams check (file:line citations, current tree)

- Builder form state and request-shaping already exist and are the reuse target:
  `apps/web/src/wellness/medication-schedule-form.ts:59` (`MedFormState`), `:102` (`emptyMedForm`),
  `:249` (`buildCreateRequest`).
- `UpdateMedicationRequest` (`packages/shared/src/wellness-api.ts:164`) extends
  `Partial<MedicationScheduleRequestFields>` (`:140`) plus `name`/`dosage`/`form`/`active`/`notes`.
  Every field `buildCreateRequest` puts on its return value is also a field on
  `MedicationScheduleRequestFields` or on `UpdateMedicationRequest` itself, so the object
  `buildCreateRequest` already builds is structurally valid as an `UpdateMedicationRequest` body —
  no new request-builder needed for the save side, just a wider parameter type.
- Server PATCH already validates a full-schedule edit with the same rules as create, and is fully
  tested: `packages/wellness/src/medication-request-parsing.ts:20-26`,
  `apps/web/src/api/client.ts:758` (`updateMedication(id, input)`), proven end-to-end by
  `tests/integration/wellness-medication-editing.test.ts` (all passing on `origin/main`, e.g. the
  "every-interval edited into monthly" case at line 200).
- `MedicationDto` (`packages/shared/src/wellness-api.ts:78`) is what
  `listMedications()` (`apps/web/src/api/client.ts:745`) returns — this is the read side the new
  form-filler converts from. `scheduleTimes` comes back `"HH:MM:SS"` (confirmed by the existing
  UAT spec's own trim, `tests/uat/specs/1970-medication-builder.uat.spec.ts:91-94`), so the
  form-filler must slice to 5 characters the same way.
- No edit UI exists yet: grepped `manage-meds-modal.tsx` for "edit", no match. The row rendering
  loop and its remove button are at `apps/web/src/wellness/manage-meds-modal.tsx:205-235`; the add
  form and its mutation are at `:154-163` (`addMutation`) and `:237-550` (the form JSX).
- `every_n_hours` is a valid `MedicationFrequencyTypeApi` value the six-choice `SCHEDULE_CHOICES`
  (`medication-schedule-form.ts:34`) has no entry for — confirmed by `buildCreateRequest`'s switch
  (`:258-329`), which only ever emits the other seven types. Per spec, out of scope: the Edit
  button is hidden for a medication whose `frequencyType` is `"every_n_hours"`.

## Task 1 — read a saved medication back into form shape

File: `apps/web/src/wellness/medication-schedule-form.ts`.

Add:

```ts
export function medFormFromMedication(medication: MedicationDto): MedFormState;
```

Decisions the implementation must follow (mirrors `withChoice`'s "replace, don't merge" rule so a
converted form can never carry a stray field from another type):

- `frequencyType` -> `choice`: `once_daily` | `times_per_day` -> `"daily"`; `specific_weekdays` ->
  `"selected_days"`; `every_interval` -> `"every_interval"`; `monthly` -> `"monthly"`; `cyclical`
  -> `"cycle"`; `as_needed` -> `"as_needed"`. (`every_n_hours` is never passed in — caller filters.)
- `times`: `medication.scheduleTimes` sliced to `"HH:MM"` per entry; `[]` for `as_needed`; falls
  back to `["08:00"]` if the type uses clock times but the list is empty.
- Every other field pulled 1:1 from the matching `MedicationDto` property, falling back to
  `emptyMedForm`'s default when the stored value is `null` (a field the medication's own type
  doesn't use, e.g. `cycleDaysOn` on a monthly medication).
- `startDate`: `medication.scheduleStartDate ?? ""`.
- Import `MedicationDto` from `@moss/shared` (already imported as a type-only import path pattern
  matches `CreateMedicationRequest` at `medication-schedule-form.ts:1`).

Update the export list used by `manage-meds-modal.tsx` (`:10-28`) is not required for this task —
task 2 adds the new import.

### Test cases — `tests/unit/wellness-med-builder-form.test.ts`

One case per of the six choices: build a `MedicationDto`-shaped object with that schedule (values
taken from the `schedules` fixture already used in
`tests/integration/wellness-medication-editing.test.ts:80-113`, translated to `MedicationDto`
field names), run it through `medFormFromMedication` then `buildCreateRequest`, and assert the
round-tripped request equals the request `buildCreateRequest` would build from the original
hand-authored form state for that same schedule. This is what would fail if the mapping dropped or
mis-named a field. Also one case for the `"HH:MM:SS"` -> `"HH:MM"` time slice specifically.

Verify: `pnpm --filter web exec vitest run tests/unit/wellness-med-builder-form.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`.

## Task 2 — wire Edit into the modal

File: `apps/web/src/wellness/manage-meds-modal.tsx`.

Decisions:

- New state: `const [editingId, setEditingId] = useState<string | null>(null)`.
- `startEdit(m: MedicationDto)`: `setEditingId(m.id); setForm(medFormFromMedication(m))`.
- `cancelEdit()`: `setEditingId(null); setForm(emptyMedForm(localDay(new Date(), timeZone)))`.
- New mutation:
  ```ts
  const updateScheduleMutation = useMutation({
    mutationFn: (id: string) => updateMedication(id, buildCreateRequest(form)),
    onSuccess: () => {
      /* same four invalidations as addMutation, :157-160 */ cancelEdit();
    }
  });
  ```
- Row loop (`:205-235`): add an Edit button next to the existing remove button
  (`aria-label={\`Edit ${m.name}\`}`), rendered only when `m.frequencyType !== "every_n_hours"`,
`onClick={() => startEdit(m)}`.
- `deactivateMutation`'s `onSuccess` (`:164-172`) additionally calls `cancelEdit()` when the
  removed id equals `editingId` (needs the mutated id — read it off `onSuccess(_data, id)`, the
  second callback argument tanstack query already provides).
- Section heading (`:238-240`, "Add a medication") -> `editingId ? "Edit medication" :
"Add a medication"`.
- Primary action button (`:529-539`): label `editingId ? "Save changes" : "Add medication"`;
  `onClick` calls `updateScheduleMutation.mutate(editingId)` when editing, else the existing
  `addMutation.mutate()`; `disabled` also covers `updateScheduleMutation.isPending`.
- New Cancel button, rendered only when `editingId`, next to the primary action button,
  `onClick={cancelEdit}`.
- Error line (`:540-548`): also show the existing "That did not save" message on
  `updateScheduleMutation.isError`.

### Test cases — `tests/unit/wellness-manage-meds-modal.test.tsx`

Extend the existing `updateMedication` mock (currently a bare `vi.fn(async () => ({}))`, line 24)
to a capturing mock like `createMedicationMock`, and mock `listMedications` to return one saved
medication per case (reuse the existing render/click helpers, `:29-95`).

- Pressing Edit on a row fills the name field and switches the heading to "Edit medication" and
  the button to "Save changes" — proves the wiring reads the right row, not just any row.
- Pressing Save changes calls `updateMedication` with that medication's id and a payload whose
  `frequencyType` matches the edited choice — proves it is a PATCH-shaped call, not a second
  create.
- Pressing Cancel after Edit restores "Add a medication" / "Add medication" and does not call
  `updateMedication` — proves cancel is a pure form reset.
- Pressing Edit on medication B while medication A is open switches the form to B's values (check
  the name field), not a merge of both — proves `startEdit` replaces rather than patches state.
- A medication whose `frequencyType` is `"every_n_hours"` renders no Edit button on its row —
  proves the out-of-scope type is excluded, not silently broken.

Verify: `pnpm --filter web exec vitest run tests/unit/wellness-manage-meds-modal.test.tsx tests/unit/wellness-med-builder-form.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`.

## Task 3 — live-path proof

New file: `tests/uat/specs/1971-medication-edit.uat.spec.ts`, following the sign-in/open-modal
helpers already in `tests/uat/specs/1970-medication-builder.uat.spec.ts:23-42`.

Test: create one medication as "Every day" (mirrors `startMedication`/`addAndConfirm`,
`:44-61`), press its Edit button, change the schedule choice to "Monthly" with a day of month,
change the name, press "Save changes", close and reopen "Manage medications", and read the
medication back from `GET /api/wellness/medications` (`readSavedMedications`, `:80-97`) to confirm
`frequencyType` is now `"monthly"` with the new `monthDay` and the new name — the strongest single
proof that a real PATCH landed and the list reflects it, not just that the form looked right.

Add a row to `.claude/skills/coordinate/uat-trigger-map.tsv` (after line 99):
`blocking	apps/web/src/wellness/**	tests/uat/specs/1971-medication-edit.uat.spec.ts`

This is also the PR's live-path proof: run it against the live dev instance and post the output as
the `LIVE-PATH PROOF` PR comment per the brief.

## Kill gate

None — this is a single, already-scoped UI wiring change with no architectural fork; owner (this
lane) proceeds through all three tasks in one pass unless task 1's round-trip test surfaces a
schedule field the mapping cannot round-trip cleanly, in which case stop and record a blocked
reason rather than guessing a mapping.

## Determinism boundary

No model involved anywhere in this feature; not applicable.

## Verification (full, before wrap-up)

Use the `verify-gate` skill for the gated run — never invoke `pnpm verify:foundation` directly.
