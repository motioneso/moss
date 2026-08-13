# Plan — #1274 external-module trust lint (security tier)

No separate spec doc per handoff (`docs/coordination/handoffs/2026-08-13-1274-external-module-trust-lint.md`):
scoped fix, build off issue text. Task issue: #1274 (`security` label).

## Problem (from `gh issue view 1274`)

`compilePattern` (packages/ai/src/gateway/input-validation.ts:66) fails CLOSED at call time: an
external module's declared tool `inputSchema.pattern` that doesn't compile makes every call to
that tool fail with `ToolInputValidationError`. But nothing lints a pattern's validity at
**install time** — a broken pattern isn't discovered until first use, and until then the manifest
looks accepted. Ask: lint every declared `pattern` in a module's assistant-tool `inputSchema`s
at install time using the exact same compile check `compilePattern` uses, and reject the manifest
if any fails.

## Seams check (file:line citations)

- `compilePattern` is the canonical compile-validity check: bare probe `new RegExp(pattern, "u")`
  then anchored `new RegExp(`^(?:${pattern})$`, "u")`, catch → throw `ToolInputValidationError`.
  packages/ai/src/gateway/input-validation.ts:66-87.
- It has **zero runtime deps** — only `import type { JsonSchema, ToolInput } from "@moss/module-sdk"`
  at input-validation.ts:1 (type-only, erased at compile time). Confirmed no `node:*` and no other
  imports in that file.
- It's already exported from `@moss/ai`'s barrel: gateway/index.ts:17
  (`export { validateToolInput, ToolInputValidationError, compilePattern }`) →
  re-exported at packages/ai/src/index.ts:37 (`export * from "./gateway/index.js"`).
- BUT `@moss/ai`'s `"."` entry (packages/ai/package.json exports, only `"."` today) barrels in
  real node-only runtime (fastify routes, better-auth, pg-boss, crypto — e.g.
  packages/module-registry/src/index.ts:1 already imports `node:crypto`/`node:fs` alongside
  `@moss/ai` value imports). validate.ts is explicitly documented as NOT allowed to pull that in:
  packages/module-registry/src/external/validate.ts:1,6 — "Pure, browser-safe validation... No
  node:\* imports here — this is re-exported from @moss/module-registry's browser entry."
  Importing `compilePattern` from bare `"@moss/ai"` would violate that invariant.
- Existing precedent for a narrow subpath export to dodge exactly this problem: `@moss/host-fetch`
  exports both `"."` and `"./policy": "./src/policy.ts"` (packages/host-fetch/package.json), and
  validate.ts already consumes the narrow one: `import { assertValidFetchHosts } from
"@moss/host-fetch/policy"` (validate.ts:22). Same pattern applies here.
- Manifest shape: `ExternalModuleAssistantToolDeclaration.inputSchema?: JsonSchema`
  (packages/module-sdk/src/external-module.ts:190); `JsonSchema = { [key: string]: unknown }`
  (packages/module-sdk/src/index.ts:48) — untyped at the type level, so the lint walker must
  treat it as `unknown` and check shapes defensively, same style as the rest of validate.ts.
- Current assistantTools validation loop (no inputSchema handling today — confirmed via
  `grep -n "inputSchema" packages/module-registry/src/external/validate.ts` → no matches):
  packages/module-registry/src/external/validate.ts:638-671 (`for (const entry of
obj.assistantTools)` … `validateAssistantToolPolicy(tool, assistantActionFamilies, errors)` at
  line 669).
- Runtime recursion shape to mirror: `SchemaNode` recurses via `properties` (object) and `items`
  (array), and checks `pattern` only on string fields — input-validation.ts:18-27, 153-165. The
  lint walker mirrors the same recursion (`pattern` + `properties` + `items`, not
  `anyOf`/`oneOf`/`allOf`/`$ref` — issue marks those "optional... if/when those become enforced",
  matching `validateToolInput`'s documented unenforced set at input-validation.ts:179-183). Note
  (Fable, non-blocking): the walker is intentionally slightly stricter than runtime — it lints
  every node carrying a `pattern` key regardless of whether that node's `type` is `"string"`,
  while `validateValue` only ever reaches `pattern` on confirmed string-typed values. That's the
  right direction for a trust lint (reject more at install time, not less) and not a mismatch to
  fix.
- Test harness precedent: tests/unit/external-validate.test.ts:184-227 already exercises
  `assistantTools[].inputSchema` with `{ type: "object" }` manifests — same file, same pattern for
  new cases.

## Task 1 — narrow subpath export for `compilePattern`

**File:** `packages/ai/package.json`

Change:

```json
"exports": {
  ".": "./src/index.ts",
  "./gateway/input-validation": "./src/gateway/input-validation.ts"
}
```

No other file in `packages/ai/src/gateway/input-validation.ts` changes — it already fails closed
and is already exported from the barrel; this task only adds the browser-safe narrow path.

**Verify:** `pnpm --filter @moss/ai typecheck > /tmp/1274-t1.log 2>&1; echo "EXIT=$?"` — expect 0.

## Task 2 — install-time pattern lint in validate.ts

**File:** `packages/module-registry/src/external/validate.ts`

Add import:

```ts
import { compilePattern } from "@moss/ai/gateway/input-validation";
```

Add a recursive walker (new top-level function, placed near `validateAssistantToolPolicy`):

```ts
function lintToolInputSchemaPatterns(
  schema: unknown,
  path: string,
  errors: string[],
  depth: number
): void;
```

Signature contract:

- `schema: unknown` — defensive, matches `JsonSchema = { [key: string]: unknown }`.
- `path: string` — dotted path for the error message (e.g. `acme.lookup.inputSchema.properties.key`).
- `errors: string[]` — same accumulator every other validator in this file uses.
- `depth: number` — recursion guard; bail (push nothing, just return) past depth 12. Mirrors this
  file's existing style of bounding untrusted external-module input (queues>16, schedules>32,
  reconcileJobs>8 — validate.ts:271,330,387). Prevents a pathological nested manifest schema from
  blowing the stack at install time.

Behavior:

- Not an object (or is an array, or `null`) → return (nothing to check).
- `schema.pattern` is a string → `try { compilePattern(schema.pattern) } catch { errors.push(...) }`.
  Error message: `` `assistant tool inputSchema pattern at ${path} is invalid: ${schema.pattern}` ``.
- `schema.properties` is a non-array object → recurse into each value at
  `${path}.properties.${key}`, depth+1.
- `schema.items` is present → recurse at `${path}.items`, depth+1.

Call site: inside the existing `for (const entry of obj.assistantTools)` loop
(validate.ts:638-671), right after the existing `if (!isNonEmptyString(tool.handler))` check
(line 670-671), guarded the same way every other per-tool check is — no early return, just push
onto the shared `errors` array:

```ts
if (tool.inputSchema !== undefined) {
  lintToolInputSchemaPatterns(
    tool.inputSchema,
    `${String(tool.name ?? "?")}.inputSchema`,
    errors,
    0
  );
}
```

**Verify:** `pnpm --filter @moss/module-registry typecheck > /tmp/1274-t2.log 2>&1; echo "EXIT=$?"`
— expect 0.

## Task 3 — tests

**File:** `tests/unit/external-validate.test.ts`

Add cases (same `base` fixture + `runtime`/`assistantTools` shape as the existing worker-tool
tests at lines 184-227):

1. **Rejects an unparseable pattern** — `inputSchema: { type: "object", properties: { key: {
type: "string", pattern: "[a-z" } } }` (unbalanced bracket, throws on bare `new RegExp`).
   `expect(result.ok).toBe(false)`; `errors.join(" ")` contains `"pattern"` and the literal
   `"[a-z"`.
2. **Rejects the anchor-escape pattern from the compilePattern doc comment** —
   `pattern: "[a-z]+)|(.*"`. This does NOT compile bare — `new RegExp(pattern, "u")` throws
   `Unmatched ')'` — it's the anchored/wrapped form that would silently compile if only the
   anchored probe ran. The bare probe is exactly what catches this case (per `compilePattern`'s
   doc comment, input-validation.ts:52-60); same rejection assertion as case 1.
3. **Accepts a valid pattern** — `pattern: "[a-z]+"` → `expect(result.ok).toBe(true)`.
4. **Rejects a pattern nested under array `items`** —
   `inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string",
pattern: "(" } } } }` → rejected, proving the walker recurses into `items`, not just top-level
   `properties`.
5. **Manifest with no `inputSchema` still accepts** (regression guard — reuses the existing
   accept case at lines 184-204, unmodified, confirms the new check is opt-in per tool).

**Verify:** (run from repo root, no `--filter` — `tests/unit/*.test.ts` run this way, per Fable)

```bash
pnpm exec vitest run tests/unit/external-validate.test.ts > /tmp/1274-t3.log 2>&1; echo "EXIT=$?"
```

— expect 0, all new cases passing, no existing case broken.

## Kill gate

Owner: this build lane, evaluated by the coordinator before wrap-up. If Task 2's walker cannot be
written without either (a) importing something from `@moss/ai`'s barrel (violating validate.ts's
browser-safe invariant) or (b) duplicating `compilePattern`'s logic in two places, STOP and
escalate to the coordinator with the concrete blocker — do not silently pick (b). (The subpath
export in Task 1 is designed to make this a non-issue; if it doesn't typecheck cleanly for some
unforeseen reason, that's the fork to raise, not paper over.)

## Determinism / scope note

No UI/user-facing surface — this is install-time manifest validation only, pure functions, no
model calls, no chat turns. Live-path gate (UAT) does not apply; the exit criterion is the test
suite proving install-time rejection (handoff's stated exit criteria) plus full gate green.

## Out of scope (per issue, explicitly optional/future)

Numeric `minimum`/`maximum`, `additionalProperties`, `anyOf`/`oneOf`/`allOf` — not linted here.
`outputSchema` — issue only asks about tool `inputSchema`s; `outputSchema` isn't runtime-enforced
by `validateToolInput` at all, so linting it would invent a new trust boundary the issue didn't ask
for.

## Collision note

Per handoff: #1275 (same `compilePattern`/pattern-cache file) serializes AFTER this lane. This
plan does not touch `input-validation.ts`'s logic at all (only adds a package.json export path),
so it should not conflict with #1275's eventual change — flagging in case the coordinator wants to
confirm that reading before releasing the serialization gate.
