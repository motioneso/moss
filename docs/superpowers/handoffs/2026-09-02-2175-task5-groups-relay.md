# Relay — #2175 Lane 2 Task 5 (derived groups + grandfathering)

**Worktree/branch:** `~/Jarv1s/.claude/worktrees/2175-task5-groups-r20`,
`build/2175-task5-groups-r20`. **Relay depth: 1 (this is the only allowed relay for this lane —
if you also hit the 70% trigger with no PR open, stop and report a re-scope, do not relay again.)**

**Coordinator:** agent name `coordinator` (confirm with `herdr agent list` — exactly one live
agent must hold that name before you message it).

## What's done

- Inspected the actual curation/discovery/persistence flow end to end (curation.ts, discovery.ts,
  repository.ts, routes.ts, tool-manifests.ts, mcp-client.ts, openapi-convert.ts) and confirmed
  the spec's premise still holds on this branch: `isGroupOptIn`
  (`packages/integrations/src/curation.ts:10-14`) never fires for MCP because `group` is always
  `""` (`packages/integrations/src/mcp-client.ts:45`).
- Wrote and committed the build plan: `docs/superpowers/plans/2026-09-02-2175-task5-groups.md`
  (commit `b82a12e9e`). It has exact file paths, signatures, the migration DDL, and test cases —
  read it in full before doing anything else, it is short by design.
- Posted the plan pointer to the coordinator via `herdr-pane-message` and it queued successfully
  (confirmed via `herdr pane read`). **No reply/approval had arrived yet when this relay was
  written** — the coordinator pane showed it was mid-relay itself (a mandatory compaction-triggered
  coordinator handoff, unrelated to this lane; see its own manifest note in
  `docs/coordination/2026-08-30-next-ready.md`).

## What's NOT done — no source edits made

Zero implementation code written. Per `coordinated-build`, you may not write source until the
coordinator approves the plan.

## Next concrete step

1. Confirm exactly one live agent named `coordinator` via `herdr agent list`.
2. Check whether it has replied to the plan message already (read its pane, or check your own
   inbox — the reply may have arrived as a message to this agent's name/pane while you were
   relaying). If no reply yet, re-send a short one-line nudge referencing the same plan file path
   and wait — do not re-explain the whole plan again, that wastes the coordinator's context too.
3. Once approved (or if the coordinator flags a fork — resolve that first, don't guess), proceed
   to Task 1 of the plan: `packages/integrations/src/derive-groups.ts` + fixture + unit tests via
   TDD. Read the plan's "Tasks" section only, not the whole plan again if you already have it
   fresh.
4. The plan's biggest open risk: the real 75-tool-name fixture doesn't exist yet. It requires a
   **read-only** `GET /api/integrations/:id` against Ben's live dev connection (names only, no
   secrets — see the plan's "Fixture" section for exactly why that's safe). If dev isn't already
   running, you'll need to start it from source per the memory doc `dev-preview-recipe` — do this
   only when you actually reach that task, not before.

## Guardrails (unchanged from the original brief)

Sensitive tier. Work only in this worktree, explicit paths only. No `docs/coordination/` edits, no
repo-wide format, no prod/port 1533 access, no settings/entity/physical-action change, no protected
evidence mutation. DB tests via `verify-gate` only, isolated databases. Live proof may only be
read-only on normal dev, recorded on the PR. Finish with `coordinated-wrap-up`. This relay is the
one allowed relay for this lane — do not relay again.
