# CLAUDE.md

Decisions and gotchas that the source code can't tell you. Anything discoverable — commands, file
layout, naming, conventions — read from the repo instead of trusting this file.

## Orientation

GitHub is the source of truth for status: the project board, milestones, and issue links, not this
file and not a doc. **The live board is project 2, "Issue and Roadmap Work"** — projects 1 and 3 are
archived and stop at #1270 and #427, so a query against either finds nothing current and reads as
"never tracked". Read `docs/DEVELOPMENT_STANDARDS.md` before broad feature work or reviews.

Full local gate: `pnpm verify:foundation` — never run it, or any DB-touching test command, without
the `verify-gate` skill. An unscoped run hits the live dev database; a piped one reads red as
green; a green local gate still excludes CI's e2e step.

## Hard invariants

Deliberate decisions, each with a real failure behind it. Violating one is a blocker.

- **No admin private-data bypass.** Admin power is configuration power only. RLS applies to every
  actor including admins. No `BYPASSRLS` on runtime app or worker roles.
- **Private by default.** Owner-only unless explicitly shared; cross-user access needs an explicit
  grant.
- **Secrets never escape.** Connector/AI credentials, auth tokens, password hashes and session tokens
  never reach frontend responses, logs, pg-boss payloads, user exports, or AI prompts. Connector/AI
  secrets are AES-256-GCM at rest.
- **Metadata-only job payloads.** pg-boss carries actor/resource IDs, job kind, idempotency key and
  small command params. Never private content, prompts, or secrets.
- **Vault I/O goes through `VaultContext`** — never raw `fs`. (The `DataContextDb` brand enforces the
  database half of this at compile time; the filesystem half has no such guard.)
- **Don't re-add fields to `AccessContext`.** It carries `actorUserId` and `requestId`. `workspaceId`
  was removed on purpose in Slice 1f — reintroducing it re-opens a closed design.
- **Provider-agnostic AI.** Features request capabilities; the router picks the user's configured
  model. Never hardcode a provider or model name.
- **Module isolation.** Modules collaborate only through declared public APIs and events — never by
  importing another module's internals or querying its tables.
- **Never edit an applied migration.** The runner hash-checks applied files, so an edit breaks every
  existing install. Add a new file. Module SQL lives in the owning module's `sql/`, never in
  `infra/postgres/migrations/`.
- **pgvector image.** Compose must use a pgvector-enabled Postgres image, not plain Postgres.
- **A PR must never break prod.** If a change makes a setting/env var required (a guard that now
  fails closed without it, a newly-mandatory config key), the same PR must also add it to every
  deployment config it affects (dev + prod compose/env), not a follow-up. Don't stop and ask Ben
  which he prefers — add it to the PR by default; only escalate if you can't tell which config
  file(s) apply. Ben's ruling, 2026-08-16 (#1468): "a pr must never break prod."

## Process gates

- **Spec before build.** No new feature or module without an approved design spec in
  `docs/superpowers/specs/`, and a GitHub `task` issue to build against.
- **Keep Moss's app map truthful.** Every product change — including a feature, setting, screen,
  navigation path, requirement, error, or remediation — updates the app-map declarations in the
  same PR. Core screens/settings live in `packages/shared/src/app-map-core.ts`; module-owned
  surfaces and behavior live in the owning manifest's `navigation`, `settings`, and `features`
  metadata. A stale or missing map entry is a blocker, not follow-up work. Full rule in
  `docs/DEVELOPMENT_STANDARDS.md` → App Map Truthfulness.
- **Design the front end before building a module.** A new module needs a front-end design
  discussion with Ben and agreed mockups of every screen, in the spec, before implementation.
  Full rule in `docs/DEVELOPMENT_STANDARDS.md` → Design System Guardrails.
- **Live-path gate.** CI-green plus code review does not make a user-facing feature done. It needs
  live end-to-end proof recorded on the PR — installed and exercised through the real UI on a live
  dev instance. Without that the honest status is _code-complete, unverified_: don't merge, don't
  mark Done. Full rule in `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.
- **Every product pull request fills in the "Release note" section of the PR template.** If the
  change is user-facing, give it a Category (Added/Fixed/Changed), a short Title, and a one-sentence
  plain-English Description. After the pull request merges, the release-notes workflow reads that
  section, updates the date-grouped `docs/WHATS_NEW.md`, and opens or updates a separate release-note
  pull request through protected `main`; it never pushes `main` directly. If the change isn't
  user-visible, write `Category: N/A` and touch nothing else. The Description is read by non-technical
  users — no code names, file paths, or internal jargon.

## Working in a shared checkout

Several agent sessions may share this working tree at once. **Never `git add -A` / `git add .`,
never bare-`git commit`, and never `checkout`/`stash`/`reset` while another session is mid-run.**
Before any commit or tree-wide git action here, use the `shared-checkout` skill — even a
path-scoped commit is unsafe on a co-edited file, and the skill has the only safe procedure.

## Scope guardrails

- **Do not casually build:** real OAuth callbacks, real connector sync, full email/calendar clients,
  a module marketplace, a workflow engine. Each needs its own milestone and spec.
- **The design system is authored, not generated.** Before any UI, CSS, or component work, use the
  `design-system` skill — `jds-*` primitives, `tokens.css` typography rules, and the audit that
  catches invented classes.
- Keep plain Fastify REST plus shared TypeScript contracts (`packages/shared/*-api.ts`) unless a
  milestone explicitly justifies a heavier contract layer.
- Write `~/Jarv1s` rather than absolute local paths in docs, specs and handoffs.

## Memory

Use the `codebase-memory` skill for code structure questions (graph search, call traces, impact
analysis) before making architectural claims.

Nothing in a task will prompt you to write memory down, so treat these as save triggers — call
`memory_save` when they happen, not at end of session:

- a non-obvious architectural decision, with why X over Y
- a confirmed invariant or ordering constraint
- a trap that caused a real error
- an RLS classification (owner-only / owner-or-share / recipient-only)
- a shift in project state (milestone reached, known-good migration or test counts)

Use `project: "jarv1s"` and type `architecture` | `bug` | `fact` | `pattern`. Never store secrets or
private data.
