# 2282 news sources, phase 1: relay handoff

Spec/plan: `docs/superpowers/plans/2026-09-05-2282-news-sources.md`, section "Phase 1 e2e and UAT"
(around line 415 — read only that section, not the whole file).

Branch: `build/2282-news-sources`
Worktree: `.claude/worktrees/news-sources-2282` (this same folder — do not `pnpm install`,
`node_modules` is already there)
PR: 2298 (draft)

## What is done (commits on this branch, newest first)

- `f58f5fc3f` — style(news): prettier formatting for task 1.7 reddit files
- `c01c75e43` — test(news): #2282 task 1.9 uat spec for r/technology live path
- `fec4a4c8c` — test(news): #2282 task 1.9 e2e for adding r/technology as a source

The two tests the plan asked for are both written and both pass:

- `tests/e2e/news-settings.spec.ts` — new test in a `subreddit sources (#2282)` group. It fakes
  the network calls and checks that adding `r/technology` shows the right preview, the right
  wording, and the saved row. Also fixed 3 older tests in the same file that were still looking
  for the old label text `Publication homepage or domain`, which a different task had already
  renamed to `Source homepage or domain`.
- `tests/uat/specs/2282-news-sources.uat.spec.ts` — new test that signs in for real, adds
  `r/technology` through the real settings screen, and waits for a real story with that source to
  show up from the real news feed. Row added to `.claude/skills/coordinate/uat-trigger-map.tsv`.

All five checks the plan requires were run un-piped and every one printed `EXIT=0`:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm format:check` (needed a small fix first — see below)
4. the eight named unit test files
5. `pnpm exec playwright test tests/e2e/news-settings.spec.ts -g "2282"`

Along the way, `pnpm format:check` first failed on three files from an earlier, already-merged
task (`packages/news/src/compilation/candidates.ts`,
`packages/news/src/compilation/reddit-refresh.ts`, `tests/unit/news-candidates.test.ts`). Those
were not touched by this task. I ran the formatter on exactly those three files (never a
repo-wide format command), checked the diff was pure line-wrapping with no logic change, and the
check went green. That fix is in commit `f58f5fc3f`.

Working tree is clean. Nothing is staged or uncommitted.

## What is left

This is the only thing left before this slice is done — everything else above is finished and
verified.

**Live proof, then report.** The plan requires proof on a real running copy of the app, not just
passing tests:

1. Start the app using ports 3282 and 5282 instead of the normal ports, so this does not collide
   with anything else already running on the shared machine.
2. In a real browser, open the real settings screen and add `r/technology` as a source — do not
   use a script or write to the database directly.
3. Refresh the page and confirm two things: the new source's stories show up on the News screen,
   and the settings screen's wording says "sources" (matching what the tests check).
4. Save evidence of this (screenshot and/or the exact text seen) and post it as a comment on pull
   request 2298, titled "Live proof (2282)".
5. Stop every server that was started for this, by its exact process id — never by matching a
   process name, since other sessions share this machine.
6. If any database rows were added while doing this, delete them by their recorded id and confirm
   the row count is back to what it was before.
7. Report back to the agent named "coordinator" (use `herdr agent prompt coordinator "<message>"`)
   saying what passed, the exit codes seen, and where the "Live proof (2282)" comment is.

## In-flight decisions worth knowing

- The three-file formatting fix and the three-test locator fix (both described above) were made
  because they were small, safe, already verified by diff, and necessary for the plan's own
  checks to pass — not because the brief asked for them by name.
- Do not start any phase 2 or phase 3 work, and do not touch anything under `docs/coordination`.
- Never run the full `pnpm verify:foundation` gate — it touches the live dev database. Only the
  five named checks above, plus the live proof, are required.
- Never use a repo-wide format command, and never stage files with a broad `git add` — always
  name exact file paths, and follow the `shared-checkout` skill's steps before any commit, since
  other sessions share this same checkout.

## Coordinator

Label "Coordinator", pane `w1:pN8`, tab `w1:t1`, session id `8f2cbfd3-cf0e-4150-bff6-ab0eaae6678c`.
Report to it by name (`herdr agent prompt coordinator "..."`) once the live proof and cleanup are
done. This pane id can change if panes open or close — always confirm the current one with
`herdr pane list` matched on that session id before addressing it directly.

## Relay depth

This is relay 1 of 1 allowed for this slice. If the successor also hits the 70 percent context
warning before finishing, it must not relay again — it should commit whatever is verified and
green, write down its state, and tell the coordinator this slice needs to be split into smaller
pieces instead.

## A note on how to write to Ben

Every message a human reads — status updates, this document, anything a spawned agent writes —
must be in plain, ordinary English. Say what a thing does, not what the codebase calls it. Only
use exact names (a command, a file path, an error message) when someone needs to act on that exact
text, and never stack more than one such exact reference in a single sentence. This rule applies
to this successor and to anyone it in turn spawns.
