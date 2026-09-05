# Relay: 2255 follow-key fix (2026-09-04)

Plain English rule for every message to a human: no jargon, no coined shorthand, ASCII punctuation
only, at most one backtick per sentence. Pass this rule on verbatim to any agent you spawn.

## Where things stand

- PR 2255, branch `fix/review-s1-team-identity`, worktree `~/Jarv1s/.claude/worktrees/fix-2255-followkey`.
- Original brief: `~/.coord-briefs/boot-fix-2255-followkey.txt` (read it; it lists the forbidden
  worktrees and ports, and the exact PR comment and report format).
- Steps 1 to 3 of the brief are DONE and committed locally, NOT pushed:
  - Rebased onto origin/main (was 26 behind). Migration stayed at 0217 (main had not taken it).
    Main had moved the route schemas into `packages/shared/src/sports-api-schemas.ts`; the branch's
    schema edits were ported there during the rebase.
  - Commit 572eaf463: rebase repair, two S1 tests needed main's new required scorers field.
  - Commit 77f06ac00: the fix. TeamRef and its schema now carry sourceTeamId on the wire; the
    settings page indexes follows by permanent id (new exports indexFollows and followFor in
    `packages/sports/src/settings/index.tsx`), tiles and the toggle resolve through it, and the
    chip finds its roster entry by id. The sports-routes unit test that asserted the id does NOT
    leak was flipped on purpose (it is public data; say so in the PR comment).
  - New tests: three in `tests/unit/settings-sports-pane.test.tsx` under "follow key mismatch on a
    colliding team"; the browser test in `tests/e2e/sports-settings.spec.ts` follows Pacific
    Tigers (key pac.413) and checks highlight, crest and unfollow.
- `pnpm typecheck` exit 0 after the fix commit. Lint and unit tests NOT yet run.

## What is left (brief steps 4 and 5)

1. Run `pnpm lint` and record the exit code. Fix any prettier or eslint complaints by path.
2. Run the unit tests. The full `test:unit` fails locally on module-sdk-worker (known, green in
   CI); prefer running vitest directly on these files: tests/unit/settings-sports-pane.test.tsx,
   tests/unit/settings-sports-sources.test.tsx, tests/unit/sports-routes.test.ts,
   tests/unit/sports-source-assignment-service.test.ts, tests/unit/followed-card.test.ts,
   tests/unit/sports-page.test.tsx, plus every tests/unit/sports-*.test.ts. Record exit codes.
3. Browser test: `pnpm test:e2e tests/e2e/sports-settings.spec.ts` only if it runs without the
   live database (it mocks the API, so it should); otherwise say it was not run.
4. If anything fails, fix by path and amend nothing: add a new commit.
5. Push: `git push origin fix/review-s1-team-identity --force-with-lease` (the rebase rewrote
   history, so a plain push is rejected).
6. PR comment on 2255 headed "Fix: follow key mismatch (found by Ben on dev)" with the commit
   hashes, file:line per change, the migration number (0217, unchanged), and the exit codes.
   Use `gh pr comment 2255 --body-file`.
7. Report: `herdr agent prompt coordinator "2255 follow-key fix: <one plain sentence: commit,
   migration number, exit codes> [pane <your pane id from herdr pane list>]"`.

Relay depth is 1. Do not relay again; if the meter fires, push what is green and report.

## Relay 1 result (2026-09-04)

- Lint exit 0, typecheck exit 0, browser test tests/e2e/sports-settings.spec.ts exit 0 (7 passed,
  mocked API, own web server on port 4173, no database).
- First unit run found two red tests in this branch's own files; fixed in commit b18036f9c
  (search route fixture lacked the permanent id and 500ed on the strict schema; chip test asserted
  the full name where the chip shows the short name). Second run: 41 files, 613 tests, exit 0.
- Migration stays 0217. Pushed with --force-with-lease; PR comment posted. Lane done.
