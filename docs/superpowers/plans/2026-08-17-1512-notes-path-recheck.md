# Plan: #1512 [1137-B1] Recheck notes paths immediately before filesystem I/O

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Issue: #1512 (security tier, child of #1137). Handoff:
`docs/coordination/handoff-1512-notes-path-recheck.md` (recovered via
`git show 729034040:...` — absent from `origin/main`/this branch's history; content verified
against live Coordinator pane `w1:pCJ` session id match).

## Seams check (file:line citations, this branch)

- `packages/notes/src/path-guard.ts` — today only exports `NotesPathError` and the **sync**,
  purely-lexical `assertWithinRoot(resolvedRoot, absoluteFilePath)`. No realpath-based recheck
  exists yet. Confirmed by full read this session.
- `packages/notes/src/write-tools.ts:150-241` — three `ToolExecute`s. Multi-await gaps between
  the last containment check and the vulnerable syscall, confirmed by full read:
  - `notesCreateExecute` overwrite branch: `resolveExistingFile` (await lstat+realpath) →
    `writeFile(file, ...)` at line 174. `file` is the unresolved `join(root, rel)` string, never
    re-derived from a fresh realpath.
  - `notesCreateExecute` exclusive branch: `assertInside(root, resolvedParent)` (line 166) →
    `open(file, "wx")` at line 178. Same unresolved `file` string.
  - `notesEditExecute`: `resolveExistingFile` returns resolved `file` (line 219) → `readFile(file,
...)` (line 220, currently tight) → ... → `writeFile(file, ...)` (line 223, genuine gap: a
    `content.split`/`.replace` and no re-check).
  - `notesDeleteExecute`: `resolveExistingFile` (line 238) → `unlink(file)` (line 239) — already
    tight, but spec still requires an explicit recheck call here for consistency/defense-in-depth.
- `packages/notes/src/jobs.ts:143-215` — `ingestResolvedMarkdownFile(scopedDb, actorUserId,
resolvedFile, repository, embeddingProvider, chunkOffset, chunkLimit, expectedFileHash)`, first
  statement `readFile(resolvedFile, "utf-8")` at line 153. Does **not** currently receive
  `resolvedRoot` — needs a new required param.
  - Call site 1: `handleNotesSyncJob`, ~line 307 `assertWithinRoot(resolvedRoot, resolvedFile)`
    then ~line 317 `ingestResolvedMarkdownFile(...)`. `resolvedRoot` in scope (declared line 249).
  - Call site 2: `handleNotesSyncJobWithDataContext`, line 452
    `resolveAndValidateNoteFile(resolvedRoot, absolutePath)` (itself does realpath+assertWithinRoot,
    `jobs.ts:217-224`) then ~line 461 `ingestResolvedMarkdownFile(...)` — this one crosses a
    `dataContextRunner.withDataContext(...)` await boundary, the genuine gap. `resolvedRoot` in
    scope (declared line 409).
  - Fixing the shared function once, plus threading `resolvedRoot` through both call sites,
    satisfies the spec table's "covering both worker handlers" without duplicating the guard call.
- Existing test coverage: `tests/integration/notes-write-tools.test.ts` (495 lines, full read)
  `"rejects traversal and symlink escape"` (lines 442-495) — covers symlinks already in place
  _before_ the tool call starts, i.e. today's upfront checks. It does **not** exercise the
  post-check, pre-syscall window this task closes, so it does not by itself prove B1's guard is
  necessary or correct — new tests are additive, not a replacement.
- `tests/integration/notes.test.ts` (949 lines, grepped) — `describe("assertWithinRoot", ...)` at
  line 44, `describe("handleNotesSyncJob", ...)` at line 337, both `handleNotesSyncJob` and
  `handleNotesSyncJobWithDataContext` call sites present (lines 391-919 range) with an existing
  `makeJob`/`provider`/`prefsRepo` fixture pattern to reuse for new worker-race tests.

No new dependency, no fd-based traversal, no migration — confirmed nothing in the above requires
any of those.

## Decision: new guard function

Add to `packages/notes/src/path-guard.ts`:

```ts
export async function recheckWithinRoot(resolvedRoot: string, targetPath: string): Promise<void>;
```

**Superseded during QA remediation** (Opus adversarial QA on PR #1671 found this walk-upward
design produces a false pass when a symlinked directory component precedes a lexical `..` — the
kernel resolves `..` against the already-dereferenced path, not the literal text; see
`packages/notes/src/path-guard.ts`'s `canonicalizeAsFarAsExists` for the shipped kernel-accurate
replacement and its docstring for the full mechanism). The `NotesPathError` messages are NOT
host-path-free: `assertWithinRoot` embeds both the absolute path and the resolved root in its
thrown message. Callers that persist this message across the API boundary (`jobs.ts`'s
`lastErrorMessage`, flowing to the `notes-last-sync` preference) now sanitize it via
`sanitizedErrorMessage()` instead of relying on the message being safe by construction.

## Decision: call-site insertions (zero intervening `await` between guard and syscall)

`packages/notes/src/write-tools.ts`:

1. Overwrite branch — insert `await recheckWithinRoot(root, file);` immediately before line 174
   (`writeFile`).
2. Exclusive-create branch — insert immediately before line 178 (`open(file, "wx")`).
3. `notesEditExecute` — insert immediately before line 220 (`readFile`) **and** a second call
   immediately before line 223 (`writeFile`); two separate calls, not reused across the gap.
4. `notesDeleteExecute` — insert immediately before line 239 (`unlink`).

`packages/notes/src/jobs.ts`: 5. `ingestResolvedMarkdownFile` gains a new first param `resolvedRoot: string`; insert
`await recheckWithinRoot(resolvedRoot, resolvedFile);` as the function's first statement,
before line 153 (`readFile`). Update both call sites (~line 317, ~line 461) to pass
`resolvedRoot` (already in scope at both).

No other files change. No existing check is removed.

## Test cases (behavior + why they'd fail against a broken/unfixed implementation)

All new cases live in `tests/integration/notes-write-tools.test.ts` (create/edit/delete) and
`tests/integration/notes.test.ts` (worker path), reusing each file's existing DB/mkdtemp fixture
pattern. Race is simulated deterministically via `vi.spyOn` on an fs call that legitimately still
runs _before_ the new last-moment guard (`mkdir`, `lstat`, or `resolveExistingFile`'s internals) —
never on the guarded syscall itself, since a swap injected inside the guarded syscall's own mock
happens too late to be observable by any guard. The spy performs the symlink swap synchronously
against real disk, then calls through to the real implementation.

1. **Create (overwrite), ancestor swapped after `mkdir`, before `writeFile`.** Spy on `mkdir` to
   swap the target's parent directory to a symlink pointing outside the notes root after the real
   `mkdir` resolves. Assert `notesCreateExecute` rejects with `HttpError`/`NotesPathError`-derived
   400, and the outside path gains no new file. Against unfixed code (no recheck before
   `writeFile`), this swap succeeds silently — the test fails closed only with the guard in place.
2. **Create (exclusive), same swap point before `open(..., "wx")`.** Same construction, asserting
   `open` never targets the swapped location.
3. **Edit, target swapped after `resolveExistingFile` before `readFile`.** Spy on `lstat` (used
   inside `resolveExistingFile`) to perform the swap after the initial `lstat`/`realpath` resolve
   but before `readFile` executes. Assert no outside file is read (spy asserts it's never opened)
   and the call rejects.
4. **Edit, target swapped after `readFile` before `writeFile`.** Existing in-root file read
   succeeds; between read and write, swap the target to a symlink outside root (direct disk call
   in the test body — this gap has no fs primitive to spy on other than the guard itself, so the
   swap happens via a `vi.spyOn` on `readFile`'s resolved promise continuation, i.e. swap
   synchronously right after `readFile` resolves and before the test yields control back).
   Assert `writeFile` never touches the outside path and the call rejects. This is the row that
   proves the two-recheck requirement (edit needs it before **both** I/O calls) is real: a
   single recheck before `readFile` alone would pass this case incorrectly.
5. **Delete, target swapped after `resolveExistingFile` before `unlink`.** Same shape as case 3,
   asserting the outside path is never unlinked.
6. **Worker path, `handleNotesSyncJob`, file swapped after `assertWithinRoot` (line ~307) before
   `ingestResolvedMarkdownFile`'s `readFile`.** Spy on `collectMarkdownFiles` or the loop's own
   `lstat`/`realpath` step to inject the swap after the handler's own upfront check but before the
   shared ingest function runs. Assert outside content is never read/embedded/indexed.
7. **Worker path, `handleNotesSyncJobWithDataContext`, file swapped during the
   `dataContextRunner.withDataContext(...)` await (the pre-fix gap at line ~452-461).** Spy on
   `resolveAndValidateNoteFile` (or the fs call inside it) to swap after it resolves, before the
   `withDataContext` callback reaches `ingestResolvedMarkdownFile`. Assert same outcome.
8. **Happy path retained/added**: ordinary in-root create (both branches), edit, delete, and both
   worker handlers on an untouched in-root file still succeed unchanged — regression guard that
   the new recheck doesn't false-positive on legitimate paths (existing happy-path tests in both
   files already cover this; confirm they still pass, no new cases needed unless a gap is found
   while writing 1-7).

## Kill gate

After task 1 (guard function + `write-tools.ts` create/edit/delete call sites + tests 1-5, 8
happy-path subset) is green: **owner = build agent (self)**, kill/re-scope condition = if any of
tests 1-5 cannot be made to fail against the pre-fix code (i.e. the "swap before guard" spy
doesn't actually reach the vulnerable window — proving the existing gap isn't real), stop and
escalate to the Coordinator with the actual finding before touching `jobs.ts`. Do not proceed to
the worker-path task on an unconfirmed premise.

## Verification (unpiped, exit code stated)

```bash
pnpm --filter @moss/notes typecheck > /tmp/1512-typecheck.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm vitest run tests/integration/notes-write-tools.test.ts > /tmp/1512-wt.log 2>&1; echo "EXIT=$?"  # expect 0
pnpm vitest run tests/integration/notes.test.ts > /tmp/1512-notes.log 2>&1; echo "EXIT=$?"           # expect 0
```

Full gate (`verify:foundation`, isolated gate DB) run at wrap-up per `verify-gate` skill, not
before.

## Live-path gate

**Corrected during QA remediation**: a plan cannot override the spec's own acceptance row (Opus
adversarial QA on PR #1671, blocking finding 3). Spec `2026-08-10-1137-robustness-followups.md`
§B1 requires a live-path proof; "no UI surface" does not exempt it — the assistant create/edit/
delete tools and the notes sync worker are both reachable from the real chat UI on a live dev
instance. Status: **code-complete, unverified** — live-path proof not yet produced. Next step for
whoever picks this up: configure a disposable in-root notes source on a live dev instance, exercise
real assistant create/edit/delete calls plus a sync run through the actual chat UI, and confirm
(a) legitimate in-root operations still succeed and (b) the settings payload's `notes-last-sync`
error field never surfaces a host path (exercise a real `NotesPathError` case, e.g. point the
assistant at a path outside the configured root, and read the settings response). Avoid pasting
literal host paths or outside-root file content into the PR evidence itself.

## Residual risk (acknowledged, out of scope for #1512)

`canonicalizeAsFarAsExists` resolves symlinks but does not defend against hardlinks or bind mounts:
a hardlink inside the notes root pointing at inode content outside it, or a bind-mounted directory
swapped in at the OS level, both present as an ordinary (non-symlink) file/directory to `lstat` and
pass containment. Neither is reachable through the assistant tools or sync worker without
filesystem-level access outside this application's control surface (i.e., an attacker who can
already create hardlinks/bind-mounts on the host has broader access than this guard is scoped to
defend against). Noted per Opus adversarial QA on PR #1671 (non-blocking finding D) as an
acknowledged residual, not a defect to fix in this lane.

## Open items for Coordinator review

- Live-path proof (spec B1) is the one remaining blocking item before this lane can merge; see
  "Live-path gate" above for the concrete next step. Everything else QA flagged (3 blocking + 4
  non-blocking findings on PR #1671) has been fixed and committed on this branch.

## Addendum (relay 8): live-path proof scope decision

The "Live-path gate" section's suggested trigger ("point the assistant at a path outside the
configured root") does not reach `NotesPathError`/`recheckWithinRoot` — `requireMarkdownPath()`
(`write-tools.ts:27`) synchronously rejects absolute/`..`-traversal input first, with an earlier,
different `HttpError(400, "path must be a relative Markdown path")`. Confirmed by fresh read this
relay of `path-guard.ts` and `write-tools.ts` in full.

Two chat-reachable ways to hit the actual target string `"path is not within the linked notes
source"`, both confirmed present in the current `write-tools.ts`:

1. `rejectSymlinkParent()` (`write-tools.ts:124-141`) — pre-seed a symlinked ancestor directory
   inside the notes root, then have the assistant create/edit a note through it via real chat.
   Synchronous, deterministic, no race. Throws the same message string directly.
2. The literal `NotesPathError` → `sanitizedErrorMessage()` (`jobs.ts:43-44`) →
   `notes-last-sync.lastError` chain — confirmed it returns the same string for `NotesPathError`
   specifically. Only reachable via a genuine TOCTOU race in the sync job's per-file loop (swap a
   file for a symlink between the `readdir` walk and the loop reaching it); `collectMarkdownFiles`
   uses lstat-based `Dirent` info, so a symlink placed before sync starts is silently excluded from
   the walk, not a trigger. Not cleanly forceable through pure UI action.

**Coordinator ruling (blocking correction to the above, applied)**: the original (b)+(c) proposal
gave zero live coverage of #1512's actual change. `rejectSymlinkParent` only walks `dirname(rel)`
(the parent directories) — it never calls `recheckWithinRoot`/`NotesPathError` and is pre-existing
code, not this PR's guard. Only `recheckInside` (→ `recheckWithinRoot` → `canonicalizeAsFarAsExists`)
reaches the new logic, and it runs against the **leaf path itself**
(`notesCreateExecute`'s non-overwrite branch, `write-tools.ts:189`, immediately before
`open(file, "wx")`). A leaf-level symlink escape is deterministically live-forceable, not a TOCTOU
race: pre-seed `$ROOT/S -> outside` and `$ROOT/b.md -> S/../evil.md` (the exact case covered by
`tests/integration/notes.test.ts:98-105`, "rejects a lexical .. escape through a symlinked
directory"), then ask the assistant via real chat to create a note at `b.md`. `recheckWithinRoot`
resolves through `S`, pops via `..` to the real parent of `outside` (kernel-accurate, not lexical),
lands outside root, throws `NotesPathError` → `HttpError(400, "path is not within the linked notes
source")`. Synchronous, repeatable, no race.

**Final scope**: live UAT proof covers (a) legitimate in-root create/edit/delete/sync via real
chat, succeeding; (b) `rejectSymlinkParent` ancestor-directory refusal live via real chat; and
(c') the symlinked-leaf-file refusal above live via real chat — this is the only live proof of
#1512's actual guard and is non-optional. The **only** remaining test-only substitute, narrowly
scoped: the sync-worker's `collectMarkdownFiles` (`jobs.ts:116-128`) uses lstat-based `Dirent`
info and silently excludes symlinks from its `readdir` walk, so a symlink swapped in _after_ the
walk but _before_ the loop reaches that file is a genuine `readdir`→`realpath` TOCTOU race with no
deterministic UI trigger — that sliver alone is proven by the existing
`tests/integration/notes.test.ts` `recheckWithinRoot` unit tests (re-run fresh, output cited in
the PR comment). State this precisely and narrowly in the PR comment; do not generalize the
"unforceable" claim to (b) or (c').
