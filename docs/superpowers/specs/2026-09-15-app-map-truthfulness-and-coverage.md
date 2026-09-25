# App Map Truthfulness, Routing Alignment, and Feature Coverage Design

**Status:** Proposed design specification for review and implementation planning.

**Date:** 2026-09-15

**Plan:** [Implementation Plan](../plans/2026-09-15-app-map-truthfulness-and-coverage.md)

**Tracking:** Follow-up to App Map foundation (#1110, #1109, #1259) and App Map Truthfulness standard in `CLAUDE.md`.

---

## 1. Goal

Eliminate routing drift, phantom screens, and coverage blind spots in Moss's App Map so that the AI assistant (`app.getMapSlice`) has a 100% truthful, closed-world representation of the application:
1. **Fix all broken settings and screen URLs** so every path in `dist/app-map.json` deep-links directly to a real, working UI surface instead of triggering `NotFoundRedirect` to `/today`.
2. **Deduplicate declarations** between `packages/shared/src/app-map-core.ts` and module manifests.
3. **Establish feature and error coverage for Tier-1 modules** (`tasks`, `chat`, `memory`, `wellness`, `notes`, `briefings`, `connectors`), closing the gap where 19 out of 26 built-in modules declare zero features.
4. **Enforce an automated App-Map Integrity CI Gate** so routing drift and untruthful declarations fail builds automatically before merge.

---

## 2. Background and Problem Statement

Moss's assistant uses `app.getMapSlice` to ground its knowledge of the app. Per `packages/chat/src/live/runtime.ts`:
```
Treat Moss app structure, behavior, settings, and errors as closed-world facts.
Before answering about the Moss app, call app.getMapSlice; when the question concerns the current screen, also call chat.getCurrentView.
Use only facts returned by successful map or current-view tool calls. If the map has no matching declaration, say: I don't know from the current app map.
For a prerequisite error, resolve its remediationRef through app.getMapSlice and name that declared fix.
```

An audit of the live codebase revealed four major failures in this system:

### A. Routing Incompatibility (Broken Deep Links)
In `apps/web/src/app.tsx`, React Router mounts Settings as `<Route path={webRoutePath("settings")} element={<SettingsPage />} />` with `path="/settings"` (exact match, not `/settings/*`). 
Any nested path like `/settings/modules/tasks` or `/settings/connectors` falls through to the catch-all wildcard route:
```tsx
<Route path="*" element={<NotFoundRedirect modulesLoading={modulesQuery.isLoading} />} />
```
which unconditionally redirects the browser to `/today`.

In reality, the web app reaches module settings via query parameters ([apps/web/src/settings/module-settings-deep-link.ts](file:///~/Jarv1s/apps/web/src/settings/module-settings-deep-link.ts)):
```ts
export function moduleSettingsHref(moduleId: string): string {
  return `/settings?section=modules&module=${encodeURIComponent(moduleId)}`;
}
```
Yet module manifests declare invalid subpaths:
- `tasks`: `/settings/modules/tasks` (Dead link ➔ redirects to `/today`)
- `calendar`: `/settings/modules/calendar` (Dead link ➔ redirects to `/today`)
- `email`: `/settings/modules/email` (Dead link ➔ redirects to `/today`)
- `wellness`: `/settings/modules/wellness` (Dead link ➔ redirects to `/today`)
- `sports`: `/settings/modules/sports` (Dead link ➔ redirects to `/today`)
- `news`: `/settings/modules/news` (Dead link ➔ redirects to `/today`)
- `connectors`: `/settings/connectors` and `/settings/admin/connectors` (Dead links)
- `ai`: `/settings/ai` (Dead link)
- `settings`: `/settings/admin` (Dead link)

### B. Phantom Screens
- `packages/chat/src/manifest.ts` declares screen `path: "/chat"`. There is no `/chat` web route in `apps/web`; chat lives exclusively in the `ChatDrawer` component on the app shell, and `chat` is in `HIDDEN_NAV_IDS`.
- `packages/briefings/src/manifest.ts` declares screen `path: "/briefings"`. Briefings are cards rendered on the `/today` screen, not a separate page route.

### C. Redundant & Conflicting Declarations
- `settings` screen is declared in both `CORE_APP_SCREENS` and `settingsModuleManifest.navigation`.
- `priorities` setting is declared in both `CORE_APP_SETTINGS` (`core:priorities`) and `settingsModuleManifest.settings` (`settings:priority-settings`).

### D. Zero-Feature Blind Spots
Out of 26 built-in modules, 19 declare **zero features** in the app map. The assistant cannot explain what Tasks does (Eisenhower grid, subtask breakdown), what Memory does (graph memory, candidate ingestion), what Notes does (markdown editing, vault synchronization), or what Wellness does (mood check-ins, medication logs).

---

## 3. Architecture & Locked Decisions

### Decision 1: Canonical Settings Route Format
All module settings declarations must use the canonical web path format:
```
/settings?section=modules&module=<moduleId>
```
All core settings declarations in `CORE_APP_SETTINGS` retain their single-section format:
```
/settings?section=<sectionId>
```
Specific replacements:
* `tasks.module-settings`: `path: "/settings?section=modules&module=tasks"`
* `calendar.module-settings`: `path: "/settings?section=modules&module=calendar"`
* `email.module-settings`: `path: "/settings?section=modules&module=email"`
* `wellness.ai-consent`: `path: "/settings?section=modules&module=wellness"`
* `sports.follows`: `path: "/settings?section=modules&module=sports"`
* `news.prefs`: `path: "/settings?section=modules&module=news"`
* `connectors.user-settings`: `path: "/settings?section=connected"`
* `connectors.admin-settings`: `path: "/settings?section=oversight"`
* `ai.user-settings`: `path: "/settings?section=assistant"`

### Decision 2: Elimination of Phantom Navigation & Deduplication
1. **Chat Screen**: Remove `chat` from `chatModuleManifest.navigation`. Chat is an application-wide overlay/drawer (`ChatDrawer`), not a routed screen. If described in the app map, declare it as a core feature of the app shell rather than a navigation route.
2. **Briefings Screen**: Remove `briefings` from `briefingsModuleManifest.navigation`. Briefings are cards on the Today screen (`/today`).
3. **Settings Screen Deduplication**: Remove `settings` from `settingsModuleManifest.navigation`. `CORE_APP_SCREENS` in `app-map-core.ts` is the single source of truth for the `/settings` screen.
4. **Settings Deduplication**: Remove `priority-settings` and `admin-settings` from `settingsModuleManifest.settings`. `CORE_APP_SETTINGS` in `app-map-core.ts` owns `priorities`, `people`, `aiproviders`, `instmods`, `audit`, `oversight`, and `host`.

### Decision 3: Tier-1 Feature & Prerequisite Declarations

Add declarative `features` to module manifests matching shipped capabilities:

#### 1. `packages/tasks/src/manifest.ts`
* `tasks.lists_and_tags`: Organize tasks into named lists and filterable tags with quick capture.
* `tasks.priority_matrix`: View tasks ranked by importance and urgency across the Eisenhower quadrants (Do First, Schedule, Delegate, Later).
* `tasks.breakdown`: Break down complex tasks into manageable subtasks.
* `tasks.due_and_reminders`: Schedule due dates and timed reminders with overdue alerts.

#### 2. `packages/notes/src/manifest.ts`
* `notes.vault_sync`: Ingest and synchronize Markdown files from the connected local notes folder.
* `notes.semantic_search`: Search notes semantically or by keyword through local embeddings.
* `notes.assistant_authoring`: Assistant can create, edit, or delete Markdown notes in the linked notes root.
* Error: `notes.folder_missing` (`class: "prerequisite"`, `remediationRef: "notes.configure_folder"`).
* Remediation: `notes.configure_folder` ➔ `"Select a notes folder in Settings > Data sources."`

#### 3. `packages/memory/src/manifest.ts`
* `memory.graph`: Maintain an associative graph of user facts, preferences, and relationships.
* `memory.candidate_review`: Review and approve candidate memories discovered during conversations.
* `memory.people_context`: Ground conversations with notes and attributes stored in the People folder.

#### 4. `packages/wellness/src/manifest.ts`
* `wellness.mood_checkins`: Log daily mood, notes, and emotional trends.
* `wellness.medications`: Track medications, doses, and adherence streaks.
* `wellness.therapy_notes`: Maintain private, encrypted therapy notes isolated from assistant context unless consented.

#### 5. `packages/connectors/src/manifest.ts`
* `connectors.google_calendar_sync`: Periodic two-way synchronization of primary Google Calendar events.
* `connectors.imap_email_sync`: Periodic IMAP synchronization for action-item detection and obligations.
* Error: `connectors.auth_expired` (`class: "prerequisite"`, `remediationRef: "connectors.reconnect_account"`).
* Remediation: `connectors.reconnect_account` ➔ `"Reconnect your account in Settings > Connected accounts."`

#### 6. `packages/chat/src/manifest.ts`
* `chat.response_styles`: Configure assistant brevity (concise, balanced, or detailed) with live previews.
* `chat.pinned_context`: Pin critical background documents or notes to the persistent conversation session.
* `chat.conversation_export`: Export chat conversations and turns in JSON or text formats.

### Decision 4: Automated Integrity Gate (`tests/unit/app-map-integrity.test.ts`)
Add a new unit test suite that asserts:
1. **Screen Route Reachability**: Every item in `appMap.screens` has a path matching `webRoutes` (or a declared `/m/:moduleId` external prefix).
2. **Setting Route Reachability**: Every item in `appMap.settings` matches either `/settings?section=<coreSection>` or `/settings?section=modules&module=<moduleId>`.
3. **No Duplicate Surface IDs**: Every screen and setting ID must be unique across the entire app map.
4. **Closed Prerequisite Remediations**: Every error with `class === "prerequisite"` has a `remediationRef` that exists in `appMap.remediations`.

---

## 4. Verification and Acceptance Criteria

1. **Build Gate**: `pnpm build:app-map` runs cleanly and generates `dist/app-map.json`.
2. **Static Integrity Test**: `pnpm test:unit tests/unit/app-map-integrity.test.ts` passes with 0 failures.
3. **Deep Link Resolution**: Navigating to any path listed in `dist/app-map.json` settings:
   - Does NOT trigger `NotFoundRedirect`.
   - Mounts the expected settings pane with the matching section active.
4. **Assistant Grounding**: Calling `app.getMapSlice` with query `"tasks"`, `"notes"`, `"calendar"`, `"wellness"` returns truthful feature summaries and actionable remediation references.
