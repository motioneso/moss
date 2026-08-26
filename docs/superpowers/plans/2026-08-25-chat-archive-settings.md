# Build plan — issue #1974: chat archive settings screen

Spec: `docs/specs/1974.md` (committed on this branch, posted as issue #1974 SPEC comment).
Part of #1974.

## Seams check (cited against this branch)

- Backend contract already exists and needs no change:
  `packages/shared/src/chat-archive-api.ts:3-11` — `ChatArchiveSettingsResponse` /
  `PutChatArchiveSettingsRequest`, both `{ enabled: boolean; folder: string }`.
  `packages/shared/src/index.ts:19` re-exports it as part of `@moss/shared`.
- Routes already live: `GET`/`PUT /api/me/chat-archive` (per research; not modified here).
- Frontend has no client function for this route yet — confirmed absent by grep of
  `apps/web/src/api/client.ts` (only `getYoloSettings`/`putYoloSelf` exist for the analogous
  pattern at `apps/web/src/api/client.ts:211,215`).
- Query key namespace: `apps/web/src/api/query-keys.ts:12-39` (`settings` object) — add
  `chatArchive` next to `yolo`/`notesSource` there.
- Notes-source-connected check: `apps/web/src/api/notes-client.ts:11-13` (`getNotesSource`),
  used today by the Sources pane; query key `queryKeys.settings.notesSource` at
  `apps/web/src/api/query-keys.ts:33`. `path: string | null` — `null` means not connected.
- UI primitives, no new ones needed: `Group`/`Row`/`Field`/`Note`/`Switch` — used throughout
  `apps/web/src/settings/settings-ai-pane.tsx` (e.g. `YoloMode` at line 371, `ChatModel`'s
  empty state at lines 353-366 for the `ai-empty` block markup to mirror).
- Error text extraction: `readError` in `apps/web/src/settings/settings-types.ts:31`.
- Mount point: `AssistantPane` at `apps/web/src/settings/settings-ai-pane.tsx:425-439`.
- UAT precedent for connecting a Notes source via API inside a spec:
  `tests/uat/specs/notes-default-retrieval.uat.spec.ts:97` —
  `page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } })`.
- UAT naming/seed pattern: `tests/uat/specs/1264-settings-self-operation.uat.spec.ts:1-40`
  (`uatLevel`, `signIn` helper, `JARVIS_UAT_BASE_URL`).

No open questions — every capability this plan uses is already in the tree.

## Determinism boundary

Purely deterministic settings UI: no model call anywhere in this feature. All feedback (toast,
inline error, empty state) renders from the query/mutation result, never from any AI output.

## Task 1 — API client + query key

Files:

- `apps/web/src/api/client.ts`: add import of `ChatArchiveSettingsResponse`,
  `PutChatArchiveSettingsRequest` from `@moss/shared` (into the existing type-import block near
  the top), then:
  ```ts
  export async function getChatArchiveSettings(): Promise<ChatArchiveSettingsResponse> {
    return requestJson<ChatArchiveSettingsResponse>("/api/me/chat-archive");
  }
  export async function putChatArchiveSettings(
    body: PutChatArchiveSettingsRequest
  ): Promise<ChatArchiveSettingsResponse> {
    return requestJson<ChatArchiveSettingsResponse>("/api/me/chat-archive", {
      method: "PUT",
      body
    });
  }
  ```
- `apps/web/src/api/query-keys.ts`: add `chatArchive: ["settings", "chat-archive"] as const` next
  to `yolo` inside the `settings` object.

Test (`tests/unit` or existing client test file, whichever this repo's convention uses for
`client.ts` — check for an existing `client.test.ts`; if none exists, skip a dedicated unit test
here since these are two one-line `requestJson` wrappers with no logic — the UAT spec in task 3
exercises them for real):

- No new unit test needed; behavior is proven by the UAT spec (task 3) hitting the real route.

## Task 2 — `ChatArchive` settings section

File: `apps/web/src/settings/settings-ai-pane.tsx`.

Add a `ChatArchive()` component, mounted in `AssistantPane` right after `<YoloMode />`
(line ~436):

```ts
function ChatArchive() {
  // uses: useFeedback (toast), useQuery x2 (chat-archive settings, notes source),
  // useMutation (put chat-archive settings), local folder-input state committed on blur
}
```

Behavior contract (no function body — TDD writes it):

- Queries `queryKeys.settings.chatArchive` via `getChatArchiveSettings`, and
  `queryKeys.settings.notesSource` via `getNotesSource` (same key the Sources pane already
  invalidates on connect, so this section updates automatically when a source is connected
  elsewhere — no new invalidation wiring).
- If `notesSourceQuery.data?.path` is `null`, render the `ai-empty` block (same CSS classes as
  `ChatModel`'s empty state) with copy explaining that a notes folder must be connected first,
  pointing at Data sources. Do not render the switch or folder field in this state.
- Otherwise render a `Group` titled "Save chats to Notes" containing:
  - `Row` with a `Switch` (`ariaLabel="Save chats to Notes"`) bound to `enabled`, calling the PUT
    mutation with the current folder value on toggle.
  - `Field` with a plain `<input className="jds-input">` for the folder, local state initialized
    from the query result (defaulting to `"Moss/Chats"` if the response's `folder` field is
    empty), committed via the PUT mutation `onBlur`, not on every keystroke.
  - `Note` stating the folder is relative to the connected Notes source, nested paths like
    `2 Area/Moss/Chats` are fine, and a path starting with `/` or containing `..` is rejected.
  - On mutation error, show the message from `readError(error)` inline under the folder field
    (a small text element under the `Field`, styled like an existing inline-error pattern if one
    exists in this file — otherwise a plain `<div className="jds-field-error">`), and do not
    overwrite the local folder input with the failed value's rejection — leave the user's typed
    text so they can fix it, matching the spec's "previous good value is not overwritten" case for
    the _saved_ value, while the input keeps their edit.
  - On mutation success, toast a short confirmation and update the query cache with the result.

Test cases (component/unit level, in whatever existing test file covers `settings-ai-pane.tsx`,
or a new adjacent one if none exists — check first):

1. Renders the empty state and no switch/field when `getNotesSource` resolves `path: null`.
2. Renders the switch (unchecked) and folder field pre-filled `Moss/Chats` when
   `getChatArchiveSettings` resolves `{ enabled: false, folder: "Moss/Chats" }` and a source is
   connected.
3. Toggling the switch calls `putChatArchiveSettings` with the current folder and the new
   `enabled` value.
4. Blurring the folder field after editing calls `putChatArchiveSettings` with the new folder and
   current `enabled` value.
5. A mutation rejection surfaces the rejection message text inline (not just a toast).

These would fail against a broken implementation because: (1) fails if the empty-state gate is
missing (switch renders even with `path: null`); (2)-(4) fail if the two API calls or query keys
are wired wrong (mutation never fires, or fires with stale values); (5) fails if errors are only
toasted and no inline text node contains the server's message.

## Task 3 — UAT spec

File: `tests/uat/specs/1974-chat-archive-settings.uat.spec.ts`.

`uatLevel = { level: "admin+data", without: [] }` (matches `notes-default-retrieval.uat.spec.ts`,
since this needs a connected Notes source).

Test cases:

1. Sign in, connect a Notes source via `PUT /api/me/notes-source` (same call as
   `notes-default-retrieval.uat.spec.ts:97`), open Settings → Assistant & AI. Assert the "Save
   chats to Notes" switch is visible, unchecked, and the folder field shows `Moss/Chats`.
2. Turn the switch on. Assert a toast/confirmation appears. Reload the settings page. Assert the
   switch is still on (proves the PUT persisted and the GET reflects it).
3. Change the folder field to a nested path (e.g. `2 Area/Moss/Chats`), blur, assert save
   succeeds (toast or absence of the inline error).
4. Change the folder field to `/etc/passwd` (leading slash — deterministically rejected by
   `validateChatArchiveFolder`), blur, assert the inline error text contains "leading slash" and
   the field is not silently accepted.
5. Sign in as a second seeded user with no Notes source connected (or the same admin before step
   1's PUT, run first in the file), open Settings → Assistant & AI, assert the empty-state copy is
   shown and no switch/field is rendered.

Add a row to `.claude/skills/coordinate/uat-trigger-map.tsv`:
`blocking	apps/web/src/settings/settings-ai-pane.tsx	tests/uat/specs/1974-chat-archive-settings.uat.spec.ts`

Run and observe pass before wrap-up:

```bash
JARVIS_UAT_BASE_URL=<dev-instance-url> pnpm exec playwright test tests/uat/specs/1974-chat-archive-settings.uat.spec.ts > /tmp/uat-1974.log 2>&1; echo "EXIT=$?"
```

Expected exit code: `0`.

## Kill gate

There is only one phase — this is a single settings section with no follow-on phase planned.
If task 2's component tests reveal the `Field`/`Row` primitives cannot express the "empty state
replaces the whole section" requirement without new markup, stop and escalate via `fleetctl`
(`status=blocked`) rather than inventing new CSS — that would break the design-system guardrail.
No human coordinator on this lane, so this call is mine to make and log, not to route.

## Verification (full, before wrap-up)

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
git fetch origin main && git rebase origin/main
```

Then the `verify-gate` skill's recipe for the full local gate (never run `pnpm verify:foundation`
directly), and the UAT command above against a live dev instance for the live-path proof.
Expected exit code for each: `0`.
