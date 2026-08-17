# Post-#1632 queue — group C: nullable-object tool-output schema support

**Date:** 2026-08-16
**Run:** `docs/coordination/post1632-queue-2026-08-16.md`
**Issues:** #1337
**Status:** DRAFT — Ben's 2026-08-17 comment on #1252 confirms his approval of the batch's
Group A spec; whether it extends to this Group C file needs one line of scope confirmation via
the Coordinator's channel. Drafted by Fable 5 under the overnight delegation.

## Context

Single sensitive-tier item, root cause fully diagnosed in the issue — same lightweight table-spec
treatment as `2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`.

`sanitizeToolOutputValue` in `packages/ai/src/gateway/output-validation.ts` cannot express "object
or null". A tool whose result field is a nullable object hits one of two failure modes:

- Declared as `anyOf: [{type:"object",...}, {type:"null"}]`: the `anyOf` branch filters through
  `JSON_NON_NULL_SCALAR_TYPES` (line 163), objects don't qualify, the filtered list is `[]`, and
  the value **passes through unvalidated** — the sanitizer silently stops doing its job on exactly
  the compound values it matters most for.
- Declared as bare `{type:"object"}`: legitimate `null` throws at lines 106-108.

Concrete blocked case: job-search `match.get` returns `{ match: MatchDetail | null }` and cannot
declare its output schema honestly today. Related: #1336.

## Goals

- A tool output field declared `anyOf: [<object-or-array schema>, {type:"null"}]` is properly
  validated: `null` is accepted, and a non-null value is recursed into and sanitized against the
  non-null branch — never passed through unvalidated.

## Non-goals

- No general `anyOf`/`oneOf`/union support beyond the exactly-one-non-null-branch-plus-null
  shape. Arbitrary multi-branch unions remain rejected/unsupported as today.
- No change to input validation (`input-validation.ts`), the scalar `anyOf` handling that already
  works, or the tool manifest schema format.
- The current silent-pass-through for other unrecognized `anyOf` shapes should become an explicit
  rejection **only if** that is provably behavior-preserving for every schema shipped by current
  first-party and staged modules; otherwise leave it and record a follow-up issue. (The silent
  pass-through is the dangerous half of this bug — but flipping it can break live tools, so it's a
  deliberate check, not an unconditional change.)

## Architecture and scope

| Issue | Tier      | Intended files                                                                          | Smallest implementation                                                                                                                                                                                                                                                     |
| ----- | --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1337 | sensitive | `packages/ai/src/gateway/output-validation.ts`; tests in `tests/unit/ai-output-validation.test.ts` | In the `anyOf` handling, before the scalar filter: detect the two-branch nullable pattern (`{type:"null"}` plus exactly one object-or-array schema). If the value is `null`, accept; otherwise recurse `sanitizeToolOutputValue` into the non-null branch. All other `anyOf` shapes keep today's behavior. |

## Exit criteria

- Tests grown in `tests/unit/ai-output-validation.test.ts`: nullable-object schema with `null`
  passes; with a valid object passes **and is sanitized** (assert a disallowed extra field is
  actually stripped/rejected by the recursion — proving it no longer passes through unvalidated);
  with an invalid object rejects; nullable-array variant covered; existing scalar `anyOf` and bare
  `{type:"object"}` behavior unchanged.
- The job-search `match.get` output schema shape (`{ match: <object> | null }`) validates
  end-to-end (unit-level fixture matching the real manifest shape is sufficient; no job-search
  module change in this lane).
- No lane changes AccessContext, adds a migration, or crosses a module boundary.
- PR carries a release-note sentence or states plainly it is not user-visible (internal
  validation hardening; user-visible only as "modules can now return 'no result' honestly").
- Sensitive tier: coordinated-build QA pass before merge; issue + board updated after merge.

## Dependency and merge order

Independent single lane. Note: PR #1645 (#1279) touches the sibling `input-validation.ts` in the
same package — no shared file, but rebase on current `main` after it merges. No serialization
against groups A or B, except the trivial note that group A's #1252 also edits
`packages/ai/src/gateway/gateway.ts` (different file from this lane; no conflict expected).

## Hard invariants honored

Strengthens the tool-output validation boundary (module isolation / schema-is-the-model's-only-view
adjacent) without changing any module's public API — the manifest format already permits this
`anyOf` shape; the host just starts honoring it. No secrets, no migrations, no job-payload or
VaultContext involvement, no provider-specific behavior.
