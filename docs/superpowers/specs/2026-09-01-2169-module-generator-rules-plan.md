# Plan — module generator manifest rules (#2169)

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md` (Stage 2 sections only)
**Issue:** #2169, `Part of #1902`
**Ruling grounding:** https://github.com/motioneso/moss/pull/2101#issuecomment-5491449098
**Risk tier:** sensitive (module build/distribution pipeline)

## Seams check (file:line, verified on this branch at `886aaa772`)

- Guide section 11 exists and does not state either rule today —
  `docs/module-developer-guide.md:332-338`.
- The live-agent persona array that needs both rules —
  `apps/worker/src/module-build-live-agent.ts:39-49` (the `deps.io.writeFile(personaPath, [...])`
  call).
- The tool-name/permission-id prefix check already enforced by the validator (unchanged; docs/persona
  catch it earlier) — `packages/module-registry/src/external/validate.ts:648-656`
  (`assistant tool names must be prefixed with "${expectedId}."` / same for `permissionId`).
- The `fetchHosts` check already enforced by the validator (unchanged) —
  `packages/module-registry/src/external/validate.ts:729-739`, calling
  `assertValidFetchHosts` at `packages/host-fetch/src/policy.ts:6-14`, which throws
  `External source "${sourceId}" declares no fetchHosts` on an empty array.
- Existing regression suite for this validator, pattern to follow —
  `tests/unit/external-validate.test.ts` (`describe("validateExternalModuleManifest (#917)", ...)`,
  base fixture at lines 5-13, worker-tool prefix precedent at lines 477-502). No existing test
  covers `fetchHosts` — confirmed via `grep -n fetchHosts tests/unit/external-validate.test.ts`
  (no hits).
- Both rules are validator-enforced already; this issue is a documentation/prompt gap, not a
  validator gap. No change to `validate.ts` or `policy.ts` (ruling: "Do not relax `validate.ts`
  prefix checks").

No new platform capability is assumed. No UI surface, no new module, no migration — the
determinism-boundary and mockup gates in `plan-build` do not apply.

## Task 1 — guide section 11 states both rules

File: `docs/module-developer-guide.md`, section `## 11. AI integration` (currently lines 332-338).

Insert two rule bullets after the existing paragraph (exact rule text, not paraphrased from the
validator so a doc reader gets the literal constraint):

- Every `assistantTools[].name` and `assistantTools[].permissionId` must be prefixed with
  `"<moduleId>."` (enforced in `validateExternalModuleManifest`; an unprefixed name/id fails the
  build).
- Any declared external data source's `fetchHosts` must be a non-empty array of lowercase
  hostnames (no ports, no IP literals); an empty or missing array fails the build.

No other section changes.

## Task 2 — module-build-live-agent persona carries both rules

File: `apps/worker/src/module-build-live-agent.ts:39-49`.

Add two lines to the persona string array (same file, same array, before the closing
`.join("\n")`), stating the two rules in the same imperative voice as the existing five lines,
e.g.:

- `"Every assistantTools entry's name and permissionId must start with \"<your module id>.\" (for example \"acme-widgets.lookup\"), or the build fails validation."`
- `"Any external data source you declare must list fetchHosts as a non-empty array of lowercase hostnames (no ports, no IPs), or the build fails validation."`

Exact wording finalized at implementation time; the two constraints and their consequence
("build fails validation") are the contract. No other line in the array changes, and the array
stays a flat list of imperative strings (no restructuring the persona builder).

## Task 3 — one focused regression check for both rules

File: `tests/unit/external-validate.test.ts`, new `it(...)` appended after the existing
`"rejects unprefixed and duplicate worker tools"` case (current lines 477-502), inside the same
top-level `describe`.

Test: `"rejects a generated-module-shaped manifest with an unprefixed tool name and an empty fetchHosts array (#2169)"`.

- Build one manifest object shaped like the real failure: `...base`, a valid
  `runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 }`, one
  `assistantTools` entry with an **unprefixed** `name`/`permissionId` (mirrors the PR #2101 live
  proof), and `fetchHosts: []`.
- Call `validateExternalModuleManifest(manifest, "acme-widgets", "0.1.0")`.
- Assert `result.ok === false`.
- Assert `result.errors.join(" ")` contains `"prefixed"` (tool-name/permission-id rule) and
  contains `"fetchHosts"` (empty-array rule) — both substrings the current validator already
  emits, so this test is a regression check on validator behavior the docs/persona now describe,
  not new validator logic.

This is the one check the issue asks for — both rules, one test, reusing the existing
`validateExternalModuleManifest` entry point and the existing test file's fixture/pattern. No new
validation system, no second fixture file.

## Verification

```bash
pnpm vitest run tests/unit/external-validate.test.ts > /tmp/2169-vitest.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, new test passes alongside all existing cases in that file.

```bash
pnpm format:check > /tmp/2169-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/2169-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/2169-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` for each, before push.

Full gate at wrap-up time via the `verify-gate` skill (never run `pnpm verify:foundation`
directly, never piped).

## Live-path note

This change has no user-facing UI surface — it edits a doc, a build-time persona prompt, and a
unit test. The "live path" for this fix is functional, not visual: the next live module-build run
(PR #2101's owed re-proof, out of scope here) exercises whether the persona change actually stops
the generator from emitting an unprefixed tool name / empty `fetchHosts`. This PR cannot itself
produce that proof without running a real module-build live-agent session, which is out of scope
per the issue ("Do not change PR #2101 as part of this issue" / this issue's job is the generator
fix, not the re-proof). Report status as code-complete with the regression test as the automated
proof; the sensitive-tier live re-proof is explicitly PR #2101's owed follow-up per the issue's
Acceptance section, not this PR's.

## Kill gate

After Task 3's test is green: if the test cannot be made to fail against the pre-change persona/doc
text in a dry run (i.e., it turns out the validator already fully blocks this and no doc/persona
change is needed), stop and escalate to the coordinator rather than landing a no-op — that would
mean the issue's premise is stale. Owner: this build agent, escalate before Task 4/wrap-up.

## Out of scope (explicit)

- `packages/module-registry/src/external/validate.ts`, `packages/host-fetch/src/policy.ts` — no
  changes; both rules are already enforced there.
- PR #2101's worktree/branch/diff — untouched.
- `apps/ai/src/module-build/*` (`write-plan.ts`, `run-build-step.ts`, `start-build.ts`,
  `classify-draft-change.ts`) — checked, none reference tool-name/fetchHosts rules or persona text;
  no change needed.
