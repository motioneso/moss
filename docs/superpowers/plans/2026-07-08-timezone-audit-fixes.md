# Timezone Audit Fixes (issue #877) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your assigned task task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each Task below is ONE worker's whole assignment and ONE PR.

**Goal:** Every user-facing day label ("Today", recurring-task due dates, schedule defaults) is derived from the user's persisted timezone (`/api/me/locale`), never the UTC/server/browser-ambient day.

**Architecture:** All fixes route day-bucketing through the sanctioned shared helper `localDay(input, timeZone)` from `@jarv1s/shared` (`packages/shared/src/time.ts`) and the persisted locale (web: `useUserLocale()`; server: the actor's `app.preferences` key `"locale"`). No schema or API contract changes.

**Tech Stack:** TypeScript, React 18, Fastify, Kysely, vitest (unit tests in repo-root `tests/unit`, integration in `tests/integration`).

**Grounding:** Findings verified on `ce3892fc` (origin/main, 2026-07-08). Line numbers reference that commit and may drift a few lines — verify with grep before editing.

## Global Constraints

- Branch from **origin/main** (`git fetch origin && git checkout -b <branch> origin/main`) inside YOUR OWN worktree. NEVER `git pull`/`checkout`/`reset`/`git add -A` in the shared tree `~/Jarv1s`.
- Do NOT commit this plan file or anything under `docs/superpowers/` — it lives only in the shared tree.
- Every commit/PR body needs a one-paragraph user-facing summary in release-note language, and `Part of #877` + your child issue number.
- Generous why-comments in code (cite issue #877 and the specific finding), terse chat output (Ben's standing feedback).
- Gates before pushing: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:unit` plus `pnpm check:no-ambient-dates` for web-touching tasks. Do NOT run `pnpm test:integration` locally (shared dev Postgres; concurrent runs crash it) — CI runs it on the PR.
- Timestamps stay UTC at rest. Only presentation/day-bucketing is zoned.
- `localDay(input, tz)` returns a `YYYY-MM-DD` string in `tz`. Pure calendar arithmetic on an already-localized `YYYY-MM-DD` key (UTC-noon/midnight anchor + `toISOString().slice(0,10)`) is fine and is NOT the bug pattern.

---

### Task A: Sports "Today" next-match footer (HIGH — the prod bug) — branch `fix/877-sports-today-footer`

**Files:**

- Modify: `packages/sports/src/web/sports-ticker.tsx` (~lines 332, 439, 451–460)
- Test: add `tests/unit/sports-next-match-today.test.ts` (check for an existing sports web unit test to colocate with first: `grep -rl "nextMatchParts\|sports-ticker" tests/unit`)

**Bug:** Both call sites pass `today={card.status === "today"}` into `NextMatchLines`, which renders `card.nextMatch`. `status === "today"` means "the team has/had a game today (ESPN Eastern)" — including an already-final one. After today's game goes final, `nextMatch` is TOMORROW's fixture, but the flag stays true → footer reads "Today · 6:40 PM" for tomorrow's game. Hits /sports featured strip and the /today widget (shared components).

**Fix:** compute the flag from the fixture itself, in the user's persisted timezone, inside `NextMatchLines`; delete the `today` prop entirely (both call sites — no-stale-concepts rule).

- [ ] **Step 1: Failing unit test.** `nextMatchParts` is already exported; also export a new pure helper so the flag is testable without React:

```ts
// sports-ticker.tsx — new exported pure helper, placed next to nextMatchParts
/**
 * True when the fixture starts on the user's local calendar day (#877 finding 1).
 * Derived from the fixture instant + persisted locale tz — NEVER from card.status:
 * status "today" is ESPN-Eastern and stays true after today's game goes final,
 * when nextMatch has already advanced to tomorrow's fixture.
 */
export function nextMatchIsToday(
  next: FollowedNextMatch,
  locale: LocaleSettingsDto,
  now: Date = new Date()
): boolean {
  return localDay(next.startsAt, locale.timezone) === localDay(now, locale.timezone);
}
```

Test (vitest, no React needed): a fixture at `2026-07-10T01:40:00Z` (= 6:40 PM PT on 7/9) with `now = 2026-07-09T05:00:00Z` (= 10 PM PT on 7/8) must be `false` for `America/Los_Angeles` (UTC day matches, local day does not) and `true` with `now = 2026-07-09T20:00:00Z` (= 1 PM PT on 7/9). Run `pnpm vitest run tests/unit/sports-next-match-today.test.ts` → FAIL (helper missing).

- [ ] **Step 2: Implement.** Import `localDay` (extend the existing `@jarv1s/shared` type import to a value import). In `NextMatchLines`, drop the `today` prop; compute `const isToday = nextMatchIsToday(props.next, locale)` (locale already in scope via `useUserLocale()`), render `isToday ? \`Today · ${formatTime(...)}\` : when`. Update both call sites (~332, ~439) to `<NextMatchLines next={card.nextMatch} />`. Leave the card's "Today" flag pill (~line 256) and matchup-suppression logic (~229/350) alone — those key off the today-game itself and are correct.

- [ ] **Step 3: Gates.** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:unit && pnpm check:no-ambient-dates` — all exit 0.

- [ ] **Step 4: Commit + PR.** Release-note summary: "Sports cards no longer label tomorrow's fixture 'Today' in the evening — the next-game footer now uses your selected timezone."

### Task B: Recurring tasks roll forward on the user's day, not UTC (HIGH) — branch `fix/877-recurrence-local-day`

**Files:**

- Modify: `packages/tasks/src/recurrence.ts` (~154, ~250: remove UTC default params), `packages/tasks/src/drift.ts` (3 call sites + export helper), `packages/tasks/src/jobs.ts` (~142)
- Test: extend the existing recurrence unit tests (`grep -rl "rollForward" tests/unit tests/integration`)

**Bug:** `rollForwardRecurringSeries` / `rollForwardOwnedSeries` default `today = new Date().toISOString().slice(0, 10)` (server UTC day) and every caller relies on the default (`jobs.ts:142`, `drift.ts` getOverdue/getAtRisk/etc. ×3). From 5 PM PT, a daily task still due today is advanced to tomorrow. The `recurrence-schedule.ts` comment claims the lazy-on-view safety net keeps the list correct — it can't while the safety net uses the same UTC default.

- [ ] **Step 1:** In `recurrence.ts`, make `today: string` a REQUIRED param on both functions (delete the defaults) so the compiler finds every caller. Keep the `YYYY-MM-DD` contract in the doc comments; note it must be the ACTOR's local day (#877 finding 2).
- [ ] **Step 2:** In `drift.ts`, rename the private `readUserTimezone` to an exported `readActorTimezone` (same body). In each repository method that currently calls `rollForwardOwnedSeries(db)` then reads tz, reorder: `const tz = await readActorTimezone(db); await rollForwardOwnedSeries(db, localDay(new Date(), tz));` (import `localDay` from `@jarv1s/shared`). Where tz was read later for the day-boundary query, reuse the one read — don't hit preferences twice.
- [ ] **Step 3:** In `jobs.ts` recurrence worker (~142), `const tz = await readActorTimezone(scopedDb); const rolledForward = await rollForwardOwnedSeries(scopedDb, localDay(new Date(), tz));`.
- [ ] **Step 4:** Fix the now-stale comment in `recurrence-schedule.ts` (~lines 10–13): the cron still runs 03:00 UTC, but the safety net + worker now roll on the actor's local day.
- [ ] **Step 5: Failing-first unit test:** with a series at `occurrence_date = "2026-07-08"` and `today = "2026-07-08"` (user local day while UTC is already 7/9), `nextOccurrenceAtOrAfter` returns `"2026-07-08"` unchanged — plus a test that both roll-forward functions no longer compile/accept zero-arg day (type-level; assert via a call with explicit day in the DB-mocked or integration test that rolls only when `occurrence_date < today`). Follow the shape of existing recurrence tests you found.
- [ ] **Step 6:** Gates (`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:unit`); do NOT run test:integration locally. Commit + PR. Release-note summary: "Recurring tasks now roll to the next day at your local midnight instead of 5 PM Pacific."

### Task C: Locale plumbing — due-date input + digest schedule timezone (MED) — branch `fix/877-locale-plumbing`

**Files:**

- Modify: `apps/web/src/tasks/task-format.ts` (~10–16), `apps/web/src/tasks/task-details-model.ts` (~48–49 + its component caller), `apps/web/src/settings/settings-module-subviews.tsx` (~403)
- Test: `tests/unit` — colocate with existing task-format/task-details tests if present (`grep -rl "toDateInputValue" tests/`)

**Bug 3:** `toDateInputValue` slices the UTC day, so a dueAt instant near UTC midnight shows a different day in the edit form than the list label (which uses `localDay(dueAt, tz)` in `task-view-model.ts`).
**Bug 4 (frontend half):** the digest schedule save uses browser-ambient `Intl.DateTimeFormat().resolvedOptions().timeZone` while the briefings pane (same file, ~117/148) correctly uses the persisted locale.

- [ ] **Step 1:** `toDateInputValue(value: string | null, timeZone?: string)` → `value ? localDay(value, timeZone) : ""` (import `localDay` from `@jarv1s/shared`). Thread the timezone: `task-details-model.ts` builds the form state — give its builder a `timeZone` param and pass `useUserLocale().timezone` from the component that calls it (trace the caller; it already renders dates so the locale hook is likely in scope). Keep `fromDateInputValue`'s noon-UTC anchor as is (writing is symmetric and DST-safe).
- [ ] **Step 2:** Failing-first unit test: `toDateInputValue("2026-07-09T04:00:00Z", "America/Los_Angeles") === "2026-07-08"` (9 PM PT on 7/8); with `"UTC"` it returns `"2026-07-09"`.
- [ ] **Step 3:** In `settings-module-subviews.tsx` `updateDigest` (~390–417), replace `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"` with the persisted locale timezone already fetched at ~117 (`localeQuery.data?.locale.timezone`), falling back to the briefings pane's existing default pattern. Match how ~148 does it. Also: when PATCHing an existing preference, send the persisted-locale tz instead of blindly echoing `current.scheduleMetadata.timezone` **only if** the stored value is `"UTC"`-default — otherwise preserve the user's stored choice.
- [ ] **Step 4:** Gates incl. `pnpm check:no-ambient-dates` (your edit REMOVES an ambient call —
      good). Commit + PR. Release-note summary: "Task due-date editing and email-digest scheduling now
      follow your selected timezone."

### Task D (PHASE 2 — dispatch only after A–C merge): gate hardening + wellness verification — branch `fix/877-gate-hardening`

**Files:**

- Modify: `scripts/check-no-ambient-dates.ts`
- Test: `tests/unit` wellness med-window test (`grep -rl "medicationLog" tests/`)

- [ ] **Step 1:** Extend the gate's scan roots to include `packages/*/src/web` (module web contributions — the sports bug lived there, unscanned). Allowlist `packages/sports/src/web/locale.ts` (it is the sports copy of the sanctioned formatter).
- [ ] **Step 2:** Add a second pattern catching ambient-NOW day bucketing: `/new Date\(\)\s*\.toISOString\(\)\s*\.slice\(0,\s*10\)/` across BOTH scan roots AND server packages (`packages/*/src`). Allowlist `packages/settings/src/data-export-async-routes.ts` (export filenames, not display). Run the gate; if it flags anything else, fix or allowlist with a one-line justification comment.
- [ ] **Step 3:** Wellness verify (finding 6): add a unit test for `medicationLogBelongsToDate` (`packages/wellness/src/repository.ts` ~505) pinning that an evening-PT `logged_at` (e.g. `2026-07-09T04:00:00Z` = 9 PM PT 7/8) belongs to the 7/8 PT day window, and a `scheduled_for` date-keyed dose matches its UTC-keyed window. If the logged_at case FAILS, do not fix — report on issue #877; the window design may be deliberate.
- [ ] **Step 4:** Gates, commit + PR. Release-note summary: "Internal guardrail: the ambient-date lint now also covers module web code and UTC-day bucketing; adds a regression test for medication day windows. No user-visible change."

## Self-review notes

- Finding 4's server-side defaults (briefings `DEFAULT_TIMEZONE="UTC"`, digest route default) are deliberately DEFERRED: the UI now always supplies the persisted tz (Task C), and a server-side preference read inside schedule defaulting is a design change — noted on #877 for a follow-up decision.
- Types: `localDay(input: string|number|Date, timeZone?: string): string`; `LocaleSettingsDto = { timezone: string; region: string; dateFormat: "12"|"24" }`; `FollowedNextMatch.startsAt: string` (ISO). All verified on ce3892fc.
