# Relay #2: #1512 notes-path-recheck (security tier)

Branch/worktree: `1512-notes-path-recheck` (this worktree, already checked out — do not re-clone).
Plan (authoritative, approved by Coordinator, do not re-derive):
`docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md`.
Coordinator: agent `post1632-coordinator`, label "Coordinator" — re-resolve pane fresh via
`herdr pane list`, do not reuse a pane id from this doc.
Security tier: live-path proof NOT required (state that explicitly in wrap-up). Issue #1513
depends on this one — don't touch it.

## Done (commit `40c34cbb1`)

- `packages/notes/src/path-guard.ts`: `recheckWithinRoot(resolvedRoot, targetPath)` — done,
  correct, no further changes needed.
- `tests/integration/notes-write-tools.test.ts`: 5 new TOCTOU tests + `vi.mock("node:fs/promises")`
  scaffolding (`fsMocks = vi.hoisted(...)`, factory sets passthrough defaults at module-load).
  **Kill gate for tests 1-5 satisfied** — confirmed red against pre-fix code for the right reason
  (resolved values show the cross-boundary write/delete actually happened). Full run log:
  `/tmp/1512-killgate5.log`.

## BLOCKING — read this before touching write-tools.ts

The same kill-gate run also broke 2 **pre-existing, unrelated** tests:
- "gateway auto-runs create/edit/delete under trusted_auto" (line ~161)
- "gateway forces confirmation for a notes.create overwrite even under trusted_auto" (line ~213)

Both fail at `expect(created.ok).toBe(true)` → receiving `false`. Confirmed via
`pnpm test:integration tests/integration/notes-write-tools.test.ts -- -t "gateway auto-runs create"`
(isolated, no TOCTOU tests running alongside) — **still fails alone**, exit 1. So this is not
test-interaction or a pre-existing flake — it's the `vi.mock("node:fs/promises", ...)` scaffolding
itself breaking the `AssistantToolGateway` → `notes.create` path specifically (both failing tests
go through `gateway.callTool`; the passing create/edit/delete tests call
`notesCreateExecute`/etc. directly). Gateway appears to catch the underlying error and return
`{ok: false}` instead of throwing — the direct-call tests would instead see a rejected promise,
which is why this didn't show up until the mock was fully wired.

**Not yet root-caused.** Hypotheses to check first, cheapest first:
1. Log/inspect the full `created` object (not just `.ok`) to see what error the gateway captured.
2. Check whether `write-tools.ts`'s *existing* (pre-recheck) containment check already calls
   `realpath` on a not-yet-existing path (ENOENT-and-walk-up, same shape as `recheckWithinRoot`)
   — if so, check whether `fsMocks.realpathMock.mockImplementation(actual.realpath)` loses
   something (`this` binding, error `.code`/prototype) that this existing code path depends on
   but the direct-call tests happen not to exercise the same way.
3. Try isolating with a `console.error` in the mock's realpath override to see call args across
   both a passing direct-create test and a failing gateway-create test, diff them.

**Do not wire `recheckWithinRoot` into `write-tools.ts` until this is resolved** — you'd be adding
more `realpath` calls into a path that's already misbehaving under the mock, muddying signal
further. Fix the mock (or find the real root cause) first, confirm all ~17 pre-existing tests +
5 new TOCTOU tests are simultaneously green/red-as-expected, *then* proceed to wiring.

## Next steps (in order)

1. Root-cause + fix the gateway regression above.
2. Re-run `pnpm test:integration tests/integration/notes-write-tools.test.ts -- -t TOCTOU` — expect
   5 new tests red (kill gate), 0 unrelated regressions.
3. Wire `recheckWithinRoot` into `write-tools.ts` (plan has exact call sites: create
   overwrite before `writeFile`, create exclusive before `open(file,"wx")`, edit before `readFile`
   AND before `writeFile` — two separate calls, delete before `unlink`).
4. Re-run same command — expect all 22 tests green.
5. `pnpm --filter @moss/notes typecheck`.
6. Commit task 1 green (`Co-Authored-By: Claude`, explicit paths only — see `shared-checkout` skill).
7. Task 2 (`jobs.ts`): plan section covers `ingestResolvedMarkdownFile` gaining a `resolvedRoot`
   first param + `recheckWithinRoot` call, both call sites in `handleNotesSyncJob*` pass it through.
   Tests 6-7 in `tests/integration/notes.test.ts`, same `vi.hoisted`/`vi.mock` technique as above
   (once fixed). Commit green.
8. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
9. `coordinated-wrap-up`: gate on isolated DB (`verify-gate` skill), push, PR, state live-path
   N/A explicitly, report to Coordinator (mention the mock-technique deviation from the plan's
   literal wording — `vi.mock`/`vi.hoisted` not `vi.spyOn`, ancestor-swap not leaf-swap for delete
   — both are correct, just note them transparently). Do not merge/close/board.

## Notes for whoever picks this up

- `vi.mock("node:fs/promises", ...)` intercepts the whole import graph, including `path-guard.ts`'s
  own internal `realpath` — that's fine and expected, don't "fix" it away.
- TDZ trap: only reference `fsMocks.xMock` (property access) inside the `vi.mock` factory, never a
  bare destructured `const { xMock } = fsMocks` name — the destructuring statement isn't itself
  hoistable so it stays below the (hoisted) factory. Destructured names are safe everywhere else.
- Must run via `pnpm test:integration <path> -- <vitest-args>`, never plain `pnpm vitest run`
  (DB-isolation gate, CLAUDE.md hard requirement).

Relay trigger: context-meter 70% warning fired mid-investigation of the gateway regression above.
