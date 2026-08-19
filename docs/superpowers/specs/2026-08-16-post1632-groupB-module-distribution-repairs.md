# Post-#1632 queue — group B: module install/reconcile distribution repairs

**Date:** 2026-08-16
**Run:** `docs/coordination/post1632-queue-2026-08-16.md`
**Issues:** #1057, #1042, #1223, #1222
**Status:** DRAFT — Ben's 2026-08-17 comment on #1252 confirms his approval of the batch's
Group A spec; whether it extends to this Group B file needs one line of scope confirmation via
the Coordinator's channel. Drafted by Fable 5 under the overnight delegation.

## Context

Four sensitive-tier bugs in the module distribution path (install, reconcile, update, scan), each
with the root cause already diagnosed in the issue body — same lightweight table-spec treatment as
`2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`. All four caused real operator pain:

- #1057 (bug, epic #860): `scripts/module-reconcile.ts` skips an exact-pin
  (`JARVIS_MODULES_ENSURE`) whenever the module is already on disk (`onDisk.has(...) → continue`),
  ignoring the pinned version — contradicting the reconcile spec §7b. Real consequence: prod
  job-search stuck on 0.1.0 while the pin said newer.
- #1042 (bug, needs-spec): the in-app install instructions in
  `apps/web/.../settings-module-registry-section.tsx` tell the operator to run
  `docker compose pull && docker compose up -d`, which silently no-ops when there is no new image
  tag — the module the user just "installed" never appears, with no error anywhere.
- #1223 (bug): the module updater writes its `.prev-<module>` rotation backup as the invoking
  user; a root-owned leftover from a past manual run then EACCES-wedges every later update/remove.
  Prod-verified as part of incident #1193.
- #1222 (bug): the module scanner lists `.prev-*` backup directories as installable modules — Ben
  saw ".prev-job-search" offered in the UI during the same #1193 incident.

#1222 and #1223 are two faces of the same incident and may be built as one lane/PR closing both.

## Goals

- #1057: an exact version pin in `JARVIS_MODULES_ENSURE` is honored even when some version of the
  module is already on disk — reconcile compares the on-disk version to the pin and stages the
  pinned version on mismatch.
- #1042: the in-app install path either genuinely applies the module or tells the operator
  clearly what to do next — no silent no-op instruction survives.
- #1223: a pre-existing `.prev-<module>` backup (any owner) no longer wedges update/remove; the
  updater clears it before rotating, and an impossible-to-clear leftover produces an actionable
  error instead of a bare EACCES.
- #1222: dot-prefixed directories under the modules root are never scanned, listed, or offered as
  installable modules.

## Non-goals

- No runtime two-bundle module loader, hot-reload mechanism, or module marketplace (#1042's "real
  reload" branch is epic-#860 territory — this spec takes the issue's other accepted branch:
  correct the instruction and surface the next step).
- #1057 does not change reconcile semantics beyond the pin comparison — no new pin syntax, no
  range/semver resolution, no unpinned-module behavior change.
- #1223 does not add privilege escalation to delete truly-undeletable files; best-effort clear,
  then a clear error naming the path and required action.
- No changes to module packaging, manifests, or the registry publish path.

## Architecture and scope

| Issue | Tier      | Intended files                                                                                                  | Smallest implementation                                                                                                                                                                                                                                                                                                                              |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1057 | sensitive | `scripts/module-reconcile.ts` + its tests                                                                       | In the ensure loop, replace the bare `onDisk.has(...) → continue` with a version comparison: read the on-disk module's version, `continue` only when it equals the pin; otherwise stage the pinned version through the existing install path. Regression test: on-disk 0.1.0 + pin 0.2.0 → reconcile stages 0.2.0.                                   |
| #1042 | sensitive | `apps/web/src/...settings-module-registry-section.tsx` (+ any copy source it renders); one #1000-style UAT spec | Replace the no-op `pull && up -d` instruction with a command sequence that actually applies a staged module on a running install (per current deploy mechanics), plus explicit "if the module doesn't appear, X" guidance. Design-system skill applies (jds-\* primitives only). UAT spec drives the real operator path via real nav, no deep links. |
| #1223 | sensitive | Module updater backup-rotation code in `packages/module-registry` (build plan pins exact file) + unit tests     | Before rotating to `.prev-<module>`, remove any pre-existing `.prev-<module>` best-effort (tolerating foreign ownership where the process can); if removal is impossible, fail with an actionable error naming the path and the manual fix, before touching the live module dir. Updater runs as uid 1000.                                           |
| #1222 | sensitive | Module scanner/discovery code in `packages/module-registry` (build plan pins exact file) + unit tests           | Skip dot-prefixed directory names in the modules-root scan. Unit test: a `/data/modules/.prev-foo` fixture is absent from scan results and from the installable list.                                                                                                                                                                                |

## Exit criteria

- #1057: regression test proves pin-vs-on-disk mismatch triggers a staged install of the pinned
  version, and an on-disk match still no-ops. Existing reconcile tests stay green.
- #1042: live-path gate applies — this is a user-facing settings surface. Proof recorded on the
  PR: the corrected instruction exercised end-to-end on a live dev instance through the real UI
  (module actually appears after following it), with a committed #1000-style UAT spec. `jds-*`
  class audit clean (no invented classes).
- #1223: unit test with a pre-seeded `.prev-<module>` dir proves update succeeds (backup cleared
  and rotated); the impossible-to-clear branch produces the actionable error, not EACCES.
- #1222: the dot-dir fixture test above; plus no `.prev-*` entry reachable from the settings
  module list.
- No lane changes AccessContext, adds a migration, edits an applied migration, or crosses a
  module boundary; module-registry changes stay inside that package's own code.
- Each PR carries a release-note sentence (#1042 is user-visible: "module install instructions in
  Settings now actually apply the module"; the rest are ops-hardening, say so plainly).
- Sensitive tier: coordinated-build QA pass before merge; issue + board updated after merge.

## Dependency and merge order

- **#1057 collides with wave-2's #1468**, which adds the target-identity guard to the same file
  (`scripts/module-reconcile.ts`) and is already in flight. Serialize: the #1057 lane starts only
  after the #1468 PR merges (or explicitly rebases onto its branch head with fresh QA at the new
  head). Do not run both lanes concurrently on this file in the shared checkout.
- #1222 + #1223 are the same incident (#1193) and both live in `packages/module-registry`'s
  update/scan area — build as **one lane** (one PR may close both) or strictly serialized lanes.
- #1042 is independent of the other three (web app + UAT spec only); any order.

## Hard invariants honored

No RLS, sharing, or AccessContext surface is touched. No secrets enter logs, errors, or UI copy
(#1223's actionable error names a filesystem path only). No migrations. #1042's UI work goes
through the design-system skill and the authored `jds-*` vocabulary. Reconcile keeps routing
installs through the existing staging path — no new direct filesystem writes outside it, and
nothing here touches VaultContext-guarded vault I/O.
