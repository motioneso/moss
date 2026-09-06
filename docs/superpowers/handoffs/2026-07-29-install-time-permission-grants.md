# Handoff: stop the Approve/Deny cards — #1246 Tasks 3–5

**Issue** #1246 (+ #1267 is Task 3 of it) · **Epic context** job-search #1280 · **Base branch**
`feat/job-search`

Ben is dogfooding the Job Search module end-to-end right now and hits an Approve/Deny card on every
ordinary write. Your job is to make that stop, for the right reason.

## Read these first — they are the authority, do not re-derive the design

- `docs/superpowers/specs/2026-07-24-install-time-permission-grants.md` — **approved by Ben
  2026-07-24**. 147 lines. Read in full.
- `docs/superpowers/plans/2026-07-24-install-time-permission-grants.md` — 1082 lines, 6 tasks with
  contracts and test cases. **Your scope is Tasks 3, 4, and 5.**

Both were lost in the 2026-07-26 repo reset and recovered on 2026-07-29 (commit `785b62bc`; source
dangling commit tagged `recovered/1246-spec-plan`). They are real and approved — the spec-before-build
gate is **already satisfied**. Do not write a new spec. If you believe the spec is wrong, say so and
stop; do not silently deviate.

## Scope

- **Task 3** — promote `assistantActionFamilies` to a positively-validated external-module surface.
  It currently sits in `FORBIDDEN_FIELDS`
  (`packages/module-registry/src/external/validate.ts:58`), so an external JSON manifest is *rejected*
  for declaring a family. Follow the existing precedent for `auth`/`storage`/`web` (#918),
  `database` (#964), `navigation` (#1019) — each was moved out of that list and given positive
  validation.
- **Task 4** — adapter pass-through plus declarative confirmation. `createExternalToolManifests`
  (`packages/module-registry/src/external/tool-manifests.ts:36`) maps only
  `{name, description, permissionId, risk, inputSchema, outputSchema, execute}` and silently drops
  `actionFamilyId` / `executionPolicy`. A JSON manifest cannot carry a TS predicate, so the plan
  specifies a declarative `confirmWhen` / `confirmWhenKeys` form synthesized into
  `requiresConfirmation`. Read the plan's exact contract for this — it is shared with #1247.
- **Task 5** — make the job-search manifest conform (`external-modules/job-search/jarvis.module.json`)
  and rewrite its guidance prose to match. All ten `risk: "write"` tools currently carry no
  `actionFamilyId` and no `executionPolicy`.

**Out of scope:** `risk: "outbound"` is deferred to **#1249** — `action_kind` carries
`CHECK (action_kind IN ('write','destructive'))` in the applied, hash-checked migration `0127`, so it
needs a new migration plus a six-site contract sweep. The plan's Tasks 3–5 do not depend on it.
`validate.ts` already rejects `"outbound"`; keep a regression test asserting that holds.

## Verified state (checked on `feat/job-search`, 2026-07-29)

- `resolvePolicy`'s `if (!familyId) return "confirm"` guard: `packages/ai/src/gateway/policy.ts:44`.
  The rest of the chain already works — `getFamilyManifest`
  (`packages/chat/src/gateway-services.ts:263`) resolves families off the active-module manifest, and
  `resolvePolicy` already does `tier ?? manifest.defaultTier`, so a stored user preference keeps its
  veto for free. **No chat changes needed** once the adapter emits the fields.
- The SDK declaration already has optional `actionFamilyId` (`packages/module-sdk/src/index.ts:521`)
  and `executionPolicy` (`:523`). Partial Task 1 remnants — verify against the plan rather than
  assuming Task 1 is done. **The rest of Task 1's code did not survive the reset.**
- Every built-in family (calendar, chat, commitments, memory) uses `defaultTier: "ask_each_time"`, so
  built-ins prompt too until promoted by hand. Nothing in the tree implements install-grant yet.

## Guardrails (violating any of these is a blocker)

- **Never `git add -A` / `git add .` / `git commit -a` / bare `git commit`.** Stage explicit paths;
  put the paths on the commit itself (`git commit -F <file> -- <paths>`). Another Claude session is
  live in `.claude/worktrees/job-search` with **uncommitted changes to
  `apps/worker/src/external-module-job-handler.ts` and two test files** — your worktree will not have
  them, and you must not touch that tree. `.claude/context-meter.log` is never yours.
- **Never edit an applied migration** (hash-checked). Module SQL lives in the owning module's `sql/`.
- **Gate DB isolation is mandatory.** `export JARVIS_PGDATABASE=<fresh>` (inline does not survive
  backgrounding), DROP+CREATE per run, drop when done. Integration tests do **not** self-isolate.
  Never pipe a gate into `tail` — a pipe returns the filter's exit code and a red gate reads green.
  Read the exit code from a file.
- **Live-path gate.** CI-green plus review is not done. This needs a live end-to-end proof: the plan
  requires **zero cards for ordinary job-search writes and exactly one for activation**. The five-step
  redeploy is build → restage → **restart API** → **re-enable** → restart worker; skipping any step
  leaves the old bundle live.
- Run prettier on every file you touch, docs included. Preserve the authored design system; never
  invent a `jds-*` class.
- No admin private-data bypass, private by default, RLS applies to all actors. Secrets never reach
  responses, logs, job payloads, or AI prompts. `env | grep` is not redaction.
- Do not renumber the plan's tasks. Every meaningful commit needs a short user-facing summary in
  release-note language.

## Environment

Dev API `3097`, web `5197`, reachable at `http://100.64.98.99:5197`. Ben's dev login is
the development sign-in details (kept outside the repository) — **dev DB only**. Postgres schema is `app`, not `public`:
`docker exec jarv1s-postgres psql -U postgres -d jarv1s`. `jarv1s-prod-*` containers and the
`10.252` subnet are PROD — never touch. **Ben is mid-test on the shared dev instance: message him
before you restart the API or worker.**

## Start

1. `pnpm install` (fresh worktree has no `node_modules`).
2. Run `/start`, then read the spec and the plan in full.
3. Work Tasks 3 → 4 → 5 in order, TDD, committing per task with explicit paths.
4. Gate with a fresh exported gate DB, then get the live proof.

Report to Ben when Tasks 3–5 are green and the live proof is recorded, or the moment you hit
something the spec does not cover.
