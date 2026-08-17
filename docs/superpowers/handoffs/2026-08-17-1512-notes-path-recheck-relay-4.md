# Relay #4: #1512 notes-path-recheck (security tier)

Branch/worktree: `1512-notes-path-recheck` (this worktree, already checked out — do not re-clone).
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` (read only by section).
Coordinator: label "Coordinator" — **re-resolve pane fresh via `herdr pane list`**, never reuse a
pane id from any prior relay doc.
Security tier: live-path proof NOT required (state that explicitly in wrap-up).

## Tree state

Working tree is clean at commit `4a12e7005`. **No source edits this session** —
`packages/notes/src/write-tools.ts` and `packages/notes/src/path-guard.ts` are both still exactly
as committed in `40c34cbb1`. Nothing has been wired yet.

## CORRECTION to relay #3's claim — read this before doing anything else

Relay #3 asserted `path-guard.ts`'s `recheckWithinRoot` is "done, correct, no further changes
needed." **That is wrong.** Verified this session by importing and directly executing the real
function (not a reimplementation) via `npx tsx` against a constructed dangling-symlink scenario —
output: `NO ERROR THROWN — attack NOT caught`. Full defect writeup + reproduction steps + the fix
approach: memory `recheckwithinroot-dangling-symlink-gap` (read it before touching the file).

One-line summary: `recheckWithinRoot`'s ENOENT-fallback walks up via `dirname()` on the *original
literal* path. That's correct for "file doesn't exist yet" but wrong when the target itself exists
as a symlink whose destination is missing — `realpath` ENOENTs there too, but the walk-up silently
discards the symlink hop and lands back on the real (in-root) parent, returning success. This is
exactly TOCTOU test 4's scenario in `tests/integration/notes-write-tools.test.ts` (edit: target
swapped to a dangling symlink between `readFile` and `writeFile`) — test 4 will NOT pass against
the current `recheckWithinRoot`, no matter how correctly it's wired into `write-tools.ts`.

Tests 1/2/5 (parent-directory swaps to a symlink pointing at an *existing* `outside` dir) are
**not** confirmed to share this defect — `realpath` on those succeeds (resolves to `outside`,
which exists) rather than ENOENTing, so they may go through the normal `assertWithinRoot` check
correctly. Not separately re-verified this session; worth a quick sanity check once the fix lands.

## Next steps (in order)

1. **Fix `path-guard.ts`'s `recheckWithinRoot` first.** On `realpath(current)` ENOENT, `lstat`
   `current` instead of assuming "doesn't exist": if `lstat` also ENOENTs, the old dirname-walk-up
   is correct (component truly absent). If `lstat` succeeds and the result `isSymbolicLink()`,
   `readlink(current)`, resolve it against `dirname(current)` if relative, and continue the check
   from *that* resolved location — do not fall back to the original path's syntactic parent in
   that case. Add a regression test for this directly in a path-guard unit test if one exists, or
   rely on TOCTOU test 4 as the kill gate.
2. Re-run `pnpm test:integration tests/integration/notes-write-tools.test.ts -t TOCTOU` (no `--`
   — that token breaks vitest's `-t` filter, confirmed by relay #3). Expect all 5 TOCTOU tests red
   still (recheckWithinRoot isn't wired into write-tools.ts yet) but confirm test 4 would pass in
   isolation against the fixed function (a quick tsx probe is fine for this, cheaper than the full
   suite).
3. Wire `recheckWithinRoot` into `packages/notes/src/write-tools.ts` (already imports
   `assertWithinRoot` from `./path-guard.js`; add `recheckWithinRoot` to that import). Exact call
   sites, wrap/catch `NotesPathError` → `HttpError(400, "path is not within the linked notes
   source")` (mirror the existing `assertInside` helper, lines 96-102):
   - `notesCreateExecute`: before `writeFile` in the overwrite branch (~line 174), and before
     `open(file, "wx")` in the exclusive-create branch (~line 178).
   - `notesEditExecute`: before `readFile` (~line 220) AND before `writeFile` (~line 223) — two
     separate recheck calls.
   - `notesDeleteExecute`: before `unlink` (~line 239).
4. Re-run same command — expect all 22 tests green. 2 gateway tests
   ("...trusted_auto...") may still flake — that's [[gateway-worker-pattern-timeout-flake]],
   pre-existing, unrelated, do not chase further (root-caused in relay #3, see memory).
5. `pnpm --filter @moss/notes typecheck`.
6. Commit task 1 green (`Co-Authored-By: Claude`, explicit paths only — `shared-checkout` skill
   for any git action in this shared worktree).
7. Task 2 (`jobs.ts`): plan section covers `ingestResolvedMarkdownFile` gaining a `resolvedRoot`
   first param + `recheckWithinRoot` call, both call sites in `handleNotesSyncJob*` pass it
   through. Tests 6-7 in `tests/integration/notes.test.ts`, same `vi.hoisted`/`vi.mock` technique.
   Commit green.
8. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
9. `coordinated-wrap-up`: gate on isolated DB (`verify-gate` skill), push, PR — **flag SECURITY
   TIER clearly in the PR body**, needs Opus adversarial QA + Fable-5 sign-off before merge (Ben's
   standing delegation) — never routine auto-merge. State live-path N/A explicitly. Report to
   Coordinator transparently noting:
   - the `recheckWithinRoot` dangling-symlink defect found+fixed this relay (link the memory)
   - the `vi.mock`/`vi.hoisted` (not `vi.spyOn`) technique deviation from the plan's literal wording
   - ancestor-swap-not-leaf-swap for delete
   - the pre-existing gateway Worker-timeout flake (not fixed, not this PR's fault)
   Do NOT merge, close the issue, or update the board — Coordinator/Ben calls.
10. Report to the Coordinator when the PR is open via `herdr-pane-message`.

## Notes carried forward

- `vi.mock("node:fs/promises", ...)` intercepts the whole import graph including `path-guard.ts`'s
  own internal `realpath`/`lstat`/`readlink` calls — expected, don't "fix" it away. If the
  `recheckWithinRoot` fix adds new `lstat`/`readlink` calls, the existing test mocks may need
  those functions added to the `vi.hoisted` mock set.
- TDZ trap: only reference `fsMocks.xMock` (property access) inside the `vi.mock` factory, never a
  bare destructured `const { xMock } = fsMocks`.
- Must run via `pnpm test:integration <path> <vitest-args>` (no `--`), never plain `pnpm vitest
  run` (DB-isolation gate, CLAUDE.md hard requirement).

Relay trigger: context-meter 70% warning fired immediately after confirming the dangling-symlink
defect via the tsx probe, before any fix or wiring work started.
