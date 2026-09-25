# App Map Truthfulness, Routing Alignment, and Feature Coverage Plan

**Spec:** `docs/superpowers/specs/2026-09-15-app-map-truthfulness-and-coverage.md`

**Status:** Proposed implementation plan.

---

## Overview

This plan aligns all App Map screen and setting URLs with real web routes in `apps/web`, eliminates duplicate declarations between core and module manifests, populates Tier-1 feature and error metadata for 6 major built-in modules, and installs an automated integrity unit test to prevent future drift.

---

## Slices

### Slice 1: Routing Alignment and URL Canonicalization

**Goal:** Correct all module setting and navigation paths so that every URL in `dist/app-map.json` is directly resolvable in the browser.

#### Changes:

1. **`packages/tasks/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/tasks"` to `"/settings?section=modules&module=tasks"`.

2. **`packages/calendar/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/calendar"` to `"/settings?section=modules&module=calendar"`.

3. **`packages/email/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/email"` to `"/settings?section=modules&module=email"`.

4. **`packages/wellness/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/wellness"` to `"/settings?section=modules&module=wellness"`.

5. **`packages/sports/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/sports"` to `"/settings?section=modules&module=sports"`.

6. **`packages/news/src/manifest.ts`**:
   - Update `settings[0].path` from `"/settings/modules/news"` to `"/settings?section=modules&module=news"`.

7. **`packages/connectors/src/manifest.ts`**:
   - Update `connectors.user-settings` path to `"/settings?section=connected"`.
   - Update `connectors.admin-settings` path to `"/settings?section=oversight"`.

8. **`packages/ai/src/manifest.ts`**:
   - Update `ai.user-settings` path to `"/settings?section=assistant"`.

#### Verification:
Run `pnpm build:app-map` and verify with a node snippet that all module settings paths in `dist/app-map.json` start with `/settings?section=`.

---

### Slice 2: Phantom Route Cleanup and Declaration Deduplication

**Goal:** Remove phantom screens (`/chat`, `/briefings`) and deduplicate screen and settings entries between `app-map-core.ts` and `settingsModuleManifest`.

#### Changes:

1. **`packages/chat/src/manifest.ts`**:
   - Remove the `navigation` array from `chatModuleManifest`. Chat is an application-wide drawer mounted by `AppShell`, not a web route in `apps/web/src/app.tsx`.

2. **`packages/briefings/src/manifest.ts`**:
   - Remove the `navigation` array from `briefingsModuleManifest`. Briefings are cards rendered directly on `/today`.

3. **`packages/settings/src/manifest.ts`**:
   - Remove the `navigation` array from `settingsModuleManifest` (since `CORE_APP_SCREENS` owns `id: "settings"` with the canonical description and search keywords).
   - Remove `priority-settings` from `settingsModuleManifest.settings` (since `CORE_APP_SETTINGS` owns `id: "priorities"`).
   - Remove `admin-settings` (`path: "/settings/admin"`) from `settingsModuleManifest.settings` (since admin sections are individually declared in `CORE_APP_SETTINGS`: `people`, `aiproviders`, `instmods`, `audit`, `oversight`, `host`).

#### Verification:
Run `pnpm build:app-map` and verify:
- Screens count matches actual top-level web routes (`today`, `notifications`, `settings`, `tasks`, `calendar`, `wellness`, `sports`, `news`, `workshop`).
- Zero duplicate screen or setting IDs.

---

### Slice 3: Tier-1 Module Feature & Prerequisite Error Coverage

**Goal:** Populate feature declarations, structured error codes, and remediations for Tier-1 modules.

#### Changes:

1. **`packages/tasks/src/manifest.ts`**:
   - Add `features` block:
     - `tasks.lists_and_tags`: Named task lists and tags for categorization.
     - `tasks.priority_matrix`: Eisenhower matrix quadrants (Do First, Schedule, Delegate, Later).
     - `tasks.subtasks`: Decomposing tasks into hierarchical subtasks.
     - `tasks.due_and_reminders`: Due dates, reminders, and overdue alerts.

2. **`packages/notes/src/manifest.ts`**:
   - Add `features` block:
     - `notes.vault_sync`: Ingestion and two-way synchronization of Markdown notes from the local vault root.
     - `notes.semantic_search`: Vector and keyword search over note contents.
     - `notes.assistant_authoring`: Creation, updating, and removal of Markdown notes by the assistant.
   - Add prerequisite error & remediation:
     - Error: `notes.folder_missing` (`class: "prerequisite"`, `remediationRef: "notes.configure_folder"`).
     - Remediation: `notes.configure_folder` (`description: "Select a notes folder under Data sources in Settings."`).

3. **`packages/memory/src/manifest.ts`**:
   - Add `features` block:
     - `memory.associative_graph`: Long-term relational memory linking entities, concepts, and past interactions.
     - `memory.candidate_review`: Manual review and approval queue for auto-extracted memory facts.

4. **`packages/wellness/src/manifest.ts`**:
   - Add `features` block:
     - `wellness.mood_checkins`: Daily mood tracking, reflective prompts, and emotional trend history.
     - `wellness.medication_logs`: Medication scheduling, dose logging, and adherence tracking.
     - `wellness.therapy_notes`: Private encrypted notes isolated from AI context without explicit consent.

5. **`packages/connectors/src/manifest.ts`**:
   - Add `features` block:
     - `connectors.google_calendar_sync`: Continuous background sync of Google Calendar events.
     - `connectors.imap_email_sync`: Periodic IMAP message polling and obligation triage.
   - Add prerequisite error & remediation:
     - Error: `connectors.auth_expired` (`class: "prerequisite"`, `remediationRef: "connectors.reconnect"`).
     - Remediation: `connectors.reconnect` (`description: "Reconnect the account in Settings > Connected accounts."`).

6. **`packages/chat/src/manifest.ts`**:
   - Add `features` block:
     - `chat.response_styles`: Concise, balanced, or detailed assistant verbosity modes.
     - `chat.pinned_context`: Pinning critical notes and instructions to persistent conversations.
     - `chat.export`: Exporting chat threads and turns to Markdown or JSON.

#### Verification:
Run `pnpm build:app-map` and verify `features.length >= 35`, with matching errors and remediations.

---

### Slice 4: Automated App-Map Integrity CI Test

**Goal:** Establish an automated unit test preventing route drift, broken URLs, and dangling remediation references.

#### Changes:

1. **`tests/unit/app-map-integrity.test.ts`**:
   - Create test asserting:
     - All `appMap.screens` paths match registered routes in `webRoutes` (or external `/m/` prefix).
     - All `appMap.settings` paths match either `/settings?section=<id>` or `/settings?section=modules&module=<id>`.
     - Screen and setting IDs are unique.
     - Descriptions do not exceed `MAX_APP_MAP_DESCRIPTION_LENGTH` (240 characters).
     - Every error with `class === "prerequisite"` has a non-empty `remediationRef` resolving to an item in `appMap.remediations`.

2. **Package & CI Scripts**:
   - Verify `pnpm verify:static` runs `pnpm build:app-map` and passes cleanly.

#### Verification:
Run `pnpm test:unit tests/unit/app-map-integrity.test.ts`.

---

## Review Checklist

- [ ] All path references in docs use `~/Jarv1s` rather than absolute `/home/<user>/` paths.
- [ ] No database migrations required (manifest & static map changes only).
- [ ] App map artifact generated at `dist/app-map.json` is fully truthful to React Router and `SettingsPage`.
- [ ] All descriptions conform to length limits (1-240 characters).
- [ ] Prerequisite remediations form a closed world (no undefined references).
