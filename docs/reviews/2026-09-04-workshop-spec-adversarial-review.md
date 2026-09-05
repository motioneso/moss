# Adversarial review: Workshop projects and supervised builds spec

Date: 2026-09-04. Reviewer: Fable 5.1. Subject:
`docs/superpowers/specs/2026-09-04-workshop-projects-and-supervised-builds.md`. Checked against
HEAD `cd0468307`.

Verdict: product direction sound; not ready as an implementation contract. Technical claims
verified true: `resolveModelForService` defaults `tierHint` to economy (`packages/ai/src/repository.ts:1234`);
`EngineLaunchOpts.model` exists (`packages/chat/src/live/types.ts:89`); `shipExternalModule` sets
`owner_user_id: null` (`packages/settings/src/repository-external-modules.ts:505`); every named seam
file exists; #2023 is OPEN, label RFA, no milestone. No named seam changed between `bedfb0382` and HEAD.

## Blockers

1. **First deliverable may be infeasible today.** Word of the Day "saved words through host storage".
   `packages/module-sdk/src/external-module.ts:318` says `storage` declarations are REJECTED at load;
   only the worker context has `kv` (`packages/module-sdk/src/worker.ts:103`). If a generated page
   cannot persist per-user data, slice 4 hides a new platform capability. Verify before planning.
2. **Module isolation.** `app.module_builds` is owned by settings (`packages/settings/sql/0189`, `0195`,
   `0198`). Spec keeps it, links Workshop projects to it, adds lease/attempt columns, and puts Workshop
   SQL in `packages/workshop/sql/`. Cross-module table access violates the isolation invariant. Decide:
   move build records to Workshop, or expose a settings public API.
3. **Confinement deferred into slice 3.** "Choose the simplest OS/container mechanism" is a design
   decision with prod impact (worker runs in Docker per `infra/docker-compose.prod.yml`; user-namespace
   sandboxes are often unavailable in containers). Needs its own spec + same-PR prod config.
4. **Design gate half met.** Standards require agreed mockups of every screen incl. empty/loading/broken,
   naming primitives. Prototype uses ~8 `jds-*` classes and 37 local `ws-*` classes on the happy path;
   spec defers ~12 error/loading states to implementation unmocked. "Host-rendered declarative
   mockup" has no format, renderer or vocabulary defined.

## Significant

5. Private finish touches core: registry, nav, app map, web loader, worker access, removal all need an
   owner filter. Enumerate the consumers now.
6. Planning dead-end: single pinned interactive model + no override + no new settings screen = planning
   stops with "configuration needed". Name the existing settings path and confirm the Workshop planning
   service can be bound there.
7. Live proof steps 5/6/8 need forced failure, unavailable model, worker restart, but simulated controls
   never ship. Name the real mechanism for each.
8. Slices exceed one session each (slice 3 = protocol + fencing + cancel + host checks + sandbox).
   Re-slice per the one-session-per-task ruling.

## Minor

- `workshop.view` permission copy says "instance-wide module builds"; owner isolation changes that.
- Release-note section not mentioned.
- Evidence commit is four merges behind HEAD (no seam drift).
