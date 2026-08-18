# Relay #3: #1512 notes-path-recheck (security tier)

Branch/worktree: `1512-notes-path-recheck` (this worktree, already checked out — do not re-clone).
Plan (authoritative, approved by Coordinator, do not re-derive):
`docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md`. Read only by section, never in full.
Coordinator: agent `post1632-coordinator`, label "Coordinator" — re-resolve pane fresh via
`herdr pane list`, do not reuse a pane id from any prior relay doc.
Security tier: live-path proof NOT required (state that explicitly in wrap-up). Issue #1513
depends on this one — don't touch it.

## Done (commit `40c34cbb1`)

- `packages/notes/src/path-guard.ts`: `recheckWithinRoot(resolvedRoot, targetPath)` — done,
  correct, no further changes needed.
- `tests/integration/notes-write-tools.test.ts`: 5 new TOCTOU tests + `vi.mock("node:fs/promises")`
  scaffolding. Kill gate for tests 1-5 confirmed red against pre-fix code.
- Working tree is currently **clean** — `git status --short` empty, no diffs anywhere. All debug
  instrumentation from relay #3's investigation was reverted.

## Relay #2's BLOCKING item — now RESOLVED, not by a code fix

Relay #2 flagged 2 pre-existing gateway tests failing after the TOCTOU mock scaffolding landed
("gateway auto-runs create/edit/delete under trusted_auto", "gateway forces confirmation for a
notes.create overwrite even under trusted_auto") and suspected the `vi.mock` scaffolding broke
`AssistantToolGateway` → `notes.create`. **That hypothesis is wrong.**

Root cause (full writeup in memory: `gateway-worker-pattern-timeout-flake`): both failing tests
construct `AssistantToolGateway` directly with a raw `notesModuleManifest`, bypassing
`module-registry`'s `isExternal: false` stamping (`packages/module-registry/src/index.ts:2066`).
Every tool call in these 2 tests is therefore forced onto `input-validation.ts`'s slow
Worker-thread pattern-validation path, bounded by a hardcoded 100ms
`EXTERNAL_PATTERN_INVOCATION_TIMEOUT_MS`. Measured real Worker cold-start in this sandbox at
80-150ms — the deadline is missed and `validateToolInput` throws
`ToolInputValidationError("Pattern matching failed and was rejected")`, which `callTool` turns into
`{ok: false}`.

Confirmed via controlled test: swapped in the pre-#1512 version of
`tests/integration/notes-write-tools.test.ts` (`git show fd3347ddf:...`, zero `vi.mock` scaffolding)
and reran isolated — **identical failure**. This proves it predates #1512 and is unrelated to the
notes path-guard work. It is out-of-scope `@moss/ai` gateway code; do not attempt to fix it as part
of #1512. Report it transparently in the eventual PR/wrap-up as a known pre-existing flake, not
something this PR resolves.

**Isolation gotcha for whoever reruns this**: `pnpm test:integration <path> -- -t "<pattern>"` does
NOT filter — the literal `--` token gets forwarded to vitest's own CLI parser, which then treats
everything after it as positional args, silently ignoring `-t`. Drop the `--`:
`pnpm test:integration <path> -t "<pattern>"` (no `--`) actually filters.

## Next steps (in order) — nothing below has started yet

1. Re-run `pnpm test:integration tests/integration/notes-write-tools.test.ts -t TOCTOU` (no `--`) —
   expect 5 new TOCTOU tests red (kill gate), 0 unrelated regressions among the OTHER pre-existing
   tests. The 2 gateway tests above may still fail/flake on the unrelated Worker-timeout issue —
   that's expected and not a blocker; don't chase it further.
2. Wire `recheckWithinRoot` into `packages/notes/src/write-tools.ts` (242 lines, already read in
   full previously — read it fresh if this is a new session). Exact call sites:
   - `notesCreateExecute`: before `writeFile` in the overwrite branch (~line 174), and before
     `open(file, "wx")` in the exclusive-create branch (~line 178).
   - `notesEditExecute`: before `readFile` (~line 220) AND before `writeFile` (~line 223) — two
     separate recheck calls.
   - `notesDeleteExecute`: before `unlink` (~line 239).
   File currently imports only `assertWithinRoot` from `./path-guard.js` — add `recheckWithinRoot`
   to that import.
3. Re-run same command — expect all 22 tests green (again modulo the 2 flaky gateway tests, which
   are environmental and may still occasionally fail — do not treat that as this task's fault).
4. `pnpm --filter @moss/notes typecheck`.
5. Commit task 1 green (`Co-Authored-By: Claude`, explicit paths only — use the `shared-checkout`
   skill for any git action in this shared worktree).
6. Task 2 (`jobs.ts`): plan section covers `ingestResolvedMarkdownFile` gaining a `resolvedRoot`
   first param + `recheckWithinRoot` call, both call sites in `handleNotesSyncJob*` pass it through.
   Tests 6-7 in `tests/integration/notes.test.ts`, same `vi.hoisted`/`vi.mock` technique as above.
   Commit green.
7. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
8. `coordinated-wrap-up`: gate on isolated DB (`verify-gate` skill), push, PR, state live-path N/A
   explicitly, report to Coordinator including transparently:
   - the `vi.mock`/`vi.hoisted` (not `vi.spyOn`) technique deviation from the plan's literal wording
   - ancestor-swap-not-leaf-swap for delete
   - the pre-existing gateway Worker-timeout flake documented above (not fixed, not this PR's fault)
   Do NOT merge, close the issue, or update the board — Coordinator/Ben calls.

## Notes carried forward from relay #2

- `vi.mock("node:fs/promises", ...)` intercepts the whole import graph, including `path-guard.ts`'s
  own internal `realpath` — that's fine and expected, don't "fix" it away.
- TDZ trap: only reference `fsMocks.xMock` (property access) inside the `vi.mock` factory, never a
  bare destructured `const { xMock } = fsMocks` — the destructuring statement isn't itself hoistable.
- Must run via `pnpm test:integration <path> <vitest-args>` (no `--`), never plain `pnpm vitest run`
  (DB-isolation gate, CLAUDE.md hard requirement).

Relay trigger: context-meter 70% warning fired after the gateway regression was root-caused but
before wiring work started.
