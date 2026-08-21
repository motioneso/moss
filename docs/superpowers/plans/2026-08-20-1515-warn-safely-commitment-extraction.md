# Plan — #1515 / [1137-C2] Warn safely on commitment extraction failures

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §C2 (lines 159-182),
plus the C2 rows of the trust contract (239-240), acceptance table (255), and stops (294-295).
**Issue:** #1515 (task, `Part of #1137`)
**Risk tier:** routine
**Owned files:** `packages/commitments/src/extractor.ts`, `packages/commitments/src/workers.ts`,
their focused unit tests, and only the commitments `registerWorkers` block in
`packages/module-registry/src/index.ts` (lines 1850-1856).

## Seams check (file:line citations on this branch)

- `CommitmentExtractionWorkerDeps` has no logger field today —
  `packages/commitments/src/workers.ts:15-20`.
- Six failure returns already exist and are the six required emission points:
  - source provider missing — `workers.ts:35-36`
  - no configured economy summarization model — `workers.ts:39-44`
  - selected provider or encrypted credential missing — `workers.ts:46-50`
  - decrypted credential invalid — `workers.ts:52-55`
  - adapter generation throws — `packages/commitments/src/extractor.ts:29-38` (bare `catch { return []; }`)
  - generated output malformed / no candidates array — `extractor.ts:41-58` (two more `return []`
    exits: no `{`/`}` found, and `!Array.isArray(parsed.candidates)`)
- Valid `{"candidates":[]}` already returns normally through the same code path
  (`extractor.ts:47-49`) — no separate branch needed, just no warn call on that path.
- Worker-path structured-logger convention already exists and is exactly what the spec asks for:
  `BuiltInWorkerDependencies.logger?: FastifyBaseLogger` —
  `packages/module-registry/src/index.ts:587-596`; `createModuleLogger(base, module)` child-logger
  helper — `packages/module-sdk/src/logger.ts:15-17`; same wiring already used for two other
  worker-side modules — `packages/module-registry/src/index.ts:1471` (chat),
  `:1750` (news): `deps.logger ? createModuleLogger(deps.logger, "<module>") : undefined`.
- Precedent for a narrow local `warn(fields, message)` port typed independently of
  `FastifyBaseLogger` (exactly what the spec asks for — "define the port locally... do not create
  or configure another logger"): `SyncLogger` in `packages/connectors/src/sync-jobs.ts:170-173`
  (`warn(data: Record<string, unknown>, message: string): void`), with a
  `NOOP_SYNC_LOGGER` fallback at `:175-179`. Same shape, new instance — the spec forbids reusing
  connectors' own logger, not the *pattern*.
- Test precedent for unit-testing a `registerDataContextWorker`-wrapped job handler without a real
  pg-boss/DB: `tests/unit/news-jobs.test.ts:14-29` — a fake `PgBoss` whose `.work` captures the
  handler function, and a fake `DataContextRunner.withDataContext` that just calls the handler with
  a stub `DataContextDb`. This is the mechanism the new `workers.ts` failure-path tests will reuse.
- `registerDataContextWorker` signature (handler receives `job`, `scopedDb`) —
  `packages/jobs/src/pg-boss.ts:327-341`.
- `packages/module-registry/src/index.ts` is on the file-size exempt list —
  `scripts/check-file-size.ts:22` (`packages/module-registry/src/index.ts` explicitly listed) — a
  five-line deps addition there is not at risk of the 1000-line gate regardless.

No open questions — every assumption above is cited on this branch.

## Determinism / trust boundary

This is a backend logging change with no UI and no model-authored value crossing into stored user
data — the determinism-boundary section of the planning skill does not add new obligations here.
The applicable boundary is the spec's own: warning fields are a closed, stable set
(`event`, `sourceKind`, `errorName`, `errorMessage`), never free text from a prompt, model output,
or credential. `errorName`/`errorMessage` are the *only* fields sourced from a caught exception, and
they are bounded (256 chars, CR/LF stripped) before they reach the logger call.

## Live-path applicability

Not user-facing — a worker-internal warning logger with no route, UI, or response shape change.
Per the handoff doc, this is stated explicitly in the wrap-up report rather than skipped. The
spec's own acceptance table (line 255) does describe an optional live-dev-worker demonstration
(trigger one missing-model/config path, observe the single bounded warning in worker logs); that is
additional evidence to attach if a live dev worker is reachable during wrap-up, not a merge-blocking
UAT gate — there is no `tests/uat/specs/*.uat.spec.ts` requirement for this child.

## Phase 1 (only phase)

### Task 1 — extractor.ts: local warn port + two failure-class warnings

**File:** `packages/commitments/src/extractor.ts`

Add, exported for reuse by `workers.ts`:

```ts
export interface CommitmentExtractionWarnLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}
```

Add a local bounding helper (not exported — internal to the two files that need it; `workers.ts`
gets its own copy per Task 2, no shared third file):

```ts
const MAX_WARN_FIELD_LENGTH = 256;

function boundedField(value: string): string {
  return value.replace(/[\r\n]/g, "").slice(0, MAX_WARN_FIELD_LENGTH);
}

function warnErrorFields(err: unknown): { errorName: string; errorMessage: string } {
  // Decision: never index into `err` beyond name/message — a thrown object could carry extra
  // enumerable fields (e.g. an HTTP error with a response body). name/message are the only two
  // read.
}
```

Change signature (5th param, optional, default omitted = silent — matches "optional" in the spec):

```ts
export async function extractCommitmentsFromText(
  generate: ExtractorGenerateFn,
  text: string,
  sourceKind: string,
  occurredAt: string,
  warn?: CommitmentExtractionWarnLogger
): Promise<ExtractedCommitmentCandidate[]>
```

Emission points (both existing `return []` sites become `warn?.(...); return [];` — no change to
the valid-empty path):

- generate() throws → `warn?.warn({ event: "commitment-extraction-adapter-error", sourceKind, ...warnErrorFields(err) }, "commitment extraction: adapter generation failed")`
- no `{`/`}` found, JSON.parse throws, or `!Array.isArray(parsed.candidates)` → one shared event
  name `"commitment-extraction-malformed-output"`; include `warnErrorFields(err)` only on the
  JSON.parse-throw branch (the other two have no caught error to bound).

**Test file:** `tests/unit/commitment-extractor.test.ts` (existing file, add cases)

New cases, each asserting on a spy `{ warn: vi.fn() }`:

1. Prefilter miss → `warn` not called (already covered by existing test; add the assertion).
2. Valid `{"candidates":[]}` → `warn` not called.
3. `generate` throws `new Error("boom")` → `warn` called once with `event:
   "commitment-extraction-adapter-error"`, `sourceKind`, bounded `errorName`/`errorMessage`; assert
   the exact literal `"boom"` string never appears truncated/mangled but stays ≤256 chars and has no
   `\n`.
4. `generate` throws an object with a message containing `\r\n` and > 256 chars → assert output
   `errorMessage.length <= 256` and contains no `\r`/`\n`.
5. Response text `"not json"` → `warn` called once with `event: "commitment-extraction-malformed-output"`.
6. Response text `'{"candidates": "not-an-array"}'` → `warn` called once, same event.
7. Every warn-triggering case also asserts the serialized fields contain none of a small sentinel
   set (a fake prompt string, a fake credential string) — proves the port literally cannot carry
   them because they're never passed in, not just that this test forgot to check.

### Task 2 — workers.ts: deps.logger + four failure-class warnings + thread through to extractor

**File:** `packages/commitments/src/workers.ts`

Add to `CommitmentExtractionWorkerDeps`:

```ts
readonly logger?: CommitmentExtractionWarnLogger; // from ./extractor.js
```

Import `CommitmentExtractionWarnLogger` from `./extractor.js`.

At each of the four existing early-return sites, before `return;`, call `deps.logger?.warn(...)`:

| Site | event | message |
| --- | --- | --- |
| `!provider` (`:35-36`) | `commitment-extraction-source-provider-missing` | `commitment extraction: source provider missing` |
| `!model` (`:44`) | `commitment-extraction-no-model` | `commitment extraction: no configured economy summarization model` |
| `!aiProvider?.encrypted_credential` (`:50`) | `commitment-extraction-credential-missing` | `commitment extraction: selected provider or encrypted credential missing` |
| `!credential` (`:55`) | `commitment-extraction-credential-invalid` | `commitment extraction: decrypted credential invalid` |

All four fields object is exactly `{ event, sourceKind }` — no error object exists at these sites
(they're `if (!x) return`, not catches), so no `errorName`/`errorMessage` to bound.

Pass `deps.logger` as the 5th arg at the existing `extractCommitmentsFromText(...)` call site
(`:83-88`).

**Test file:** `tests/unit/commitment-worker-shape.test.ts` — rename in place to
`tests/unit/commitment-worker.test.ts` (it stops being shape-only); keep the two existing export
assertions and add behavioral cases using the `news-jobs.test.ts:14-29` fake-boss/fake-dataContext
pattern:

1. No provider matches `sourceKind` → capture handler, invoke with a stub job → `logger.warn`
   called once, `event: "commitment-extraction-source-provider-missing"`, no candidate/evidence
   repository calls made.
2. `aiRepository.selectModelForCapability` resolves `null` → one warn,
   `commitment-extraction-no-model`.
3. `aiRepository.selectProviderWithCredential` resolves an object with `encrypted_credential:
   null` → one warn, `commitment-extraction-credential-missing`.
4. `parseAiApiKeyCredential` path returns falsy (stub `cipher.decryptJson` to return a shape that
   fails `parseAiApiKeyCredential`) → one warn, `commitment-extraction-credential-invalid`.
5. Full happy path (all deps resolve, `provider.getTextBoundaries` returns one boundary, generate
   returns one valid candidate) → `logger.warn` **not** called, `repository.upsertCandidate` and
   `addEvidenceRow` both called once, `upsertExtractionState` called once — proves the four new
   warn calls didn't leak onto the success path.
6. Omit `logger` from deps entirely (undefined) on the `!provider` path → handler does not throw
   (`deps.logger?.warn` is a safe no-op) — proves the port is genuinely optional per the spec.

### Task 3 — module-registry composition root: thread the worker logger through

**File:** `packages/module-registry/src/index.ts`, lines 1850-1856 only (the commitments
`registerWorkers` block) — no other line in this file changes.

```ts
registerWorkers: async (boss, deps) =>
  registerCommitmentExtractionWorker(boss, deps.dataContext, {
    aiRepository: new AiRepository(),
    cipher: createAiSecretCipher(),
    repository: new CommitmentsRepository(),
    providers: [chatCommitmentProvider, notesCommitmentProvider],
    logger: deps.logger ? createModuleLogger(deps.logger, "commitments") : undefined
  })
```

`createModuleLogger` is already imported at `:169`. No new import needed.

**Test:** covered by existing `tests/unit/commitment-worker-shape.test.ts` export check plus
package typecheck — this block is 5 lines of composition wiring with no independent branch logic,
so no new test is added here; the existing `module-registry` package build/typecheck is the
verification (a `FastifyBaseLogger`-shaped child assigned to a `CommitmentExtractionWarnLogger`-
shaped field either compiles or doesn't).

## Kill gate

None — single phase, narrow file set, no architectural fork. If Task 2's fake-boss test harness
turns out not to reach the four early-return branches cleanly (e.g. `registerDataContextWorker`'s
`toAccessContext` throws before the handler body runs on a malformed stub job), stop and escalate
to the coordinator rather than restructuring `workers.ts` to make it more testable — that would be
scope growth the spec's non-goals section forecloses ("no ... repository abstraction ... broad
commitments refactor").

## Verification (run in order, never piped)

```bash
pnpm test:unit tests/unit/commitment-extractor.test.ts tests/unit/commitment-worker.test.ts > /tmp/1515-unit.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/module-registry typecheck > /tmp/1515-registry-typecheck.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/commitments typecheck > /tmp/1515-commitments-typecheck.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/1515-file-size.log 2>&1; echo "EXIT=$?"
```
Expected exit code for all four: `0`.

Final gate before wrap-up (per `verify-gate` skill, isolated gate DB — not run ad hoc):
```bash
pnpm verify:foundation > /tmp/1515-verify-foundation.log 2>&1; echo "EXIT=$?"
```
Expected: `0`.

## Rulings ledger

- Spec's "define the port locally... do not create or configure another logger" — read as: define
  a *new* `CommitmentExtractionWarnLogger` interface local to `extractor.ts` (not import
  connectors' `SyncLogger` or build a shared cross-module logging package), and thread the *one*
  existing `deps.logger` (the worker-path `FastifyBaseLogger` already wired into
  `BuiltInWorkerDependencies`) through it — not stand up a second, independent logger instance.
  Confirmed against the existing `chat`/`news` wiring at
  `packages/module-registry/src/index.ts:1471,1750`, which is the same pattern already applied
  twice in this file.
