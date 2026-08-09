# Wave 3 — Action and audit truth (the trust surface)

**Date:** 2026-08-09
**Status:** Approved by Ben on 2026-08-09 (both design forks settled — see "Design forks — settled").
**Tracking epic:** #1470 (batches "Security, privacy, and trust boundaries" + "Runtime and data correctness")
**Issues:** #1256, #1252, #1251 (lane A) · #1055 (lane B) · #1136 (lane C)
**Grounded on:** `origin/main` = `c8946358f` (Wave 2 fully merged; PRs #1476–#1480 landed 2026-08-09)

## Context

Wave 1 and Wave 2 burned down ten mechanical defects. This wave is deliberately harder: it fixes
the surfaces the project reaches for to answer _"did that actually happen, and was it allowed?"_ —
the confirmation registry, the action audit log, the operator log, and the prompt boundary.

Three findings from #1234 (JS-03) UAT plus one cross-model review finding say those answers are
currently unreliable. None of them is a one-line fix, and two of them (#1252, #1254) are protocol
decisions rather than local patches.

**#1256's cited spec does not exist.** The issue points at
`docs/superpowers/specs/2026-07-25-1250-1253-approval-request-lifecycle.md`; that file is not in
the repo on `c8946358f`. This spec supersedes that pointer for the #1256 fix.

## Goals

- **#1256** — `POST /api/ai/assistant-actions/:id/resolve` must go through
  `gateway.resolveActionRequest`, inheriting the fail-closed no-live-waiter guard and the
  owner-match check, and must unblock a live waiter.
- **#1252** — an external-module tool that returns a self-reported failure must record
  `outcome != 'success'` in `app.moss_action_audit_log`.
- **#1251** — a handler throw must reach the operator log with the real error, tool name, and
  requestId, while the model keeps seeing exactly `Tool <name> failed`.
- **#1055** — `TasksRepository.create`'s idempotency probe must consider only the actor's own rows.
- **#1136** — persona/role-marker neutralization must apply to _all_ third-party text entering the
  codex prompt, including the `replayBatch` recalled-memory and cross-tool-summary paths.

## Non-goals

- No change to what the **model** sees on a handler failure — the sanitized `Tool <name> failed`
  return value is a deliberate secrets boundary and stays byte-identical.
- **#1249** (`risk: "outbound"`) is explicitly out of this wave. It is a six-file contract sweep
  plus a new migration, it collides with lane A in `packages/ai`, and it buys zero behaviour change
  today. It gets its own wave after this one lands.
- **#1254** (plain-English approval labels) is out of this wave — it is a manifest contract change
  and belongs with the chat-surface wave.
- No deletion of the `/resolve` route. It is manifest-declared public API
  (`packages/ai/src/manifest.ts`, `permissionId: "ai.assistant-actions"`) and install-time grants
  (#1246) may reference its id.
- No new logging/metrics subsystem, no reliability dashboard, no audit-log schema redesign beyond
  what #1252's error channel strictly requires.

## Lanes, tiers, and collision map

Lanes are module-disjoint. Lane A is internally sequential — all three of its issues edit
`packages/ai/src/gateway/gateway.ts` and must not be split across builders.

| Lane | Issues              | Tier         | Module (exclusive)       | Intended seam                                                                                                                                                                                                                                 |
| ---- | ------------------- | ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | #1256, #1252, #1251 | **security** | `packages/ai`            | `packages/ai/src/routes.ts:534` (`/api/ai/assistant-actions/:id/resolve`); `packages/ai/src/gateway/gateway.ts` — outcome derivation (`:193`, `:212`, `:564`), bare catches (`:387`, `:473`, `:599`, `:680`), owner/waiter guard (`:388-390`) |
| B    | #1055               | **security** | `packages/tasks`         | `packages/tasks/src/repository.ts` — `create()` idempotency probe on `(source, external_key)`                                                                                                                                                 |
| C    | #1136               | **security** | `packages/chat/src/live` | `packages/chat/src/live/codex-exec-session.ts` (the issue's `codex-exec.ts` path is stale) and `packages/chat/src/live/prompt-safety.ts`                                                                                                      |

**Tier rationale (mechanical, per the coordinate skill):** lane A touches a confirmation/consent
boundary and a policy-relevant audit record; lane B is an RLS owner-scoping correction; lane C is a
prompt-injection boundary. All three hit a `security` trigger, so all three take Opus adversarial
QA, a mandatory `gh pr comment` verdict, and Ben's explicit merge sign-off.

## Resolved decisions

- **#1256 response shape.** The route keeps its declared id and permission. If
  `gateway.resolveActionRequest` returns an outcome the current response schema cannot express, that
  is an **additive** field on the existing declared route — never a route rename or removal, because
  manifest routes are public API.
- **#1256 drift guard.** A test asserts the `packages/ai` route and the `packages/chat`
  route (`packages/chat/src/routes.ts:385`) return identical outcomes for the same request id,
  including the expired case.
- **#1251 log shape.** `logger.error` inside each bare catch, carrying tool name, requestId, and the
  real error. Sanitization applies to the **return value only**, not the operator log. The operator
  log is not a model-visible surface.
- **#1252 error channel — SETTLED (Ben, 2026-08-09): a reserved sentinel key, `__moduleError`.**
  A module reports failure by returning a payload carrying `__moduleError`; the worker boundary
  recognizes it and maps it to `ok: false` with an `errorClass`, instead of inferring failure from
  the envelope at `gateway.ts:200-201` / `:240-241`.
  - _Why this over the alternatives:_ a typed `{ok, data|error}` envelope would break every existing
    module's return shape; a thrown marker class loses its identity crossing the worker boundary
    (external modules are serialized JSON, not shared objects). The sentinel is additive, survives
    serialization, and needs no module rewrite.
  - The key is **reserved and documented in the SDK** so it cannot be mistaken for a legitimate
    payload field.
  - The audit `outcome` CHECK already accepts `'failed' | 'denied' | 'cancelled' | 'invalid' |
'conflict'` after migration `0177` (on `app.moss_action_audit_log`, renamed by `0183`) — **no new
    migration is needed**, and this spec introduces no new outcome value.
- **#1252 back-compatibility — SETTLED: no heuristic.** A module that has not adopted `__moduleError`
  keeps recording `success`. Sniffing for shapes like `{ status: "error" }` would misclassify
  legitimate payloads that happen to use those keys, and would make the audit log wrong in a _new_
  way. The honest answer — "only modules that opt in get truthful audit rows" — is documented in the
  SDK and stated on the issue when it closes.
- **#1055 fix.** Scope the probe to `owner_user_id = current_actor` (or query the owner-only path)
  so the owner-or-share `tasks_select` view can never make another owner's row read as a duplicate.

## Design forks — settled

Both forks this wave carried are closed. Ben approved the recommendations on 2026-08-09; the
resolutions are recorded above under **Resolved decisions** (`__moduleError` sentinel key; no
back-compat heuristic). **No open forks remain — lane A may plan against this spec as written.**

## Exit criteria

- #1256: a focused test proves the `/resolve` route fails closed with no live waiter, unblocks a
  live waiter when one exists, and matches the chat route's outcome — including the expired case.
- #1252: a test proves a module tool returning the reserved `__moduleError` key records a
  non-success audit outcome with an `errorClass`; that the existing envelope-derived path is
  unchanged for tools that throw; and that a module which has _not_ adopted the key behaves exactly
  as it does today (the documented, accepted back-compat gap).
- #1251: a test proves the operator log receives the real error while the returned string stays
  exactly `Tool <name> failed`. A negative assertion proves no secret or handler internal reaches
  the model-visible return value.
- #1055: a cross-owner fixture proves `create()` no longer treats another owner's shared row as a
  duplicate, and that same-owner dedupe still works.
- #1136: a test proves persona/role markers (`User:`, `Assistant:`, system-style headers) are
  neutralized on direct input **and** on `replayBatch` recalled-memory and cross-tool-summary text,
  with explicit untrusted-data fencing.
- Every lane carries an Opus adversarial QA verdict posted as a `gh pr comment`.
- Lane A carries live-path proof: a real approve/deny through the real UI on a live dev instance,
  plus the resulting audit row.

## Dependency and merge order

Lanes A, B, and C touch disjoint modules and may build in parallel. Merge B → C → A (increasing
blast radius). Every lane rebases on current `main` and receives fresh independent QA after each
earlier merge. Ben signs each merge individually — all three are security tier.

## Hard invariants honored

- **No admin private-data bypass / private by default.** Lane B _tightens_ owner scoping; nothing in
  this wave widens an RLS predicate or adds `BYPASSRLS`.
- **Secrets never escape.** Lane A's #1251 change is explicitly designed so the widened visibility
  reaches the operator log only, never the model, a response, a pg-boss payload, or an export. Lane
  C strengthens the same boundary in the opposite direction.
- **Metadata-only job payloads.** #1252's error channel carries an `error_class`, never a message
  body, prompt, or private content.
- **Module isolation.** #1252 changes only the declared module→host result contract; no lane imports
  another module's internals or queries its tables.
- **Never edit an applied migration.** No lane edits `0127`, `0177`, or `0183`. No lane adds a
  migration at all under the decisions above; if #1252's chosen shape forces one, it is a new file
  at `0185+` and the `foundation.test.ts` list row is added in the same PR.
- **Provider-agnostic AI.** No lane hardcodes a provider or model name.
- **`AccessContext`.** Untouched — no field added, `workspaceId` stays gone.

## Process gates

- This spec is a **draft**; it needs Ben's approval before any lane is dispatched.
- All five issues already exist on GitHub. No new `task` issue is required for this wave.
- Live-Path Gate binds lane A (user-facing approval surface). Lanes B and C are internal and take
  focused automated evidence plus adversarial QA.
