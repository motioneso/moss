# Skills List-First Management and First Invocation (#994) — Implementation Plan

> **Approval gate:** Do not start product work until the Coordinator approves this plan and its
> paired spec. Builders must work test-first and stage explicit paths only.

**Spec:** `docs/superpowers/specs/2026-07-13-994-skills-list-first-invocation.md`

**Grounded against:** `origin/main` at `96d22ba0` on 2026-07-13

**Goal:** Put the skill library before authoring controls, make create/edit/upload understandable,
and make the existing single-turn slash invocation styled, keyboard-complete, accessible, and
consistent for names containing spaces.

**Architecture:** Preserve #760's database, DTO, endpoint, file, and composition contracts. Reorder
the current Settings pane and reveal its existing inline flows on demand. Add one pure derived
command-name helper at the autocomplete seam. Keep active-option/dismissal state in Composer, add
the missing tokenized chat CSS, and validate required text at the existing route boundary.

## Ownership and Collision Locks

| Area         | Owned files for this issue                                            | Must not absorb                                              |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Settings UX  | `apps/web/src/settings/settings-skills-pane.tsx`                      | New form framework, modal system, marketplace                |
| Invocation   | `apps/web/src/chat/skill-autocomplete.tsx`, `composer.tsx`            | New command grammar, persistent context, multi-skill runtime |
| Styling      | `apps/web/src/styles/kit-chat.css`                                    | General chat redesign                                        |
| Validation   | `packages/chat/src/skills/routes.ts`; `frontmatter.ts` only if needed | DTO/endpoint/file-format/schema changes                      |
| Verification | Focused unit/integration/E2E files outside UAT                        | Any edit under `tests/uat/**`                                |

No migration, repository contract, module manifest, shared DTO, API client, or query-key change is
expected. `docs/coordination/**` is out of bounds. Stop and return to the Coordinator if a locked
contract proves insufficient.

## Task 1 — Pin the Derived Command Contract

**Files:**

- `tests/unit/chat-skill-autocomplete.test.ts`
- `apps/web/src/chat/skill-autocomplete.tsx`

- [ ] **Step 1 (red):** Add table tests for `skillCommandName`: trim; locale-independent lowercase;
      internal whitespace-run replacement; and preservation of non-whitespace characters. Pin
      `Daily   standup` → `daily-standup`.
- [ ] **Step 2 (red):** Change existing filter and bare-resolution tests to use derived commands.
      Cover a space-bearing name, case-insensitive typed command, disabled exclusion, duplicate
      derived commands resolving by existing list order, and explicit record-ID binding winning
      over bare resolution.
- [ ] **Step 3 (green):** Implement the pure helper and route command display, filtering, and
      `resolveSkillByName` through it. Do not add a persisted field or alter API ordering.
- [ ] **Step 4 (green):** Keep stored-name matching as a secondary autocomplete convenience while
      treating the derived command as the canonical displayed/invoked token.
- [ ] **Step 5 (verify):** Run `tests/unit/chat-skill-autocomplete.test.ts` and affected workspace
      typechecks.

## Task 2 — Make the Skills Pane List-First

**Files:**

- `tests/unit/settings-skills-pane.test.tsx`
- `apps/web/src/settings/settings-skills-pane.tsx`

- [ ] **Step 1 (red):** Assert existing skills/list empty state renders before authoring controls
      and the create/edit form is absent initially. Assert Create skill opens create mode, Edit opens
      the same form with the record, Cancel closes it without mutation, and success returns focus to
      the list/header action.
- [ ] **Step 2 (red):** Assert Upload file opens a focused upload flow, valid success returns to the
      list with status feedback, invalid import keeps actionable feedback, and no permanent file
      input occupies every list view.
- [ ] **Step 3 (green):** Add the smallest local flow discriminator (`null | create | edit | upload`)
      or equivalent. Reorder the existing groups so list/empty state is primary; reuse the existing
      mutations, confirmation, and form state.
- [ ] **Step 4 (green):** Place Create skill and Upload file in the pane-header action treatment
      already used by Settings. Avoid a modal, reducer framework, or new shared component unless an
      existing primitive already supplies it.
- [ ] **Step 5 (verify):** Run `tests/unit/settings-skills-pane.test.tsx` and inspect initial,
      create, edit, upload, loading, empty, and error states.

## Task 3 — Clarify Required Inputs and Invocation Preview

**Files:**

- `tests/unit/settings-skills-pane.test.tsx`
- `apps/web/src/settings/settings-skills-pane.tsx`
- reuse `skillCommandName` from `apps/web/src/chat/skill-autocomplete.tsx`

- [ ] **Step 1 (red):** Assert visible/programmatic required state for Name and Instructions,
      optional Description, **Instructions** instead of **Body**, and copy explaining that the
      instructions affect only the invoked turn and precede the typed request.
- [ ] **Step 2 (red):** Assert the generated command preview updates from the current name using the
      same pure helper as chat; cover multiple spaces and edit mode.
- [ ] **Step 3 (green):** Update labels, hints, `required`/`aria-required`, preview, and button state.
      Keep the request fields `{ name, description, body }`; this is display language, not a DTO
      rename.
- [ ] **Step 4 (green):** Keep mutation calls in event handlers. Do not trigger create/update/delete
      from a state setter, which would duplicate effects under StrictMode.
- [ ] **Step 5 (verify):** Run the focused pane tests and inspect desktop plus supported narrow
      settings width for overflow and focus order.

## Task 4 — Enforce Required Text at the Route Boundary

**Files:**

- `tests/integration/chat-skills-routes.test.ts`
- `packages/chat/src/skills/routes.ts`
- `packages/chat/src/skills/frontmatter.ts` only if the existing import parser is the narrowest
  shared validation point

- [ ] **Step 1 (red):** Add create cases for blank and whitespace-only name/body. Expect a clear 400
      and verify no row was inserted.
- [ ] **Step 2 (red):** Add update cases for blank/whitespace name/body. Expect a clear 400 and
      verify the original row is byte-for-byte unchanged in the affected fields.
- [ ] **Step 3 (red):** Add import cases for missing, blank, or whitespace-only frontmatter name and
      Markdown body. Expect a clear 400 and no partial row. Retain the valid byte-preservation case.
- [ ] **Step 4 (green):** Add a tiny route-local required-text validator used before repository
      calls for create/update/import. Validate only fields present on partial update, while rejecting
      an explicitly blank replacement. Keep stored body bytes unchanged when valid; trimming is for
      the blank check, not content rewriting.
- [ ] **Step 5 (green):** Preserve endpoint paths, schemas, DTO names, file parser contract, content
      types, and 256 KB cap. Return field-specific safe messages such as “Skill name is required”
      and “Skill instructions are required.”
- [ ] **Step 6 (verify):** Run `tests/integration/chat-skills-routes.test.ts` against the normal test
      database harness and affected workspace typechecks.

## Task 5 — Pin Keyboard State and ARIA in Pure/Render Tests

**Files:**

- `tests/unit/chat-skill-autocomplete.test.ts`
- `apps/web/src/chat/skill-autocomplete.tsx`
- `apps/web/src/chat/composer.tsx`

- [ ] **Step 1 (red):** Extract/test only the smallest pure active-index transition helper if the
      repository's no-jsdom unit harness cannot exercise key events directly. Cover initial first
      item, ArrowDown/ArrowUp wrapping, match-list shrink/reset, and no-match behavior.
- [ ] **Step 2 (red):** Add render assertions for one stable listbox id, stable option ids based on
      record id, exactly one truthful `aria-selected`, command-first text, and secondary
      description.
- [ ] **Step 3 (red):** Pin Composer behavior at the available component/E2E seam: Enter selects
      while a list is open; Escape dismisses it for the current input; ordinary Enter sends when it
      is not open; pointer selection still binds the concrete record id.
- [ ] **Step 4 (green):** Let `SkillAutocomplete` accept active index/id and selection callback.
      Expose the active option id to Composer for `aria-activedescendant`; add `aria-controls`,
      `aria-expanded`, and the appropriate combobox relationship on the textarea while active.
- [ ] **Step 5 (green):** Keep active/dismissed state local to Composer. Reset/clamp it when query or
      matches change. Escape must not erase text; editing the slash query may reopen suggestions.
- [ ] **Step 6 (green):** In `onKeyDown`, handle active autocomplete keys before the existing send
      branch. Preserve Shift+Enter and all non-autocomplete send/queue behavior.
- [ ] **Step 7 (verify):** Run the focused autocomplete tests and affected workspace typechecks.

## Task 6 — Add Compact Tokenized Invocation Styles

**Files:**

- `apps/web/src/styles/kit-chat.css`
- focused assertions in the Task 7 E2E file

- [ ] **Step 1:** Locate the existing composer styles and define the already-used
      `chatd-skillac`, `__option`, `__name`, `__desc`, `__bound`, and bound-clear classes beside
      them. Add active/selected, hover, focus-visible, and disabled-safe states.
- [ ] **Step 2:** Use existing color, spacing, radius, type, elevation, and motion tokens. Add no
      dependency and no inline replacement design system.
- [ ] **Step 3:** Constrain height with internal scrolling, keep command/description hierarchy
      readable, and prevent the popover/bound chip from causing horizontal page scroll at the
      supported narrow composer width.
- [ ] **Step 4:** Respect existing reduced-motion and contrast behavior; do not encode selection by
      color alone.

## Task 7 — Focused E2E and Live-Path Proof

**Files:**

- `tests/e2e/skills-settings-chat.spec.ts` (new) or the closest existing skills E2E owner
- never `tests/uat/**`

- [ ] **Step 1 (red/green):** Exercise the real browser UI/API path for list-first initial state,
      create, reload, edit, valid/invalid upload, enable/disable, confirmed delete, and required
      validation at desktop and narrow viewports.
- [ ] **Step 2 (red/green):** Type a space-bearing command query, select with arrow keys + Enter,
      verify the bound generated command, type a request, and send. Assert the submitted text is
      Instructions + blank line + typed request.
- [ ] **Step 3 (red/green):** Assert Escape closes suggestions without clearing the composer,
      ordinary Enter sends after dismissal/no active menu, disabled skills are absent, and pointer
      selection remains record-ID-specific for duplicates.
- [ ] **Step 4:** Run the sanitized live proof from the spec against a configured local dogfood
      environment. Record the actions and results in the implementation PR description; do not
      commit private skill contents or credentials.

## Task 8 — Final Verification and Handoff

- [ ] Run `tests/unit/settings-skills-pane.test.tsx`.
- [ ] Run `tests/unit/chat-skill-autocomplete.test.ts`.
- [ ] Run `tests/integration/chat-skills-routes.test.ts`.
- [ ] Run the focused skills E2E at desktop and narrow viewports.
- [ ] Run `pnpm check:file-size`, especially for `composer.tsx`, `settings-skills-pane.tsx`, and
      `kit-chat.css`.
- [ ] Run `pnpm verify:foundation` and report the real exit code.
- [ ] Confirm there is no migration, new endpoint/DTO, invocation persistence, persona rewrite,
      marketplace, module runtime, or general autocomplete abstraction in the diff.
- [ ] Confirm `git diff -- tests/uat docs/coordination` is empty.
- [ ] Commit coherent slices using explicit paths only; never use `git add -A`.

## Builder Self-Review

- [ ] Does the list render before all closed authoring flows?
- [ ] Is there exactly one create/edit form and one derived-command helper?
- [ ] Do display, filter, keyboard selection, bound chip, and bare resolution agree on the command?
- [ ] Do duplicate commands remain ID-specific after explicit selection and deterministic when typed?
- [ ] Does Enter select only while autocomplete is active and otherwise preserve normal send?
- [ ] Are invalid route requests rejected before any write without rewriting valid uploaded bytes?
- [ ] Is invocation still single-turn text composition through the existing send path?
- [ ] Are all owned changes outside `tests/uat/**` and `docs/coordination/**`?
