# Plan — #2177 generator auto-policy rule

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
**Grounding:** issue #2177, Fable ruling https://github.com/motioneso/moss/issues/2177#issuecomment-5500476440
**Risk tier:** low (docs + persona text + unit test only; no validator change)

## Seams check

- Validator rule already exists and is unchanged by this plan:
  `packages/module-registry/src/external/validate.ts:176-179` — `executionPolicy === "auto"` with
  no matching declared family pushes exactly `'assistant tool executionPolicy "auto" requires an
actionFamilyId'`.
  `packages/module-registry/src/external/validate.ts:180-183` — family found but its
  `allowedTiers` lacks `"trusted_auto"` pushes a different message.
  `packages/module-registry/src/external/validate.ts:167-172` — any `actionFamilyId` that doesn't
  match a declared family in `assistantActionFamilies` pushes
  `` `assistant tool references undeclared action family: ${tool.actionFamilyId}` ``.
- Family shape (for the passing test case): `validateActionFamilies` at
  `packages/module-registry/src/external/validate.ts:91-149` requires `id` (lowercase identifier),
  `label`, `description`, `allowedTiers` (non-empty, from `ACTION_PERMISSION_TIERS`, includes
  `defaultTier`), `defaultTier` (`"ask_each_time"` or `"always_confirm"`).
- Persona file locked by the ruling: `apps/worker/src/module-build-live-agent.ts:41-50` — the
  `.join("\n")` array of persona-line strings, same seam as the two #2169 lines already there
  (lines 48-49).
- Dev-guide file locked by the ruling: `docs/module-developer-guide.md` §11 (lines 332-346),
  same seam as the two #2169 bullets already there.
- Test file locked by the ruling: `tests/unit/external-validate.test.ts`, same pattern as the
  #2169 case at line 509 (`describe`/`it` block using `base`, `validateExternalModuleManifest`,
  checking `result.ok` and `result.errors`).

## Task 1 — persona lines (`apps/worker/src/module-build-live-agent.ts`)

Append two new strings to the array at lines 41-50, after the existing fetchHosts line (49):

```
"An assistantTools entry may set executionPolicy \"auto\" only if it also sets actionFamilyId to a family declared in assistantActionFamilies whose allowedTiers includes \"trusted_auto\"; otherwise omit executionPolicy or use \"confirm\", and never set executionPolicy on a read-only tool.",
"Any actionFamilyId you set on a tool must match the id of a family you declared in assistantActionFamilies."
```

## Task 2 — dev guide (`docs/module-developer-guide.md` §11)

Add two bullets after the existing `fetchHosts` bullet (ends line 345), before the `## 12` heading:

```
- A tool's `executionPolicy: "auto"` requires `actionFamilyId` to name a declared
  `assistantActionFamilies` entry whose `allowedTiers` includes `"trusted_auto"`; otherwise omit
  `executionPolicy` or use `"confirm"` (read-only tools should not set `executionPolicy` at all).
  Violating this fails with `requires an actionFamilyId` or `requires family ... to allow
  trusted_auto`.
- Any `actionFamilyId` must match a family id declared in `assistantActionFamilies`, or the build
  fails with `references undeclared action family`.
```

## Task 3 — regression test (`tests/unit/external-validate.test.ts`)

One new `it` block after the #2169 case (after line 534), following the same `base` manifest
pattern:

- Case A (fails): `assistantTools: [{ name: "acme-widgets.lookup", ..., executionPolicy: "auto" }]`
  with no `actionFamilyId` and no `assistantActionFamilies` → `result.ok === false`, errors join
  contains `"requires an actionFamilyId"`.
- Case B (passes): same tool with `executionPolicy: "confirm"`, no `actionFamilyId` →
  `result.ok === true`.
- Case C (passes): same tool with `executionPolicy: "auto"`, `actionFamilyId: "acme-widgets.write"`,
  plus a declared `assistantActionFamilies` entry `{ id: "acme-widgets.write", label: "Write",
description: "Write access", allowedTiers: ["trusted_auto", "ask_each_time"], defaultTier:
"ask_each_time" }` (defaultTier must appear in allowedTiers, per
  `packages/module-registry/src/external/validate.ts:137-139`) → `result.ok === true`.

No model prose asserted; no validator or generator repair-loop change.

## Verification (unpiped, exit code checked)

```bash
pnpm vitest run tests/unit/external-validate.test.ts tests/unit/worker-module-build-step-runner.test.ts > /tmp/2177-focused.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Then the normal gate via the `verify-gate` skill (not run directly/piped).

## Kill gate

If the focused vitest run above does not reach `EXIT=0` after one fix attempt, stop and escalate
to the coordinator rather than iterating — the ruling scopes this to exactly one rule, no repair
loop.

## Out of scope

No validator change, no generator repair loop, no self-check pass, no derived rule list, no live
proof (owed by PR #2101, not this lane).
