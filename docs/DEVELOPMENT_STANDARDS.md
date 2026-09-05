# Moss Development Standards

Date: 2026-06-06

Moss uses a strict maintainability bar based on the `thermo-nuclear-code-quality-review` standard. Passing tests is required, but it is not enough. A change should leave the codebase simpler to reason about, not merely working.

## Approval Bar

A change is not ready if it introduces any clear structural regression:

- preserves incidental complexity when a simpler model could delete it
- adds ad-hoc branches, scattered special cases, or mode flags into unrelated flows
- leaks feature logic into shared infrastructure or the wrong package boundary
- adds thin wrappers, identity abstractions, or cast-heavy contracts that obscure the real invariant
- duplicates an existing canonical helper instead of reusing or improving it
- makes orchestration more sequential or less atomic without a clear reason
- pushes a file from under 1000 lines to over 1000 lines without a strong structural justification

Treat these as presumptive blockers until the author can justify them clearly.

## Required Checks

Run the maintainability gate before broad feature work is considered ready:

```txt
pnpm lint
pnpm format:check
pnpm check:file-size
pnpm typecheck
```

`pnpm verify:foundation` includes these checks before migrations and integration tests.

### Dispatching a subagent

A subagent verifies exactly what its brief names and nothing more, so **the brief must carry the
gate's own checks** — scoped to the files it touches:

```txt
npx tsc --noEmit > /tmp/tsc.log 2>&1; echo "TSC=$?"
npx eslint <files touched> --max-warnings=0 > /tmp/lint.log 2>&1; echo "LINT=$?"
```

Root `tsc` matters even when the module typechecks: a module's own `tsconfig` does not cover
`tests/`, so a test file can be green under it and fail the gate. Scoped `eslint` runs in seconds.

Two Food-module subagents (2026-08-19) reported TSC=0, FMT=0 and 39 passing tests, and
`verify:foundation` still failed at step 1 of 15 — an unused import, an `eslint-disable` for a rule
not configured under `external-modules/`, and a `possibly undefined` only root `tsc` sees. The
brief had named vitest and prettier, so the agents did precisely what was asked. A brief naming 2
of the gate's 15 steps leaves the other 13 to be discovered the expensive way.

## App Map Truthfulness

Every product change must update Moss's app map in the same PR so the assistant can accurately
explain what Moss has, where it lives, what it requires, and how to recover from errors. This
includes adding, changing, moving, or removing a feature, setting, screen, navigation path,
requirement, error, or remediation. A stale or missing declaration blocks merge; it is not
follow-up work.

- Core screens and settings: update `CORE_APP_SCREENS` or `CORE_APP_SETTINGS` in
  `packages/shared/src/app-map-core.ts`.
- Module-owned behavior: update the owning module manifest's `navigation`, `settings`, and
  `features` metadata, including nested `errors` and `remediations`.
- Keep labels, descriptions, paths, scope, flags, and requirements aligned with the real shipped
  behavior. Remove declarations when behavior is removed.

Pure refactors and internal implementation changes that do not alter what Moss can do or explain
need no map change.

## Live-Path Gate (CI-green is not done)

Do not request, capture, attach, or review screenshots for this gate. Use executable assertions and
bounded textual evidence instead.

A PR that adds or changes a **user-facing feature, module, or UI surface** does not merge, and its
issue is not marked Done, on unit/integration/CI-green plus code review alone. Those verify the
parts in isolation, and parts have repeatedly passed in isolation while the assembled feature was
broken.

Such a PR merges **only** with a live end-to-end proof recorded on the PR: the feature was installed
and exercised **through the real UI on a live dev instance** — owner signup → the real
Settings/module path → the feature actually runs — evidenced by a `gh pr comment` linking the e2e
UAT run, its exit code, and assertions or bounded DOM/network/log evidence for the exercised path.
A passing headless test alone is insufficient unless its recorded assertions prove the assembled
path is reachable through the real UI.

No artifact means you may not merge and may not mark the issue or epic Done. The correct status is
**code-complete, unverified** — say that plainly rather than reporting the work as finished.

This rule exists because it already happened: a module shipped as nine slices, each closed on
CI-green and code review, none of which had ever been run through the real UI. Its install path was
broken the entire time, so none of it worked for the owner. Green parts, dead whole.

Out of scope: docs-only changes, refactors with no user-visible surface, and internal tooling.

### Redeploying an external module on dev

Use `scripts/redeploy-external-module.sh <module-id>`. Do not run the build/reconcile/enable steps
by hand.

Rebuilding a module changes its package hash, which makes `pnpm db:reconcile` disable it by design.
(#1468: needs `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` set once your dev target has a bootstrap owner
— see the module-developer-guide's Dev parity note.)
Re-enabling it reads the API's **boot-time** discovery cache, so the enable must land on an API
process running the new code. During a `tsx watch` restart the old process keeps serving and
answers `/health` with a 200, so a health check does not prove the restart happened — an enable
gated on `/health` can store the stale hash, report `drifted:false`, and then be disabled again
seconds later when the new process boots and sees the mismatch. The module disappears from the rail
after an apparently successful deploy.

The script gates on the listening PID changing rather than on `/health`, and re-verifies after a
settle delay, because the disable happens _after_ the enable returns 200.

## Design System Guardrails

Moss UI must keep the authored design-system shape:

- headings use `--font-display` (Neue Haas Grotesk, interim Helvetica stack); body uses
  `--font-sans`. **No mono and no serif** — mono was retired 2026-07-08 (eyebrows, labels, and data
  use `--font-sans` with `tabular-nums`); serif survives only in the sports nameplate. Match the
  live `apps/web/src/styles/tokens.css`, which is the authority if this list ever drifts again
- palette, radius, shadow, focus, and state colors come from `apps/web/src/styles/tokens.css`
- extend existing `jds-*` and local UI primitives; do not drop in unstyled shadcn, Radix, or
  Tailwind-default primitives
- new empty and loading states must match existing authored states: warm surface, sentence-case
  copy, tokenized color, and no generic placeholder cards

Run `pnpm check:design-tokens` before shipping frontend CSS changes.

### A new module needs its front end designed before it is built

Any new module — built in or installable — must go through a front-end design discussion with Ben,
producing agreed mockups of every screen it ships, **before** implementation starts. The mockups go
in the module's design spec under `docs/superpowers/specs/`, and the spec is not approved without
them. A build plan for a module with no agreed mockups is not ready to execute.

This is a hard gate for the same reason the spec gate is. Food shipped its day view in Phase 1 with
no design pass at all: the markup used only module-local layout classes and applied not one `jds-*`
class, so the page rendered as unstyled text on a bare background while Finance — same layout-only
CSS contract, same platform — looked designed. Nothing in review caught it, because the code was
correct; there was simply never a moment where anyone decided what the screen should look like.

Two things the discussion must settle, because both were wrong on Food:

- **Which host primitives each screen is built from.** A module's own CSS is layout-only by
  contract, so all visual identity comes from applying `jds-*` classes in the module's markup.
  Naming them at design time is what stops a module shipping with none.
- **What the screen shows when it is empty, loading, or broken.** These are screens, not
  afterthoughts, and they are the states a new module is most often seen in.

## Agent Knowledge Tools

Agents working in this repository should keep project knowledge current while they work.

Use CodeGraph for codebase navigation before making architectural claims or changing unfamiliar
flows:

```txt
codegraph status .
codegraph sync .
```

The CodeGraph index is local cache state and lives under `.codegraph/`, which is intentionally
ignored by git. Do not commit CodeGraph database files. Run `codegraph sync .` after pulling changes
or after making meaningful code edits so later agent queries see the current shape of the repo.

Prefer CodeGraph MCP queries for:

- understanding how a symbol, route, repository, module, or worker flow fits together
- tracing callers/callees before refactors
- checking impact before changing shared helpers, contracts, manifests, or data-context code
- answering architecture questions that depend on current source code

Use agentmemory for durable session knowledge that should survive beyond one chat:

- save decisions that affect future implementation choices
- save architectural invariants that were clarified during the session
- save lessons from debugging, verification failures, or release-hardening work
- recall prior sessions before continuing old work, reviewing why code exists, or resuming a plan

Do not save secrets, tokens, private user data, raw connector payloads, prompts containing private
content, or environment-specific credentials into agentmemory. Keep memory entries concise and tied
to stable project concepts or file paths.

## Prompt-Cache Discipline

Provider-side prefix caching only works when the prompt prefix stays byte-stable. Violating
this silently invalidates the cache on every request.

Rules for all AI runtime code and persona files in this repo:

- **Persona/context files must be byte-stable per user.** Never embed timestamps, monotonic
  counters, session IDs, or any value that changes between launches. A persona file is a
  static prompt prefix; it caches at the provider until the file itself changes.
- **Dynamic content goes in turns, not the persona.** Memory seeds, replay blocks, injected
  user context, and any data that changes between sessions must be submitted as explicit
  conversation turns _after_ the CLI launches — never prepended into the persona/context file.

Violating either rule means every session pays full context processing cost instead of a
cache hit. On long persona files this is a significant per-message cost.

## Structural Standard

Be ambitious about simplification. Look for restructurings that preserve behavior while making the implementation dramatically smaller, more direct, and more obvious.

Prefer changes that delete complexity:

- reframe the state model so conditionals disappear
- move logic to the package, module, or layer that owns the concept
- collapse duplicate branches into one explicit flow
- extract focused helpers or modules when a file starts mixing concerns
- replace condition chains with a typed model or dispatcher when that makes the flow clearer
- delete wrappers or generic mechanisms that do not earn their indirection

Do not accept a refactor that only moves complexity around.

## File Size

Do not let a PR push a file from below 1000 lines to above 1000 lines without a very strong reason.

Crossing that threshold is a code-quality smell by default. Prefer decomposing into focused modules, helpers, subcomponents, repositories, services, or test fixtures before allowing the file to sprawl. A waiver requires a compelling structural reason and the resulting file must still be easy to scan.

The 1000-line threshold is not a target. Files should be much smaller when the domain naturally decomposes.

## Branching And Spaghetti

Be highly suspicious of new one-off conditionals in existing flows. If a change adds special cases in random places, treat that as a design problem.

Prefer:

- a dedicated abstraction, policy object, state machine, or module
- a clearer default flow with fewer exceptions
- a typed boundary that makes invalid states unrepresentable
- a pure helper when the same condition appears in multiple places

Do not normalize temporary branching that is likely to become permanent debt.

## Types And Boundaries

Prefer explicit contracts over loosely shaped objects.

Push back on:

- unnecessary `any`, `unknown`, casts, nullable modes, and optional parameters
- silent fallbacks that hide unclear invariants
- feature-specific objects crossing shared API boundaries
- repository or worker code bypassing canonical context wrappers

If the type boundary is fuzzy, make the invariant explicit instead of papering over it with runtime branching.

## Canonical Layers

Keep logic where the architecture says it belongs.

- Protected data access goes through `AccessContext`, `withDataContext()`, and repositories that require `DataContextDb`.
- Module-owned behavior belongs in the owning module unless it is a declared public API or event.
- Shared packages should contain general primitives, not product-specific special cases.
- Worker jobs carry metadata only and enter the normal data context before touching protected data.

When a change needs a helper, search for the canonical helper first. Do not create a near-duplicate.

### Pre-auth non-secret instance-config reads (bounded exemption)

A small allowlist of NON-SECRET `app.instance_settings` keys may be read with the raw
app Kysely handle (no `DataContextDb`, no actor GUC) when a value is needed before any
actor exists — at boot, or on a pre-auth route. This is sanctioned because the
`instance_settings` SELECT policy is `USING (true)` (migration 0059) and these keys hold
only non-secret configuration; secrets live in the AES-256-GCM credential store. Current
allowlist: `registration.enabled`, `registration.requires_approval` (auth registration
gate), `chat.multiplexer` (composition-root multiplexer resolution). WRITES remain
admin-gated (`current_actor_is_admin()`). Do **not** extend the allowlist to any key that
could carry user data or secrets, and never use this path for per-user tables.

## Review Order

When reviewing changes, prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification
3. Spaghetti or branching complexity increases
4. Boundary, abstraction, and type-contract problems
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

Keep review comments focused on high-conviction issues. Do not flood a review with cosmetic notes when the real issue is structural.
