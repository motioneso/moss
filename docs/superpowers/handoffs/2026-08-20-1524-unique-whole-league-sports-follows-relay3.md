# Handoff: #1524 whole-league sports follows uniqueness — relay 3

Plan (authoritative, read it, don't re-derive): `docs/superpowers/plans/2026-08-20-1524-unique-whole-league-sports-follows.md`

Worktree: `1524-unique-whole-league-sports-follows`, branch of the same name.

## Done (Tasks 1-4, all committed)

- Repository `create()` rewritten to one insert with untargeted `ON CONFLICT DO NOTHING` +
  re-read on conflict — no more read-before-insert race. `packages/sports/src/repository.ts`.
- New migration `packages/sports/sql/0185_sports_whole_league_dedupe.sql` deletes pre-existing
  whole-league duplicates (keeps the oldest row), `0186_sports_whole_league_unique.sql` adds the
  partial unique index. Both wired into the sports manifest already.
- `tests/integration/sports-follows-repository.test.ts`: two new concurrent-create tests plus a
  migration upgrade-path test that seeds real duplicate rows and checks what survives. All 6 tests
  pass. Last commit: `b696a03d6`.

## A real bug we found and fixed along the way

The dedupe migration's DELETE was silently deleting nothing on a real database with existing
duplicates — the table has row-level security forced on even for its owner, and the role that runs
migrations isn't on the list of roles allowed to touch it. Fixed by turning that row-level security
off for just the one DELETE statement, then back on before the migration finishes. Full writeup:
memory file `migration-owner-cannot-delete-feature-tables.md` (second incident, second half of the
file). If you're touching another data-changing migration on an existing table, check that file
first — this will bite again otherwise.

## What's left — Task 5 (wrap-up), from the plan

1. Full local gate via the `verify-gate` skill. Use a brand new scoped gate database — the old one
   was `jarvis_gate_1524_sports_follows`; drop it and make a fresh one, don't reuse it.
2. No live-UI proof needed — this is backend-only, no UI surface changed. Say so plainly in the PR.
3. Release note: `Category: N/A` (a duplicate whole-league follow was already invisible to users,
   this is an integrity fix under the hood) — per the plan's own reasoning, don't re-litigate.
4. Push, open the PR, run `node scripts/append-release-note.mjs --pr <number>`, commit the
   resulting `docs/WHATS_NEW.md` change.
5. Use the `coordinated-wrap-up` skill for the rest.

## Ben's ruling — repeat this to the coordinator at final wrap-up

Do not close issue #1524 after this merges. Ben is filing separate follow-on sports-follows work
and wants the issue to stay open for that. Already stated once at plan-approval time — say it again
at final report.
