# Plan — #1589 Phase 1b: NUL bytes must not reach `app.memory_chunks`

**Spec:** `docs/superpowers/specs/2026-08-15-1589-job-failure-incident-closure.md` (Phase 1b only)
**Issue:** #1589 (`task` label confirmed present)
**Branch:** `build-1589-phase1b`
**Risk tier:** `sensitive` — standard QA + explicit invariant check + matched e2e-UAT; no Ben
merge sign-off required.

## Seams check (re-verified against this branch)

| Claim                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                       | Status                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| No sanitization at the `memory_chunks` insert                                       | `packages/memory/src/repository.ts:73-81` — `chunk.text` bound directly into the `INSERT`                                                                                                                                                                                                                                                                      | confirmed                                                     |
| `upsertFileChunks` deletes-then-inserts, so a throw on insert can leave zero chunks | `packages/memory/src/repository.ts:66-69` (`replaceExisting` calls `deleteFileChunks` first, then loops inserts)                                                                                                                                                                                                                                               | confirmed — this is the data-loss path the spec calls out     |
| An existing boundary-sanitization pattern exists in the repo                        | `packages/chat/src/attachments-service.ts:89-97` (`sanitizeAttachmentFileName`, strips `\u0000-\u001F` with `no-control-regex` eslint-disable)                                                                                                                                                                                                                 | confirmed, used as the style precedent                        |
| `sourcePath` is validated against `\0` on one path                                  | `packages/notes/src/write-tools.ts:27-39` (`requireMarkdownPath` rejects `input.includes("\0")`)                                                                                                                                                                                                                                                               | confirmed, but only for the AI-facing notes-write tool        |
| All three `upsertFileChunks` call sites pass a `sourcePath` that cannot carry a NUL | `packages/memory/src/ingest.ts:65-72` (`relativePath` from `listVaultFilesRecursive`, filesystem-sourced — a NUL cannot appear in a path the OS already resolved); `packages/notes/src/jobs.ts:182` (`resolvedFile`, reached via a prior successful `readFile`, same filesystem argument); `packages/chat/src/jobs.ts:104` (`threadId`, a UUID, not user text) | confirmed — no call site's `sourcePath` is freeform user text |

**Decision on `sourcePath`:** no sanitization added. Every current caller's `sourcePath` is either
filesystem-sourced (the OS already rejects `\0` in a path before the code reaches this point) or a
UUID. The one path that does accept AI-supplied path text (`requireMarkdownPath`) already rejects
`\0` explicitly. Only `chunk.text` — free-form note content — needs the strip.

## Task 1 — sanitize chunk text at the repository boundary

**File:** `packages/memory/src/repository.ts`

Add a module-level function, placed next to `toVectorLiteral`:

```ts
function sanitizeChunkText(text: string): string;
```

Behavior (decision, not implementation): strip the C0 control range `U+0000`–`U+001F` **except**
`\t` (`U+0009`), `\n` (`U+000A`), `\r` (`U+000D`). Concretely the strip set is
`\u0000-\u0008`, `\u000B`, `\u000C`, `\u000E-\u001F` — same shape as
`sanitizeAttachmentFileName`'s regex, narrowed to preserve the three whitespace controls (chunk
text carries multi-line note content; a filename does not). Carries the same
`no-control-regex` eslint-disable as the precedent, with a one-line comment stating the strip is
intentional.

In `upsertFileChunks`, the `INSERT` currently binds `${chunk.text}` directly (line 79). Change it
to bind `${sanitizeChunkText(chunk.text)}`. No other line in the method changes.

## Task 2 — test cases (integration, real Postgres)

**File:** `tests/integration/memory.test.ts`, inside the existing `describe("MemoryRepository", …)`
block (after the existing `upsertFileChunks` tests around line 204), reusing the existing `repo`,
`provider`, and `makeChunks` helper already defined in that block.

Three `it` blocks, stated as behavior:

1. **`upsertFileChunks strips NUL bytes so the insert does not throw`** — build a chunk whose text
   contains `"before\u0000after"`, call `upsertFileChunks`, then `SELECT text FROM
app.memory_chunks WHERE source_path = …`. Assert the stored text is `"beforeafter"` (NUL
   removed) and the row exists. Against the unfixed code this throws Postgres `22021` (`invalid
byte sequence for encoding "UTF8"`) and the `it` fails on the throw, not on the assertion —
   this is the regression the spec's root-cause comment recorded.
2. **`upsertFileChunks does not lose existing chunks when a re-ingested file introduces a NUL
byte`** — call `upsertFileChunks` once with N clean chunks (`replaceExisting` default `true`),
   then call it again for the same `sourcePath` with N chunks where one now contains a NUL byte.
   Assert the table still holds N rows for that path afterward. Against the unfixed code the
   second call's `deleteFileChunks` succeeds, the first insert of the loop throws on the NUL chunk,
   and the method exits with the file at 0 chunks — silent data loss, the specific case the spec
   says is worse than "the insert succeeds".
3. **`upsertFileChunks preserves tab, newline, and carriage return in chunk text`** — chunk text
   `"line one\tcol\nline two\r\n"`, assert the stored text is byte-identical after round-trip.
   Against an over-broad strip (e.g. reusing `sanitizeAttachmentFileName`'s full `\u0000-\u001F`
   range unmodified) this assertion fails because `\t`/`\n`/`\r` are stripped too.

## Verification

```bash
pnpm test:memory > /tmp/test-memory-1589.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. (`test:memory` self-isolates to a fresh `jarvis_test_<random>` database via
`scripts/test-integration.ts`'s `createDatabaseIsolationPlan` unless `JARVIS_PGDATABASE` is set in
the environment — confirmed at `scripts/test-integration.ts:14-23` — so no manual gate-DB export
is needed for this scoped run.)

Pre-push trio + full gate at wrap-up, per `coordinated-build`/`coordinated-wrap-up` (fresh exported
gate DB via the `verify-gate` skill, not improvised):

```bash
pnpm format:check && pnpm lint && pnpm typecheck
pnpm verify:foundation > /tmp/vf-1589.log 2>&1; echo "EXIT=$?"
```

## Live-path proof (exit criterion 4)

Not satisfiable through the normal chat UI directly (no UI surface lets a user paste a raw NUL
byte into note text through a browser text field — browsers strip it). Plan: exercise the real
ingest path on a live dev instance — write a vault file containing a literal NUL byte via a script
using the same `notes.sync`/`MemoryIngestPipeline` code path the running dev worker uses, trigger
sync through the dev instance, then query `app.memory_chunks` on the dev DB and record the row
count and stored text in the PR as the live-path evidence. If the running dev worker cannot be
reached this way, report **code-complete, unverified** rather than claim proof that wasn't taken.

## Kill gate

None needed — single non-forking task, no phase 2 dependency, no product/architecture fork. If
`pnpm test:memory` cannot run (no reachable Postgres in this environment), escalate to the
coordinator rather than skip verification.

## Exit criteria covered by this lane

- Spec exit criterion 2 (NUL-byte persistence, 3 test cases, executed and observed passing).
- Spec exit criterion 3 (full local gate green, `verify-gate` skill, at wrap-up).
- Spec exit criterion 4 (live-path proof posted on the PR).
- Exit criteria 1 (Ben-only prod verification) and 5 (Phase 2 split, already recorded as #1634 per
  the handoff's collision notes) are out of scope for this lane.
