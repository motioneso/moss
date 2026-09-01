# Integrations — Tool Call Discipline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connected service cannot make Moss repeat a real-world action, flood a chat turn, or
attach 28,000 characters of tool definitions to every message — and none of the fixes know
anything about Home Assistant.

**Spec:** `docs/superpowers/specs/2026-09-01-integration-tool-call-discipline.md`

**Issue:** #2175

**Follows:** the integrations foundation (#2162, shipped as #2171). This is behaviour work on top
of a shipped, working feature — the connection Ben made on 2026-09-01 must keep working at every
step.

**Tech stack:** TypeScript, Fastify, postgres.js with row-level security, `@modelcontextprotocol/sdk`,
vitest, React + TanStack Query, authored `jds-*` design system.

## Global Constraints

- **Plain English to humans.** Chat, status updates, handoff docs and every spawn prompt you write
  carry the no-jargon rule (box-wide CLAUDE.md). Commit messages, code comments and this plan's
  code blocks stay technical.
- **Shared checkout.** Do branch work in a temp worktree (`superpowers:using-git-worktrees`).
  Never `git add -A` or `git add .`, never a bare `git commit`; commit explicit paths via the
  `shared-checkout` skill.
- **Three pull requests**, in this order: Tasks 1-4 (the safety core), Tasks 5-6 (curation and the
  screen), Tasks 7-9 (speed). Task 10 proves whichever has landed. Within each PR, slices share the
  worktree and the PR — slices are session-sized, not PR-sized.
- **Task 6 does not start until Ben has seen the screen.** The design gate applies: a change to an
  existing page plus a new opt-in flow needs agreed mockups first. Do not build it and show him
  after.
- **Nothing new is required in a deployment settings file.** Every setting this plan adds is set
  in the app. Ben's ruling, 2026-09-01, after a required key in a settings file took production
  down: a new feature must never be gated on hand-editing deployment config.
- **A pull request must never break production.** If anything here becomes required config, it
  ships with its dev and prod entries in the same PR.
- **Secrets never escape.** The outcome envelope carries the service's payload and Moss's own
  summary — never a credential, a header, or the credential part of a connection URL. The
  in-memory stores hold tool results, so they are never logged and never written to the database.
- **Never edit an applied migration.** This plan adds three new SQL files, each with a globally
  unique 4-digit version, each in the package that owns the table it touches: one in the
  integrations package for the escape-hatch column (Task 3), and two in the AI package for the
  timing column and the widened outcome values (Task 7). The runner hash-checks applied files, so
  an edit breaks every existing install.
- **Row-level security applies to every actor.** Every store and cache in this plan is keyed by
  the acting user first. One user's cached tools or stored results must be unreachable from
  another's, and no admin path bypasses that.
- **Provider-agnostic AI.** The prompt rule in Task 2 goes in the shared system prompt; never a
  provider or model name anywhere.
- **Module isolation.** The integrations package talks to the rest of the product only through
  declared public APIs — no reaching into another module's internals or tables.
- **Design system.** Any UI work uses the `design-system` skill first: authored `jds-*` primitives
  only, and run the invented-class audit before the PR.
- **Testing.** Unit tests in `tests/unit/`, integration in `tests/integration/`. Any DB-touching
  test command ONLY via the `verify-gate` skill — an unscoped run hits the live dev database.
  Known and unrelated: `module-sdk-worker` tests fail locally and are green in CI. Never bisect
  your branch over it.
- **Live-path gate.** Green CI and code review do not make this done. The four proof paths in the
  spec must be recorded on the PR, exercised through the real UI on a live dev instance. Prod
  (`:1533`) is never a test target.
- **PR:** fill the Release note section. Category: Changed. One plain-English sentence a
  non-technical user can read — no code names or file paths.
- Merge with `gh pr merge --squash --auto`. Never `--admin` (a ruleset blocks it).

**Numbers fixed by the spec** — do not re-litigate them in code review: tool-count threshold 30
(unchanged); calls per request 12; characters per response 8,000; characters per request 24,000;
smallest derived group 3; quiet window 30 seconds, used by the duplicate store, the tool-list cache
and the held connection alike. The existing 16,000-character cut in the chat gateway stays exactly
as it is — it guards every tool in the product, not just these.

---

### Task 1: Capture what each tool does

**Files:**
- Modify: `packages/shared/src/integrations-api.ts`
- Modify: `packages/integrations/src/mcp-client.ts`, `packages/integrations/src/openapi-convert.ts`
- Test: `tests/unit/integrations-tool-hints.test.ts`

**Interfaces:** produces three optional per-tool facts that every later task reads. Nothing else
changes shape.

- [ ] **Step 1:** Widen the tool descriptor with three optional, three-valued facts — present and
  true, present and false, or absent. Absent means the service said nothing and is treated as
  "no" everywhere.

```ts
export interface IntegrationToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly inputSchema: Record<string, unknown> | null;
  /** Service says this tool only reads. Absent = did not say. */
  readonly readOnly?: boolean;
  /** Service says calling it twice with the same arguments is safe. Absent = did not say. */
  readonly idempotent?: boolean;
  /** Service says this tool destroys something. Absent = did not say. Recorded, not yet acted on. */
  readonly destructive?: boolean;
}
```

- [ ] **Step 2:** In MCP discovery, read the annotations the protocol already supplies on each
  listed tool and map them onto the three fields. Discovery currently maps name, description, an
  empty group and the input schema, and drops the rest. Do not invent a default: a tool with no
  annotations leaves all three absent.
- [ ] **Step 3:** In the OpenAPI converter, set `readOnly` for `GET` and `HEAD`, and `idempotent`
  for `GET`, `HEAD`, `PUT` and `DELETE`. Leave `destructive` unset — a spec does not say.
- [ ] **Step 4:** No migration. Discovered tools are already stored as a JSON document
  (`discovered_tools` in `packages/integrations/sql/0207_integration_connections.sql`), so the new
  fields need no schema change. Every reader must tolerate their absence, because every row that
  exists today lacks them.
- [ ] **Step 5:** Tests — a tool list where one tool is annotated read-only, one is annotated
  idempotent, one is annotated destructive, and one carries nothing; an OpenAPI spec with one
  operation per method; a stored connection whose tools predate this change still loads and still
  works.

---

### Task 2: The outcome envelope and the prompt rule

**Files:**
- Modify: `packages/integrations/src/tool-manifests.ts`, `packages/integrations/src/mcp-client.ts`,
  `packages/integrations/src/openapi-invoke.ts`
- Modify: the shared chat system prompt (find it before writing; do not guess the path)
- Test: `tests/unit/integrations-envelope.test.ts`

- [ ] **Step 1:** Give every integration tool result one fixed shape, whatever the kind of service:
  a status of ok or error, whether the call performed something or only read, a one-line
  Moss-authored summary, and the service's own reply passed through unchanged.
- [ ] **Step 2:** "Only read" is set exactly when Task 1 recorded the service saying so. Everything
  else, including silence, is "performed".
- [ ] **Step 3:** Never rewrite or summarize the service's words. Moss frames the reply; it does
  not edit it.
- [ ] **Step 4:** Add one rule to the chat system prompt, written for integration tools generally
  and naming no service: when a tool reports success and says it performed something, the action
  happened — do not call a read tool to confirm it.
- [ ] **Step 5:** Tests — the shape holds for a success, an error, an MCP call and an OpenAPI call;
  the service's payload is byte-identical inside the envelope; no credential appears anywhere in it.

---

### Task 3: Do not repeat a call inside one burst

**Files:**
- Create: `packages/integrations/src/call-memory.ts`
- Modify: `packages/integrations/src/tool-manifests.ts`
- Test: `tests/unit/integrations-call-memory.test.ts`

**Interfaces:** produces the store every later limit reads from. Task 4's counters live here too.

- [ ] **Step 1:** Build the store at package level, not inside the resolver closure — the resolver
  is rebuilt on every call (Task 8), so a closure would forget everything between calls. Key it by
  acting user and chat session, both available on the context handed to a tool's execute. Expire an
  entry after **30 seconds of quiet**. Hold it in memory only: never logged, never written to the
  database, never shared between users. **Do not widen the shared per-request context object to
  carry a turn identifier** — a field was removed from it on purpose and re-adding one re-opens a
  closed design (hard invariant).
- [ ] **Step 1a:** A blocked repeat must **not** refresh the window; only a call that reached the
  service extends it. Without this, a user asking repeatedly is blocked forever, each attempt
  pushing the expiry further out.
- [ ] **Step 1b:** Know that one path has no chat session: when a tool reads through another tool
  the gateway sets it to an empty string, so all such calls for a user share one bucket. Still
  per-user, still safe. Do not special-case it; do add a test that it does not leak across users.
- [ ] **Step 2:** Within that scope, key each call by connection, tool name, and the call's
  arguments with their keys put in a fixed order, so the same arguments written in a different
  order are one key.
- [ ] **Step 3:** A repeat of a tool that only reads returns the stored result, summarised as
  unchanged from earlier — **unless** any tool on that connection has successfully performed
  something since that result was stored. A successful performed call clears every stored read for
  its connection. Serving a snapshot taken before an action would have the model report the old
  state as current, which is worse than the extra call.
- [ ] **Step 4:** A repeat of a tool that performs something is not re-invoked, with one exception:
  if the service annotated it safe to call twice, let it through.
- [ ] **Step 5:** A blocked repeat says so plainly and never reads as a second success — the model
  must be able to tell the user it did the thing once, not twice. It returns the **one-line summary
  only, not the stored payload again**; re-sending it would let a loop of identical reads re-inject
  up to 8,000 characters per repeat free of every budget in Task 4. One exception: a still-valid
  read under 500 characters may be re-sent.
- [ ] **Step 6:** Add a per-connection, per-tool switch that turns suppression off for a named
  tool, off by default, set in the app on the connection detail page. Never a settings file. It
  needs storage: a new text-array column alongside the existing muted-tools column, via a new SQL
  file in the integrations package, plus one field on the connection detail contract and on the
  update request.
- [ ] **Step 7:** Tests — a repeated read served from the store; the same repeated read run for
  real after an intervening successful action; a repeated action blocked; a repeated action allowed
  because the service marked it safe; a tool with no annotations at all treated as performing; the
  argument ordering key; expiry after the window; one user's stored result never returned to
  another.

---

### Task 4: Ceilings and size budget

**Files:**
- Modify: `packages/integrations/src/call-memory.ts`, `packages/integrations/src/tool-manifests.ts`,
  `packages/integrations/src/limits.ts`, `packages/integrations/src/openapi-invoke.ts`
- Test: `tests/unit/integrations-limits.test.ts`

- [ ] **Step 1:** Cap integration tool calls at 12 within one burst. Count after suppression, so a
  blocked repeat does not spend budget. On exceeding, refuse further integration calls for that
  burst and return an error envelope telling the model to answer with what it has. The chat still
  completes.
- [ ] **Step 2:** Cap a single response at 8,000 characters, enforced in the proxy so it covers
  both MCP and OpenAPI. Today the 64,000 cap is on the OpenAPI path only and **the MCP path has no
  cap at all** — which is where the whole-house dumps came from.
- [ ] **Step 3:** Truncation is never silent. A truncated response says so in its summary and says
  what to do about it — ask for a narrower query.
- [ ] **Step 4:** Cap all integration responses in one burst at 24,000 characters combined. On
  exceeding, refuse further calls the same way as the call ceiling.
- [ ] **Step 5:** Retire the OpenAPI path's 64,000 constant. With 8,000 above it, it can never
  fire, and two caps where only one ever fires is the condition that let this through.
- [ ] **Step 6:** Leave the chat gateway's own 16,000-character cut alone
  (`packages/ai/src/gateway/output-validation.ts`). It guards every tool in the product, not just
  these, and the proxy's 8,000 now always fires first for integration tools, so the gateway's
  silent one never does. Three caps exist; after this task exactly one of them can fire for an
  integration tool, and the other two are a retired constant and a product-wide backstop.
- [ ] **Step 7:** Note in the code that the per-request budget counts what the service sent, before
  the gateway's backstop trims anything — it is not "characters the model saw".
- [ ] **Step 8:** Tests — the boundary at exactly 8,000; the combined budget crossing mid-burst;
  the call ceiling; a refusal is an envelope, not a thrown error.

---

### Task 5: Groups for services that do not supply them

**Files:**
- Modify: `packages/integrations/src/curation.ts`
- Create: `packages/integrations/src/derive-groups.ts`
- Test: `tests/unit/integrations-derive-groups.test.ts`

- [ ] **Step 1:** Fix the dead rule. The opt-in rule requires at least one tool to carry a
  non-empty group, and MCP discovery sets the group empty for every tool — so it can never fire for
  an MCP connection at any tool count. This is why all 75 tools are on and 28,359 characters of
  tool definitions ride on every chat turn.
- [ ] **Step 2:** Derive groups by this exact procedure. "Longest shared prefix" alone is wrong:
  nearly every tool on the live connection starts with the same four letters naming the service, so
  that rule produces one group of sixty and the screen is no better than a flat list.
  1. Split each name into segments at upper-case boundaries and at separators (`_`, `-`, `.`).
  2. Drop a leading segment shared by more than half the tools; repeat until it is shared by half
     or fewer. That segment names the service, not a family.
  3. Group on the next segment.
  4. Split any group larger than 12 by repeating steps 2 and 3 one level deeper.
  5. Sweep any group smaller than 3 into `Other`.
- [ ] **Step 2a:** Capture the real 75 tool names from the live connection as a checked-in fixture
  **before** writing the algorithm, and write the expected grouping into the test. If the algorithm
  produces something unhelpful on real names, change the algorithm, not the fixture. The minimum
  size of 3 is the number most likely to be wrong.
- [ ] **Step 3:** Derivation is presentation only. It never renames a tool; the name sent to the
  service is always the discovered one.
- [ ] **Step 4:** Apply the opt-in rule uniformly — over the threshold, nothing is enabled until
  the user chooses, whether the groups came from the service or from Moss.
- [ ] **Step 5:** **Grandfathering, with a mechanism.** Ben's connection works today only because
  the opt-in rule never fires: its enabled-tools list is empty, and under the old rule an empty list
  means everything is on. The moment derived groups exist, an empty list means nothing is on and the
  one production connection goes dark on upgrade. "A pull request must never break production" makes
  this a blocker.
  - A one-time data step writes the currently-effective tool names into the connection's own
    enabled-tools list, for every connection over the threshold with an empty enabled list and no
    service-supplied groups. After it, the enabled set is explicit rather than implied.
  - Do **not** use a flag marking the connection as pre-grouping. The two differ on the next
    discovery refresh: a flag silently switches on whatever new tools the service has added, an
    explicit list leaves them off until the user chooses. Leaving them off is the point of opt-in.
  - Test the upgrade path directly: a connection shaped like today's, run the step, confirm the same
    tools are offered to chat before and after.
- [ ] **Step 6:** Tests — derivation over the real 75 tool names from the live connection, checked
  in as a fixture; the smallest-group rule; the `Other` bucket; a connection with service-supplied
  groups is untouched; an existing all-enabled connection keeps its set.

---

### Task 6: Connection detail page

**Files:**
- Modify: the Integrations pane under `apps/web/src/settings/`
- Test: component tests alongside the existing pane tests

**REQUIRED FIRST: Ben has seen and agreed the screen.** This task changes an existing page and
adds an opt-in flow every future large connection will meet on day one. Mockups agreed before any
code — do not build it and show him after.

**REQUIRED SECOND: the `design-system` skill.** Authored `jds-*` primitives only, no invented
classes, no accent left-border on a selected item, copy stays tight — field titles, no explainer
hints, one-line notes only where they carry weight.

- [ ] **Step 1:** Show derived groups instead of a flat 75-row list when the service supplied none.
- [ ] **Step 2:** One line on a connection whose stored tools predate Task 1, saying that pressing
  refresh will pick up what the service says about each tool. Do not build a new button — refresh
  already exists.
- [ ] **Step 3:** The per-tool "allow repeated identical calls" switch from Task 3, off by default.
- [ ] **Step 4:** One line where an existing over-threshold connection kept everything enabled,
  saying grouping is now available.
- [ ] **Step 5:** Run the invented-class audit before the PR.

---

### Task 7: Record how long each call took

**Files:**
- Create: two new SQL files in `packages/ai/sql/` (the AI package owns the audit table)
- Modify: the gateway's audit-log write path
- Test: `tests/integration/` — the audit row carries a duration and a suppressed-call outcome

**This task is deliberately a gateway change, not a proxy change** — the opposite of the spec's
"the proxy is the enforcement point" ruling, on purpose. Timing is telemetry, not enforcement, and
it is worth more covering every tool than only these.

- [ ] **Step 1:** Add a duration column to `app.moss_action_audit_log`, populated for every
  **audited** call, integration or not. The gateway deliberately writes no row for a handful of
  read-only built-in tools, so those will never carry a duration. That is fine; do not "fix" it.
- [ ] **Step 2:** New SQL file in `packages/ai/sql/`, globally unique 4-digit version across every
  module's `sql/` directory and the shared migrations directory. **Never edit an applied
  migration** — the runner hash-checks applied files and an edit breaks every existing install.
- [ ] **Step 3:** Record suppressed and refused calls with their own outcome, so a request that hit
  a ceiling is visible afterwards instead of looking like a request that simply made fewer calls.
  **This needs a second SQL file.** The outcome column has a check constraint listing the allowed
  values, already widened once (`packages/ai/sql/0177_audit_outcome_widen.sql` — currently success,
  failed, denied, cancelled, invalid, conflict). Widen it again in a new file. Without this, the
  write fails the constraint at run time and the promise silently breaks.
- [ ] **Step 4:** This is what turns "it feels slow" into "the service answered in 50 milliseconds
  and we made five calls". The diagnosis behind this spec needed a live production instance and
  manual timing; it should need a query.

---

### Task 8: Stop rebuilding every tool on every call

**Files:**
- Modify: `packages/integrations/src/tool-manifests.ts`
- Test: `tests/unit/integrations-resolver-cache.test.ts`

- [ ] **Step 1:** Understand the problem before changing anything. The chat gateway asks for the
  actor's tools on **every single tool call**, not once per turn (`executableTools` in
  `packages/ai/src/gateway/gateway.ts`). The integrations resolver runs inside that, so every call
  re-reads the user's connections from the database and rebuilds all 75 tool descriptions. Ben's
  five-call request did that five times.
- [ ] **Step 2:** Cache a user's connection rows and built tool descriptions in memory for **30
  seconds**, keyed by acting user. Same number as Task 3's store — one number is easier to reason
  about than two, and the drop-on-edit rule below, not the clock, is what keeps a user's own changes
  immediate.
- [ ] **Step 3:** Drop that user's cached entry immediately when they add, edit, delete or refresh
  a connection, or change which tools are enabled. A stale entry must only ever be able to affect
  the user who owns it, and only until their own next edit.
- [ ] **Step 4:** Change only the integrations half. The gateway re-resolving every module on every
  call is a product-wide problem and belongs in its own piece of work.
- [ ] **Step 5:** Tests — the cache is dropped on every kind of edit; one user's cached entry is
  never returned for another user.

---

### Task 9: Reuse the connection within a burst

**Files:**
- Modify: `packages/integrations/src/mcp-client.ts`
- Test: `tests/integration/` against a fake MCP server

- [ ] **Step 1:** Hold one client per connection for the life of a burst instead of connecting and
  closing on every call. Connecting currently runs per call, including a first attempt and a
  fallback in a catch.
- [ ] **Step 2:** **Say who closes it.** There is no request-end signal (Task 3), so the held client
  lives in the same store as the duplicate memory, under the same key and the same 30 seconds of
  quiet, closed by the same expiry sweep. A client mid-call is never closed underneath itself:
  expiry marks it, the close happens when the call returns. A held client found broken is not an
  error — the next call reconnects, which costs 8 to 52 milliseconds.
- [ ] **Step 2a:** Never pool across users. The key starts with the acting user, and a client
  carries that user's credential.
- [ ] **Step 3:** This is last on purpose — measured at 8 to 52 milliseconds per call on the live
  connection, genuinely minor. Against a remote service over TLS with an auth handshake it is
  plausibly several hundred milliseconds every call, which is why it is worth doing at all.

---

### Task 10: Prove it on a live instance

**REQUIRED: the live-path gate.** Record all four on the PR, exercised through the real UI on the
live dev instance. Never against production.

- [ ] **Step 1:** **The repeat is gone.** Ask chat to turn a light off. The audit log shows exactly
  one switch-off call and no whole-house read afterwards. Record the wall-clock time for the same
  sentence against the roughly 13-second baseline in the spec.
- [ ] **Step 2:** **Curation works without groups.** On the 75-tool connection the detail page
  shows derived groups rather than a flat list, and turning a group off removes exactly those tools
  from what chat can call.
- [ ] **Step 3:** **The tool list is not rebuilt per call.** With durations recorded, one chat
  request making several integration calls shows the connection read from the database once, not
  once per call.
- [ ] **Step 4:** **A read after an action is fresh.** Ask chat to turn a light off and then report
  the state of the lights in one sentence. The reported state is the state after the switch, not
  before it.
- [ ] **Step 5:** Open a chat **after** the change and confirm a newly added integration's tools
  are offered. An already-open chat does not pick up newly added tools — that is what made the
  first live attempt look like a failure, and it is worth confirming it is understood rather than
  fixed by accident.

---

## Verification (every PR, unpiped, expected exit code shown)

```bash
pnpm lint > /tmp/tcd-lint.log 2>&1; echo "EXIT=$?"            # expect EXIT=0
pnpm typecheck > /tmp/tcd-tc.log 2>&1; echo "EXIT=$?"         # expect EXIT=0
pnpm test:unit > /tmp/tcd-unit.log 2>&1; echo "EXIT=$?"       # expect EXIT=0 (module-sdk-worker known-red locally, green in CI)
```

The full gate `pnpm verify:foundation` only through the `verify-gate` skill — never unscoped, never
piped. Read the tail of the log only if the exit code is non-zero.

## Kill gate after PR 1

PR 1 (Tasks 1-4) ships alone and is judged before PR 2 is briefed. **The observation that ends the
line:** on the live dev instance, "turn the kitchen light off" still makes more than one switch-off
call, or the wall-clock time is not clearly under half the 13-second baseline. If either holds, the
diagnosis was wrong and PRs 2 and 3 are not started until it is re-done. **Ben makes the call**, on
the recorded proof from Task 10 steps 1 and 4.

## Determinism boundary

No user-facing text in this plan is authored by the model. Every summary line in the envelope
("Already performed", "Result truncated at 8,000 characters", "Call limit reached") is a fixed
string written by Moss. The model's only two jobs: decide which tool to call, and phrase the final
answer to the user. The one new prompt rule (Task 2, step 4) is under 40 words; if it grows, the
design is wrong.

## Order and slicing

Three pull requests: Tasks 1-4 (the safety core), Tasks 5-6 (curation and the screen, gated on
Ben seeing the mockups), Tasks 7-9 (speed). Task 10 proves whichever has landed.

Inside that: Tasks 1, 2 and 5 are independent and can run in parallel. Task 3 needs 1 and 2. Task 4
needs 3. Task 6 needs 3 and 5. Task 8's finding — that the tool list is rebuilt on every call —
must be **read** before Task 3 is written, even though it ships later, because it is the reason the
store cannot live in a closure. Task 9 needs Task 3's store to exist.

One session per task. If a task needs more than one context window, it is too big — re-slice it
rather than handing yourself forward.
