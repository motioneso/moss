# Plan — nullable-object/array tool-output schema support (#1337)

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md`
**Issue:** Part of #1337
**Tier:** sensitive

## Seams check (file:line citations)

- Bug site, top-level dispatch: `packages/ai/src/gateway/output-validation.ts:112`
  (`sanitizeToolOutputValue`) — checks `schema.type === "object"` (throws on non-object incl.
  `null`, line ~114), then `schema.type === "array"`, then falls through to `getScalarTypes`
  (line ~124-129).
- Scalar `anyOf` handling that silently drops non-scalar branches:
  `packages/ai/src/gateway/output-validation.ts:172-193` (`getScalarTypes`) — filters `anyOf`
  candidates through `JSON_NON_NULL_SCALAR_TYPES` (line 176/183); an object/array branch never
  matches, `nonNullScalarTypes` is empty, function returns `[]`, caller's
  `scalarTypes.length > 0` is false, value returned unvalidated (verified live by reading the
  file — matches spec's Context section exactly).
- `JsonSchema` is `Record<string, unknown>` (`packages/module-sdk/src/index.ts:49-51`) — no
  compile-time shape guarantee, all narrowing is runtime (`isPlainObject`/`isJsonSchema`,
  `output-validation.ts:203-215`).
- Existing recursion entry points to reuse, unchanged: `sanitizeToolOutputObject`
  (`output-validation.ts:130-147`) for the object branch, and the array branch inside
  `sanitizeToolOutputValue` itself (`.map((item) => sanitizeToolOutputValue(itemSchema, item))`,
  line ~119) for the array branch — both already throw/strip correctly once reached.
- Real blocked caller (unit-fixture only, no module change): `job-search.match.get`
  (`external-modules/job-search/jarvis.module.json:391-403`) has no `outputSchema` today; return
  shape is `{ match: MatchDetail | null }`, `MatchDetail` defined
  `external-modules/job-search/src/worker/handlers/matches.ts:111-123`.
- Test file to extend: `tests/unit/ai-output-validation.test.ts` (140 lines today, direct-import
  style, no test harness beyond vitest — read in full, conventions confirmed).
- Sibling PR risk noted in spec: PR #1645 (#1279) touches `input-validation.ts` in the same
  package — different file, no shared symbol; rebase before push per plan step 4.

No platform-capability assumptions beyond what's cited above — this is a single pure-function
change with no I/O, no queue, no module-manifest change.

## Design decision

Add one new helper, `getNullableCompoundBranch`, and one new check in `sanitizeToolOutputValue`,
inserted **after** the existing object/array direct-type checks and **before** `getScalarTypes` is
consulted — so it only fires for schemas that declare `anyOf` (bare `{type:"object"}` and
`{type:"array"}` behavior at lines 112-122 is untouched, satisfying the non-goal on input
validation / scalar `anyOf` / manifest format being out of scope).

```ts
function getNullableCompoundBranch(schema: JsonSchema): JsonSchema | null {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2) return null;
  const branches = schema.anyOf.filter(isJsonSchema);
  if (branches.length !== 2) return null;
  const nullBranch = branches.find((candidate) => candidate.type === "null");
  const otherBranch = branches.find((candidate) => candidate !== nullBranch);
  if (!nullBranch || !otherBranch) return null;
  const isObjectBranch = otherBranch.type === "object" && isPlainObject(otherBranch.properties);
  const isArrayBranch = otherBranch.type === "array" && isJsonSchema(otherBranch.items);
  return isObjectBranch || isArrayBranch ? otherBranch : null;
}
```

Insertion point in `sanitizeToolOutputValue` (after the existing array `if` block, before the
`const scalarTypes = getScalarTypes(schema);` line):

```ts
const nullableBranch = getNullableCompoundBranch(schema);
if (nullableBranch) {
  return value === null ? null : sanitizeToolOutputValue(nullableBranch, value);
}
```

Why a separate helper instead of extending `getScalarTypes`: `getScalarTypes` returns a list of
_scalar type names_ consumed by `JSON_SCALAR_TYPE_OF` — object/array aren't scalar types and don't
fit that return shape. Keeping the compound case as a distinct branch that recurses through
`sanitizeToolOutputValue` reuses the existing object/array sanitization (required-key checks,
allow-list projection, array-item recursion) instead of duplicating it, and leaves the scalar path
byte-for-byte unchanged — the exact boundary the non-goals section draws.

Non-goal check: any `anyOf` that is not exactly 2 branches, or whose non-null branch is neither
`object` (with `properties`) nor `array` (with `items`), falls through unchanged to
`getScalarTypes` / existing pass-through behavior — no behavior change for other `anyOf` shapes,
consistent with "no general anyOf/oneOf support" and "leave silent pass-through for other
unrecognized anyOf shapes, record a follow-up issue" (recorded below, not built here).

## Tasks

**Task 1 — implement `getNullableCompoundBranch` + wire it into `sanitizeToolOutputValue`.**
File: `packages/ai/src/gateway/output-validation.ts`. Exact signature and insertion point as
above. No other function's behavior changes.

**Task 2 — tests in `tests/unit/ai-output-validation.test.ts`** (append to the existing
`describe("sanitizeAssistantToolResult", ...)` block, following its existing style):

1. `"accepts null for a declared nullable-object field"` — schema
   `{ type: "object", required: ["match"], properties: { match: { anyOf: [{ type: "object", required: ["id"], properties: { id: { type: "string" } } }, { type: "null" }] } } }`,
   data `{ match: null }` → `sanitized.data` equals `{ match: null }`. Would fail against current
   code with the pass-through bug masked (passes today too since null object passes through
   unvalidated — this test alone doesn't prove the fix; test 2 does).
2. `"sanitizes the non-null branch of a declared nullable-object field, stripping undeclared keys"`
   — same schema as above, data `{ match: { id: "m1", secret: "x" } }` → asserts
   `sanitized.data.match` equals `{ id: "m1" }` and
   `Object.prototype.hasOwnProperty.call(sanitized.data.match, "secret")` is `false`. **This is
   the test that fails on unpatched code** (today `secret` passes through untouched because the
   `anyOf` branch is silently unvalidated) — proves the sanitizer recurses, not passes through.
3. `"rejects an invalid object on a declared nullable-object field"` — same schema, data
   `{ match: { secret: "x" } }` (missing required `id`) → `expect(...).toThrow(/missing required
output field "id"/)`. Fails on unpatched code (currently doesn't throw — passes through).
4. `"accepts null and sanitizes the non-null branch of a declared nullable-array field"` — schema
   `{ type: "object", required: ["items"], properties: { items: { anyOf: [{ type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } }, { type: "null" }] } } }`;
   two assertions in one test or two tests: `{ items: null }` → `{ items: null }`; and
   `{ items: [{ id: "m1", secret: "x" }] }` → `{ items: [{ id: "m1" }] }` (undeclared key
   stripped — proves array-branch recursion, not just null-passthrough).
5. `"leaves existing scalar anyOf and bare object/array schemas unchanged"` — no new test strictly
   required (existing 6 tests in the file already pin this), but run the **full existing suite**
   as regression proof (task 3, gate step) rather than re-asserting here.
6. `"validates the job-search match.get nullable-detail shape end-to-end"` — unit-level fixture
   schema mirroring `MatchDetail` (`external-modules/job-search/src/worker/handlers/matches.ts:111-123`):
   `{ type: "object", required: ["match"], properties: { match: { anyOf: [{ type: "object", required: ["id","title","company","url","body","fit","want","fitReason","wantReason","outsideFrame","scoredAt","state"], properties: { id: {type:"string"}, title: {type:"string"}, company: {type:"string"}, url: {type:"string"}, body: {type:"string"}, fit: {anyOf:[{type:"number"},{type:"null"}]}, want: {anyOf:[{type:"number"},{type:"null"}]}, fitReason: {type:"string"}, wantReason: {type:"string"}, outsideFrame: {type:"boolean"}, scoredAt: {anyOf:[{type:"string"},{type:"null"}]}, state: {type:"string"} } }, { type: "null" }] } } }`.
   Two cases: `{ match: null }` → `{ match: null }`; and a full valid `MatchDetail` object with one
   undeclared extra key → the extra key is stripped from `sanitized.data.match`. This is the
   spec's "job-search match.get shape validates end-to-end" exit criterion — fixture only, no
   `external-modules/job-search` file touched.

**Task 3 — gate.** Run task-scoped tests first, then the full pre-push trio + full unit suite
(commands below). Commit task 1+2 together (implementation and its tests land in one green
commit, per TDD — write test 2/3 first, watch them fail against unpatched code, then add task 1
and watch green, per `superpowers:test-driven-development`).

## Determinism boundary

N/A — no UI, no model turn, no user-facing surface. Pure synchronous validation function.

## Kill gate

Phase 1 is the only phase (single-file, single-lane fix, spec explicitly scopes to one
lightweight table-spec item). Kill/rework call: if task 2's tests 2/3 (the pass-through-proof
tests) pass _before_ task 1 lands, the seams check above was wrong about the current bug and the
lane stops to re-verify against the spec's Context section rather than proceeding — owner: build
agent, escalate to Coordinator if it happens.

## Deferred (recorded, not built)

Spec non-goal: whether the silent pass-through for _other_ unrecognized `anyOf` shapes should
become an explicit rejection is left open, contingent on proving it's behavior-preserving for
every shipped/staged module schema — out of scope for this lane. If worth pursuing, file as a
follow-up issue at wrap-up time (report to Coordinator; this build agent does not open issues).

## Verification commands

```bash
pnpm exec vitest run tests/unit/ai-output-validation.test.ts > /tmp/vf-ai-output.log 2>&1; echo "EXIT=$?"
# expected EXIT=0, all tests in the file passing (existing 8 + new ~6-7)
```

```bash
pnpm format:check > /tmp/vf-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/vf-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/vf-typecheck.log 2>&1; echo "EXIT=$?"
# expected EXIT=0 for all three (pre-push trio)
```

```bash
git fetch origin main && git rebase origin/main
# expected: rebase succeeds, no conflicts (no shared file with PR #1645/#1279 per spec's
# dependency note)
```

Full gate (`pnpm verify:foundation` on an isolated gate DB) happens at `coordinated-wrap-up` per
its own recipe — not duplicated here.
