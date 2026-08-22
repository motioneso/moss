# Relay 2: #1572 custom sports news sources (Task 1)

Relaying on the context-meter 70% warning, per the box-wide context-diet rule and the `relay`
skill.

## Where things stand

- Spec: `docs/superpowers/specs/2026-08-17-1572-custom-sports-news-sources.md` (Approved)
- Plan: `docs/superpowers/plans/2026-08-21-1572-custom-sports-news-sources.md`
- Task issue: #1572
- Branch/worktree: `1572-custom-sports-news-sources`, this worktree
  (`~/Jarv1s/.claude/worktrees/1572-custom-sports-news-sources`)
- Scope: **Task 1 only** (schema + discovery/preview/confirm REST + settings UI). Tasks 2-3 stay
  scope-only.
- Coordinator: Herdr label `Coordinator` — **re-resolve by label fresh**, don't reuse any pane
  number written here (they reflow). It is currently running as an `Opus 5` session per a status
  bar I saw; that's the coordinator's own model choice, not something to act on.

## What's done since the first relay (all committed on this branch)

1. `d013cd114` — ran `pnpm format:check`, fixed 6 files that failed formatting, committed.
2. `e016b0e27` — the full local gate's file-size check failed:
   `packages/shared/src/sports-api.ts` had grown past 1000 lines from Task 1's added types. Split
   the whole custom-source block (types + schemas) into a new
   `packages/shared/src/sports-sources-api.ts`, re-exported from the shared package's `index.ts`
   barrel. All consumers import from `@moss/shared` (the barrel), not the file directly, so no
   consumer changes were needed. Confirmed both files now under 1000 lines.
3. `a75f7cf5a` — the gate's `check:package-deps` step failed next: `@moss/sports`'s package.json
   declared `@moss/web-research` but nothing in `packages/sports/src/**` imports it (only a code
   comment mentions the package name). Removed the dependency and ran `pnpm install` to update the
   lockfile. `@moss/news` (also declared) IS genuinely used — confirmed by grep before touching
   anything, left alone.
4. `b5ab0f1c6` — the gate's `test:unit` step then failed two **stale fixture** tests that don't
   reflect Task 1's real manifest changes (not real bugs — these tests pin the manifest as a
   snapshot and Task 1 changed the manifest without updating them):
   - `tests/unit/module-dependency-allowlist.test.ts` — added `"@moss/sports -> @moss/news"` to
     `SANCTIONED_FEATURE_COUPLINGS` (sports genuinely depends on news's URL-preview/confirm
     helpers; this is real, not accidental coupling).
   - `tests/unit/sports-manifest.test.ts` — updated the expected `ownedTables` (added
     `sports_custom_sources`, `sports_source_assignments`, `sports_policy_verdicts`,
     `sports_headline_prefs`) and `migrations` (added `sql/0189_sports_custom_sources.sql`) to
     match `packages/sports/src/manifest.ts`'s actual current declarations.
   - Ran both test files in isolation after the fix: both pass (8/8 tests).
5. Re-ran `pnpm format:check && pnpm lint && pnpm typecheck` after each fix — all green each time.
6. Re-fetched and rebased onto `origin/main` after the fixes — no new upstream commits, clean
   rebase, no conflicts.

## An unrelated box-wide incident happened mid-session — already resolved

The root filesystem (`/`) filled to 100% (0 bytes free) partway through this session, caused by
stray Docker images plus a hidden cryptocurrency miner in an unrelated container elsewhere on the
machine — **not caused by this branch or this worktree**. Every shell command failed with
disk-full errors for a while. Ben (the user) cleaned it up: images removed, miner container
killed, disk is back to about 94 GB free at last check.

**Ben's explicit instruction: treat any check result from before the cleanup as untrustworthy and
redo it.** All the fixes and gate re-runs listed above happened AFTER the disk was confirmed
clear, using a fresh gate database each time, so they should be trustworthy — but the successor
should not reuse any log file timestamped before roughly 19:57 (the disk-clear notification
landed then) as evidence.

## What's left before wrap-up

1. **That gate run finished (rc=1) with three failures. Two are now fixed and committed
   (`57230ac19`); one is unexplained and needs a look before the next full run.**

   Fixed, both the same kind of problem — a test that hard-codes a snapshot of "every table/migration
   that exists" and simply hadn't been told about the four new tables and one new migration file this
   feature added:
   - `tests/integration/foundation-schema-catalog.test.ts` — expected list of applied migrations was
     missing the new `0189_sports_custom_sources.sql`. Added it.
   - `tests/integration/module-data-lifecycle-cascade.test.ts` — expected list of tables that must
     delete their data when a user is deleted was missing the four new sports tables. Before adding
     them, confirmed the test's own separate check (that every declared table's delete rule is
     real, run just above the part I edited) had already passed — so these four tables truly do
     delete correctly, this was a snapshot needing an update, not a real bug. Added them.

   **Not yet explained** — investigate this one before trusting a rerun:
   - `tests/integration/job-search-store.test.ts` — one test failed with a database error, "role
     jarvis_mod_job_search_runtime does not exist". This is a completely different feature (job
     search), not touched by this branch at all, and that role should get created automatically
     when the test suite sets up its database. Two guesses, not yet confirmed: (a) it's a
     pre-existing flake unrelated to this branch — worth a quick check of whether main has the
     same problem — or (b) something about running the gate back-to-back against reused database
     state left that role missing. **Read the test's setup code
     (`tests/integration/job-search-store.test.ts` and `scripts/module-install.ts`) to understand
     how that role is supposed to get created, and don't touch sports/news code to chase this** —
     if it turns out to be a pre-existing, branch-unrelated flake, say so plainly to the coordinator
     rather than spending a long time chasing it.

2. **Run the gate again from a clean database** to confirm all three issues are actually resolved
   and nothing else broke:
   ```bash
   docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1572;"
   docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE jarvis_gate_1572;"
   export JARVIS_PGDATABASE=jarvis_gate_1572
   nohup bash -c '( pnpm verify:foundation > /tmp/vf_1572e.log 2>&1; echo "### FINAL rc=$?" >> /tmp/vf_1572e.log )' > /dev/null 2>&1 &
   disown
   ```
   Watch it with the `Monitor` tool's until-loop pattern, not by polling in the conversation. If more
   stale-snapshot or genuinely-new failures surface, apply the same judgment as above: distinguish "a
   snapshot test just needs updating" from "a real bug the gate correctly caught" — don't blindly
   force a fixture to pass without checking which one it is.
   **Drop the `jarvis_gate_1572` database when the gate is fully green and no longer needed**, per
   the `verify-gate` skill.

2. **Live-path proof** — run the UAT spec against a live dev instance (`pnpm test:uat` per
   `tests/uat/run-uat.ts`'s env conventions — don't hand-set `JARVIS_UAT_BASE_URL` /
   `JARVIS_UAT_PROJECT_NAME`, the runner sets those). The spec is already committed:
   `tests/uat/specs/1572-sports-custom-sources.uat.spec.ts`. At minimum capture real output for
   the always-on deterministic test (sign in, open Sports settings, assert the custom-sources
   section renders). If a real Anthropic token is available for `JARVIS_UAT_REAL_CHAT_ENV_FILE`,
   also run the full add/assign/edit/remove test — but the always-on test alone satisfies the gate
   if a real token isn't available; say so plainly rather than skipping the proof comment.

3. **Push, open PR, post the live-path proof** via `coordinated-wrap-up`: push (pre-push trio +
   rebase already re-verified clean as of this relay, but re-check if more commits land before
   push), open PR, `gh pr comment` with the UAT run output/exit code and what was exercised. Fill
   in the PR template's Release note section (Category/Title/Description — plain English, no
   jargon), run `node scripts/append-release-note.mjs --pr <number>`, commit the resulting
   `docs/WHATS_NEW.md` change onto this branch before final push if the note wasn't already
   appended.

4. **Report to the coordinator** (re-resolve its pane by label `Coordinator` fresh) with the PR
   link and the live-path evidence. Then stop — merge/board/close are the coordinator's.

## Notes for the successor

- `node_modules` already exists in this worktree — do not re-run `pnpm install` (it was run once
  this session only to update the lockfile after removing a dependency; that's already committed).
- This is a **shared checkout** — other sessions may commit here concurrently. Before any commit,
  re-check `git status`/`git diff` on the exact paths you're about to commit, and use
  `git add <path>` + `git commit` (not bare `git commit <path>`). Never `git add -A`.
- Read the spec/plan by section for what you need, not front-to-back.
- Relay trigger is the same for you: the context-meter 70% warning, or immediately on seeing
  another compaction summary. Don't invent a higher personal threshold.
- Plain-English rule applies to every status update and every message to the coordinator: say
  what broke and what it means, not identifier soup. E.g. "the file split into two smaller files
  so it passes the size check" beats a sentence full of exact file names with no explanation of
  why.
