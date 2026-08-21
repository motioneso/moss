# Jarvis — Memory Foundation Handoff

Date: 2026-06-06
Status: Active. This supersedes the alpha-era `docs/HANDOFF.md` (now historical).

> **Read this first when resuming.** It captures the pivot from the alpha scaffold to a
> memory-first foundation, exactly where we stopped, and the next step.

---

## Next Step (start here)

1. **Slice 1c-core is MERGED** (Calendar + Email → owner-or-share; Connectors + AI → owner-only).
   Full gate green: **129 tests / 13 files**. Commits: `18df4ee` (calendar+email), `042fb4a`
   (connectors), `6b08328` (AI action requests INSERT). Code review surfaced 7 findings (all test
   coverage gaps / fragility — no production RLS bugs); the only blocking one (foundation.test.ts
   raw INSERT without ON CONFLICT) was fixed before push. See Review Notes below.
   **Next: plan and execute `slice-1c-1d-structural`** — **notifications**, **chat**, **briefings**.
   These are structurally harder than 1c-core (see below). **Brainstorm the notification redesign
   first** (`superpowers:brainstorming`) before writing the plan (`superpowers:writing-plans`).
2. Read order: this handoff → the spec
   (`docs/superpowers/specs/2026-06-06-memory-data-model-design.md`) → `CLAUDE.md` → the
   `slice-1c-core` plan (for pattern reference).

Do **not** start new product features. The work is bounded to the memory-foundation slices below.

### Review Notes For Next Agent (Slice 1c-core)

Code review (high effort, 7 findings) on the Slice 1c-core diff:

**Fixed before push:**

- `foundation.test.ts` beforeAll share seed used a raw `sql\`INSERT\``without`ON CONFLICT`—
would blow up the UNIQUE constraint on a second test run. Fixed: added`ON CONFLICT (resource_type, resource_id, grantee_user_id) DO NOTHING`.

**Known gaps to carry forward (non-blocking, track for 1d/1f):**

- `calendar-email.test.ts` "serves read-only APIs" test has implicit cross-test share dependency
  (shares for bWorkspace are left over from two preceding `it()` blocks; no beforeAll seeds them).
  Safe in full-suite runs (sequential, `fileParallelism: false`), breaks under `-t` isolation.
- `foundation.test.ts`: no surviving test asserts workspace membership alone CANNOT grant probe
  SELECT access after migration 0018 (negative case was deleted, not replaced).
- `connectors.test.ts`: deleted `missingWorkspaceHeader→400` / `nonMemberWorkspaceHeader→403`
  assertions leave `ensureWorkspaceContext` route guard untested.
- `auth-settings.test.ts`: no API-level test verifies a `SharesRepository`-granted share makes a
  task visible through `GET /api/tasks/:id` (share tests are repository-layer only).
- `tasks.test.ts`: task_activity cross-user isolation test uses `adminUser` as the non-grantee
  stand-in rather than an ordinary unprivileged user.
- `ai-tools.test.ts`: `toEqual([aPrivate, bGrantedToA])` is order-sensitive; relies on seed-time
  `updated_at` equality for the tiebreaker. Not broken today but fragile.

---

## The Pivot (what changed this session)

The alpha scaffold optimized the multi-tenant security/module substrate but had **no memory
architecture** — which is the actual product. We re-centered on a memory-first foundation. The
full, reviewed design is in the spec; the headlines:

- **File over app.** Durable knowledge lives in the user's own tool (Obsidian first, Notion later)
  as portable markdown. Jarvis is the orchestrator, not the store. The `notes` module (DB-row
  notes) is being removed.
- **Split memory model.** Freeform knowledge → vault files (indexed). Structured agent state
  (commitments / open loops, entities, preferences) → typed Postgres records, RLS-protected.
- **Multi-user is first-class** (the real case is two spouses on one instance). Per-user privacy
  via RLS stays; the heavy workspace/role/grant machinery is replaced by a lightweight
  **per-resource `shares`** model (owner OR qualifying share). Platform **roles** (instance-admin)
  remain but govern _abilities only_, never data access.
- **Vault security mirrors the DB.** A new `VaultContext` (filesystem twin of `DataContextDb`)
  scopes all file I/O to a per-user vault root; app-layer isolation now, encryption-ready seam.
- **Local, pluggable embeddings.** Semantic retrieval over a derived pgvector index; embeddings
  run on-box (privacy-first), decoupled from BYOP. The vault is a _source_; the index is derived
  and rebuildable.
- **Brand-driven schema rules.** Structured state carries `provenance` (volunteered | inferred |
  confirmed) and is user-visible/reversible; commitments have a drift-aware lifecycle
  (open → at_risk → slipped → done | renegotiated | dismissed); `preferences` hold persona config.
- **Life-context** (work/personal/family) is a **briefing/focus** concern, not an access boundary.
  Privacy _from_ the agent = don't store it in Jarvis. The agent sees all of its user's data.

## Where We Are

- **Spec (approved):** `docs/superpowers/specs/2026-06-06-memory-data-model-design.md`
- **Slice 1a — MERGED to `main`.** PR #1 squash-merged (`c0bcff0`): `app.shares` table +
  `app.has_share()` + `app.share_level_rank()` + Kysely types + `SharesRepository`. The sharing
  helper is named **`app.has_share`** (renamed from `can_access` during a thermo-nuclear review — it
  answers the **share half only**, so RLS policies must OR it with
  `owner_user_id = app.current_actor_user_id()`, mirroring `app.has_resource_grant`). Full gate
  green: **127 integration tests / 13 files**. Plan:
  `docs/superpowers/plans/2026-06-06-shares-foundation.md`.
- **Slice 1b — MERGED to `main`.** Probe (`0018_probe_owner_or_share.sql`, infra) + Tasks
  (`0019_tasks_owner_or_share.sql`, tasks module) converted to owner-or-share via `app.has_share`;
  full gate green (**127 tests / 13 files**). Commits: `cee6bad` (probe), `004ef65` (tasks + a
  required edit to `packages/notes/sql/0007` — see caveats), `b55f36d` (ai-tools + auth-settings
  test fallout). Plan: `docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md`.
  **Caveats:** (1) editing the already-applied `notes/0007` to drop its stale `tasks_update`
  redefinition changes that migration's checksum — any pre-1b DB must `pnpm db:reset`
  (fresh CI is unaffected); (2) `app.resource_grants` is now **inert for tasks** (and the probe) —
  the admin resource-grants API still records grants but they confer no task access; the dead
  helpers/columns/API path are retired in Slice 1f.
- **Slice 1c-core — MERGED to `main`.** Calendar + Email → owner-or-share (`0020`/`0021`);
  Connectors → owner-only (`0022`); AI action requests INSERT → owner-only (`0023`). Full gate green
  (**129 tests / 13 files**). Commits: `18df4ee` (calendar+email), `042fb4a` (connectors), `6b08328`
  (AI), plus a post-review fix in `foundation.test.ts` (ON CONFLICT on the beforeAll share seed).
  Plan: `docs/superpowers/plans/2026-06-06-slice-1c-core-calendar-email-connectors-ai.md`.
  **Notes:** `connector_account_id` immutability on calendar/email is enforced by a DB trigger
  (`calendar_events_prevent_identity_change`), not the RLS UPDATE WITH CHECK — that's intentional.
  `ai_provider_configs` and `ai_configured_models` needed no migration (already pure owner-only).
- **`main`:** `da496ef` (brand) → `c0bcff0` (Slice 1a) → `CLAUDE.md` → handoff → Slice 1b merge →
  Slice 1c-core. Pushing to `origin/main` now.
- **Obsidian vault:** prior-iteration Jarvis notes archived to `4 Archives/Jarvis-alpha` (1,110
  files). Active `2 Areas/Jarvis/Specs/` mirrors the current-iteration design docs + both slice
  plans (git is canonical; vault copies are for remote review).

## Slice Roadmap

**Slice 1 — workspace → shares teardown** (full teardown; keep all modules). Sub-plans:

1. ✅ **1a Shares foundation** — `app.shares` + `app.has_share` + types + repository. **MERGED (PR #1).**
2. ✅ **1b Probe + Tasks → owner-or-share** — migrations `0018`/`0019`. **MERGED to `main`.**
3. ✅ **1c-core** — Calendar + Email → owner-or-share; Connectors + AI → owner-only.
   **MERGED to `main`.** (`2026-06-06-slice-1c-core-calendar-email-connectors-ai.md`)
4. **1c/1d-structural** — Notifications (recipient-owned redesign), Chat, Briefings (parent-child
   share inheritance + worker grants). **Needs brainstorm + plan.** Replaces the original flat
   "1c (Notifications/Connectors/Calendar/Email)" + "1d (AI/Chat/Briefings)" split — the audit showed
   Connectors/Calendar/Email/AI are the easy batch and Notifications/Chat/Briefings are the
   structural ones, so the work was re-grouped by difficulty rather than by the old numbering.
5. **1e** — remove the **Notes** module entirely.
6. **1f** — drop workspace tables + legacy functions; remove `workspace_id` from `AccessContext`,
   the auth resolver, and the web `x-jarvis-workspace-id` header; retire Settings
   workspace/membership APIs. `AccessContext` becomes `{ actorUserId, requestId }`.

`workspace_id` stays in the context until 1f so each module converts independently and tests stay
green throughout.

**Slice 2 — Vault + `VaultContext`:** per-user vault root, optional import, traversal-safe I/O,
OS perms, encryption-ready seam.

**Slice 3 — Memory index + retrieval:** pgvector infra (swap to a pgvector-enabled Postgres image

- `CREATE EXTENSION vector`), ingestion pipeline, local `EmbeddingProvider`, `retrieve()` with
  provenance, rebuild.

**Slice 4 — Structured state + write-back:** `commitments`, `entities`, `preferences`;
frontmatter(machine)/body(human) write-back; entity ↔ People-note linking.

(BYOP / capability router, the proactivity engine, and curation/feeds are later, separate specs —
they read/write the model these slices build.)

## How to Resume (workflow + environment)

- **Read order:** this handoff → the spec → `CLAUDE.md` → `docs/DEVELOPMENT_STANDARDS.md`.
- **Workflow:** `superpowers:brainstorming` (only if design questions remain) →
  `superpowers:writing-plans` → `superpowers:subagent-driven-development`. Implementers on Sonnet;
  controller reviews (spec compliance + code quality) between tasks; commit per task.
- **Environment gotcha:** `pnpm` is reached via the corepack shim — ensure `~/.local/bin` is on
  PATH (`export PATH="$HOME/.local/bin:$PATH"`), or run `corepack pnpm <script>` (note: composite
  scripts like `verify:foundation`/`typecheck` call bare `pnpm` internally, so the PATH shim is the
  reliable option). Start Postgres with `pnpm db:up` before any integration test.
- **Gate before claiming done:** `pnpm verify:foundation` (lint, format:check, check:file-size,
  typecheck, db:migrate, test:integration). Keep it green.
- **Specs are mirrored** to `~/obsidian-vault/2 Areas/Jarvis/Specs/` for remote review (git is
  canonical).

## Invariants to Preserve

- Admin/owner power is _ability_ power, never private-data read power. No admin RLS bypass.
- Per-user privacy via `FORCE ROW LEVEL SECURITY`; access = owner OR qualifying `share`.
- Runtime app/worker roles never own protected tables or hold `BYPASSRLS`.
- Repositories take only the branded `DataContextDb`; (later) vault I/O only via `VaultContext`.
- pg-boss payloads are metadata-only. Secrets never reach responses, logs, payloads, or exports.
- New features are additive packages connecting via stable interfaces — don't modify core casually
  (the Slice 1 teardown is the deliberate one-time exception that _creates_ the clean seams).
- TDD for all new work; respect the 1000-line file ceiling and the maintainability bar.

## Historical

- Alpha-era handoff: `docs/HANDOFF.md` (M1–M7 platform scaffold). Retained for reference.
- Alpha architecture decisions: `docs/architecture/`.
- Brand brief (still current, shapes product decisions): `docs/brand/brand-brief.md`.
