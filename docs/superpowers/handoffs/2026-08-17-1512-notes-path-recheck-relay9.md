# Relay 9: #1512 notes-path-recheck — run the UAT spec, post live-path proof

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` — "Addendum (relay 8)" has the
Coordinator-approved scope (also quoted below, you don't need to re-read the plan for scope).
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, this worktree.
Coordinator: resolve fresh by label "Coordinator" (pane id reflows — do not reuse a baked id).
**Coordinator has asked to be messaged directly by pane label when the proof comment is posted —
do not wait for it to notice a status flip.**

## State: UAT spec WRITTEN, formatted, linted clean, and COMMITTED + PUSHED (`818b80961`)

`tests/uat/specs/notes-path-recheck.uat.spec.ts` covers the Coordinator-approved scope:
- **(a)** legitimate in-root create/edit/delete via real chat, plus a poll on
  `/api/me/notes-last-sync` proving the created note was indexed.
- **(b)** `rejectSymlinkParent` (`write-tools.ts:124-141`, pre-existing ancestor-dir check) refused
  live: seeds `$ROOT/D-<stamp> -> /tmp/uat-1512-b-target-<stamp>` (real dir), asks chat to create
  `D-<stamp>/x.md`, asserts `role="status"` text `Not changed — path is not within the linked
  notes source`.
- **(c')** the ACTUAL #1512 guard (`recheckInside` → `recheckWithinRoot` →
  `canonicalizeAsFarAsExists`) refused live: seeds `$ROOT/S-<stamp> -> /tmp/uat-1512-c-outside-<stamp>`
  (real dir) and `$ROOT/b-<stamp>.md -> "S-<stamp>/../evil-<stamp>.md"`, asks chat to create
  `b-<stamp>.md`, asserts the same refusal text. Mirrors `tests/integration/notes.test.ts:98-105`.
- Final assertion: full chat-thread `innerText()` does not match `/\/tmp\/|\/data\/vaults/` — no
  host path ever leaked to the browser.

Also added the corresponding row to `.claude/skills/coordinate/uat-trigger-map.tsv`.

**Neither the spec's execution (`pnpm test:uat notes-path-recheck`) nor a typecheck of the new file
has been run yet.** That is your first job.

## Approved scope (Coordinator ruling, do not re-litigate)

Live UAT proof, all via real chat on a live dev/UAT instance:
- **(a)** legitimate in-root create/edit/delete/sync succeeds.
- **(b)** `rejectSymlinkParent` refuses live via real chat.
- **(c')** the ACTUAL #1512 guard refuses live via real chat.
- **Only narrow test-only carve-out**: `jobs.ts`'s `collectMarkdownFiles` (lines 100-135) is
  Dirent/lstat-based and silently excludes symlinks from the sync-worker's `readdir` walk, so a
  symlink swapped in *after* the walk but *before* the loop reaches it is a genuine
  readdir→realpath TOCTOU race with no deterministic UI trigger. Proven instead by re-running
  `tests/integration/notes.test.ts` fresh and citing output. **Do not generalize this
  "unforceable" language to (b) or (c') — those ARE live-forceable and must be proven live.**

## Concrete next steps

1. **Typecheck the new file first** (cheap, catches drift fast): `pnpm typecheck` (or the
   package-scoped equivalent) covering `tests/uat/specs/notes-path-recheck.uat.spec.ts`. Note
   project memory `pnpm-filter-typecheck-tsrootdir-false-red.md` — a `--filter` run can false-red;
   cross-check against root `pnpm typecheck` if a package-filtered run looks red.
2. Run `pnpm test:uat notes-path-recheck`, capture full **unpiped** output + exit code (the
   `check-gate-pipe.sh` hook blocks piping a gate command — redirect to a log file and check `$?`
   explicitly, e.g. `pnpm test:uat notes-path-recheck > /tmp/uat-1512.log 2>&1; echo "EXIT=$?"`,
   then read the log with a bounded `Read`).
   - This is a **real-chat-model-driven** spec — the model must reliably emit tool calls with the
     exact literal paths instructed. If a turn doesn't produce the expected tool call, the prompt
     text (not the guard code, not the assertion) is the most likely thing to iterate on. Check
     project memory `uat-scripted-provider-never-ran.md` before assuming the chat harness itself
     is broken — it documents a real prior failure mode here.
   - Also check `uat-moss-container-name-collision.md` — run `docker ps -a | grep -x moss` before
     the run; an orphaned stack under that exact name blocks ALL UAT runs.
3. Re-run `pnpm vitest run tests/integration/notes.test.ts` fresh, capture unpiped output — this is
   ONLY for the jobs.ts TOCTOU-sliver citation (not a substitute for (b)/(c'), which must be proven
   live).
4. Re-read `docs/DEVELOPMENT_STANDARDS.md` → "Live-Path Gate" if needed: no screenshots, executable
   assertions + bounded textual evidence, redact any host paths.
5. Post proof: `gh pr comment 1671 --body-file <tmpfile>` (NOT `gh pr edit` — known to silently
   fail on this repo, see project memory `gh-pr-edit-body-silently-fails.md`). The comment should
   include: the UAT spec file + its (a)/(b)/(c') coverage, the `pnpm test:uat notes-path-recheck`
   exit code + relevant excerpt, the integration-suite re-run excerpt scoped to the jobs.ts
   citation, and an explicit statement that (b)/(c') were proven live (not the TOCTOU-sliver
   language).
6. **Message the Coordinator pane directly by label "Coordinator"** (re-resolve fresh via
   `herdr pane list` — do not reuse `w1:pEF` without re-confirming it's still the sole match) once
   the proof comment is posted: PR #1671 proof posted, re-QA needed, not merging/closing/moving
   board. Per the Coordinator's own instruction (received relay 8→9), do this proactively — it is
   watching on a longer interval and is not relying on noticing a status flip.
7. If a live instance genuinely can't be gotten running, state "code-complete, unverified" plainly
   rather than overclaiming.

## Do NOT

- Merge, close #1512, or move the board.
- Re-fix any of the 7 already-addressed QA remediation findings.
- Use screenshots for the live-path proof.
- Generalize the jobs.ts "unforceable TOCTOU" language to (b) or (c') — both are live-forceable
  and the Coordinator will reject a comment that soft-pedals them as race-only.
- Silently re-scope again without Coordinator sign-off.
- Use `gh pr edit` for the proof — use `gh pr comment --body-file` only.
