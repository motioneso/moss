# Progress state — issue #1951 (chat transcript archive, backend half)

Working from plan file `docs/superpowers/plans/2026-08-25-chat-archive-backend.md` (tasks 1-10).
This is a live scratch note for context checkpointing, not a relay handoff — do not bump
`relays` in fleetctl for this. Session is continuing in place.

## Done and committed

- Tasks 1-5: committed earlier (see git log on fleet/lane-1951 before this session).
- Tasks 6-8: committed this session, commit "Chat archive: archive-day job, payload allowlist,
  and turn-hook dispatch (tasks 6-8 of #1951)".
  - `packages/chat/src/jobs.ts`: `CHAT_ARCHIVE_DAY_QUEUE`, `ArchiveDayJobPayload`,
    exported `handleArchiveDayJob` (exported so the integration test can call it directly),
    `utcRangeForLocalDate` helper (generous +-24h/48h window, filtered precisely with
    `localDay`), registered in `registerChatJobWorkers` (new `preferencesPort` option,
    defaults to `new PreferencesRepository()`).
  - `packages/jobs/src/pg-boss.ts`: added `"localDate"` to `ALLOWED_PAYLOAD_KEYS`.
  - `packages/chat/src/live/persistence.ts`: inside the existing turn-recording hook
    (`if (this.boss && result && !thread.incognito)` block), reads
    `chat-archive.enabled` off `this.localePreferences`, and if true, reads `locale`,
    computes `localDate` via `localDay(capturedAt, timezone)`, sends
    `chat.archive-day` job.
  - All of `@moss/shared`, `@moss/notes`, `@moss/settings`, `@moss/jobs`, `@moss/chat`,
    `@moss/module-registry` typecheck clean (exit 0) as of this commit.
  - `tests/integration/chat-live.test.ts` already has a new test added (uncommitted as of
    this note): "dispatches the archive-day job only when archiving is enabled and the
    thread is not incognito" — covers enabled+non-incognito sends, disabled does not send,
    incognito does not send. NOT YET run against the real database — must go through the
    verify-gate skill, never directly.

## Not yet done

1. `tests/integration/chat-archive-day-job.test.ts` (new file) — calls `handleArchiveDayJob`
   directly (real DB, not through pg-boss). Needs a real Notes source set up the same way
   `tests/integration/notes-write-tools.test.ts` does it: `mkdtemp`, set
   `process.env["JARVIS_NOTES_ROOTS"]` to that dir, upsert `NOTES_SOURCE_PREFERENCE_KEY`
   (from `@moss/settings`) to that dir via a `PreferencesRepository`. Test cases per the
   plan (task 6): two threads same day both appear as separate sessions in thread-start
   order; an incognito thread's messages are excluded; messages outside the local day
   window are excluded (use a non-UTC timezone to exercise the boundary); disabled
   preference means the function no-ops without calling the writer (assert no file
   written). Build threads/turns via `ChatRepository.openNewThread` +
   `recordCompletedTurn` (same pattern as `createTurn` helper in `chat-live.test.ts:373`).
   Enable archiving by upserting `chat-archive.enabled`=true and `chat-archive.folder`
   (or leave folder default) via the same `PreferencesRepository`, and `locale` with the
   test timezone, all under the target user's `AccessContext`.
2. Commit the new/edited test files (`chat-live.test.ts` edit + new
   `chat-archive-day-job.test.ts`) with an explicit-path commit.
3. Task 9: confirm no new required env/config var is needed — expected true (feature
   defaults off via preference absence). Just state this in the PR body, no file change
   expected.
4. Task 10: release note — `Category: N/A` (backend-only). Still must run
   `node scripts/append-release-note.mjs --pr <number>` from the branch AFTER the PR is
   open (per repo's process gate), then commit `docs/WHATS_NEW.md`.
5. Run full verification via the **verify-gate skill** (never run
   `pnpm verify:foundation` or any DB test directly): unit tests
   (`chat-archive-folder-validation`, `settings-chat-archive-routes`,
   `daily-archive-writer`) + integration tests (`chat-archive-day-job`,
   the extended `chat-live` suite, plus `notes-write-tools` must stay green).
6. Push branch, open PR (`fleetctl set 1951 status=pr-open pr=<n>`).
7. Live-path proof (required — this touches a user-facing feature per the exit criteria,
   even though phase 1 has no UI): manual run against the dev instance — enable both
   prefs via the new PUT route for the dev test user, hold one short chat turn, confirm a
   dated Markdown file appears in the configured Notes folder with the marker line and
   the turn's content. Post as a `gh pr comment` whose first line is exactly
   `LIVE-PATH PROOF`.

## Reminders (binding, carried from the brief)

- Never run pnpm verify:foundation or any database-touching test outside the verify-gate
  skill. Never pipe a gate command — always capture exit code.
- Plain English in every PR description, blocked reason, log message, and any spawn
  prompt — no jargon, plain ASCII punctuation.
- relays=1 already used on this lane (fleetctl). A second explicit relay auto-parks it —
  avoid calling `fleetctl set 1951 relays=+1` again; this note is for in-session
  continuity only, not a relay.
- Shared checkout: commit by explicit path only, never `git add -A` / bare `git commit`.
