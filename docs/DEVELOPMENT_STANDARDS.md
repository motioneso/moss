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

## Live-Path Gate (CI-green is not done)

A PR that adds or changes a **user-facing feature, module, or UI surface** does not merge, and its
issue is not marked Done, on unit/integration/CI-green plus code review alone. Those verify the
parts in isolation, and parts have repeatedly passed in isolation while the assembled feature was
broken.

Such a PR merges **only** with a live end-to-end proof recorded on the PR: the feature was installed
and exercised **through the real UI on a live dev instance** — owner signup → the real
Settings/module path → the feature actually runs — evidenced by a `gh pr comment` linking the e2e
UAT run, its real exit code, and concrete assertions or bounded DOM, network, application-log, or
database evidence. Screenshots are not required and should not be generated, captured, attached,
or preserved for this gate. A passing headless test alone is not, because it does not prove the
assembled path is reachable by a person.

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
