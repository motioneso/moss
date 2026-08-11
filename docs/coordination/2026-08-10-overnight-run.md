# Coordination Run — 2026-08-10 overnight

**Date:** 2026-08-10
**Coordinator lock:** label `Coordinator`, stable anchor = Codex session id `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`. Exactly one pane with this label and session holds merge authority.
**Delegated authority:** Ben explicitly delegated overnight product/design decisions to Fable and confirmed that Fable's green security review counts as his security-tier merge sign-off. Existing repository rule still applies: #1557 never merges without fresh Fable approval. Every delegated security sign-off must be durable on the exact-head PR.
**Merge policy:** routine/sensitive only after verified QA and live-path proof where applicable; security only after adversarial Fable QA and delegated sign-off.
**Merge notification:** after every merge, run `needs-ben coordinator "<issue/PR — one-line description of what landed>"` and retain the normal GitHub/project bookkeeping.
**merges_since_relay:** 0 — successor adopted the post-#1566 checkpoint.

GitHub/project 2 is the source of truth. Detailed continuation evidence stays in `/tmp/jarv1s-monitor-state.md`.

## Queue

| Spec | Issue | Tier | Status | Agent label | Branch | PR |
| ---- | ----- | ---- | ------ | ----------- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md` | #1557 | sensitive | Fable ruling resolved; final-head rebuild/UAT pending | `Fable #1557 UAT ruling` | `1557-p1-persistent-adapter` | #1561 |
| `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md` | #1121 | sensitive | Fable APPROVED at comment 5250004655; PR checks green; merge after post-#1566 main is green | no build agent yet | `docs/1121-scriptable-chat` | #1565 |
| `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` | #1533 | sensitive | Phase 1 production/tests committed; Phase 2 next | `Issue #1533 chat surface (relay4)`, session `0ba62bdf-d339-4947-9045-6298006ff563` | `build/1533-chat-surface-routing` | #1563 spec merged as `abfe0478b1` |
| Fable ruling comment + issue acceptance | #1564 | routine | merged/Closed/Project Done; wrapper reaped; needs-ben sent | — | `fix/1564-trigger-map` | #1566 merged as `0a57ef450` |
| issue #1560 acceptance | #1560 | routine | fix/tests committed; live proof + gate + wrap-up in progress | `Issue #1560 name flash (relay3)`, session `b2a0f924-3f1e-4848-8ded-acdae4fd3f34` | `fix/1560-assistant-name-flash` | pending |

## Ready-after-current lanes

- #1547 — Job Search manual-run idempotency race (sensitive): no spec; deterministic pg-boss bucket-boundary root cause grounded; start spec lane when main is green.
- #1434 — page-context throttle/rate-limit behavior (security by mechanical tier rule): no spec; grounded two-file `useRef` fix; Fable must approve log-only/no-retry.
- #1555 — AI capability-selection timeout investigation (sensitive): no spec; bounded model-discovery fetch + existing fallback is ready without Fable.
- #1352 — CLI-runner liveness accounting (sensitive): blocked behind #1557 collision and frozen-contract Fable ruling.
- #1486 — proxy trust boundary (security): exact-IP design grounded; Fable must rule static Caddy IP vs dedicated network, fail-loud legacy values, and #901 correction.
- #1558/#1559 — persistent runtime fast follows (sensitive; blocked until #1557 kill gate passes).

## Dependency / merge order

- Fable ruled #1557's gate is baseline-identical run-and-record, not zero-skip; #1121 is not a prerequisite.
- #1564's separate trigger-map truth correction lands before #1557's final exact-head UAT run.
- #1557 then rebuilds/pushes its coherent head, runs CI and all six specs once with credentialed real-chat onboarding, records exact pass/skip counts, and requests fresh Fable adjudication.
- #1558/#1559 remain serialized after #1557.
- #1533 is independent but shares chat-surface code with #1557; build only after current diff collision is checked against fresh `main`.
- Routine #1560 runs independently in its own worktree.

## CI waivers

None.

## Outstanding escalations

- [x] Fable: #1557 gate ruling posted at issue comment 5249826990; baseline-identical skips permitted, credentialed real-chat required.
- [x] Fable: #1121 revised spec approved at PR comment 5250004655.
- [x] Fable: #1533 spec approved and merged as `abfe0478b1`.
- [ ] Fable: #1486 security topology/design rulings before spec/build.
- [ ] Fable: #1434 log-only/no-retry policy when its spec PR exists.
- [ ] Fable: #1352 frozen admission-liveness contract change after #1557 lands.

## Reaped sessions

- Old Coordinator session `019fe9e2-7fc6-7243-9894-d258562db9a6` closed after successor drive was confirmed.
- #1564 build session `ddf1eb71-08b3-4cd3-ab5e-1cf53d4c4bd1` reaped after wrap successor `5d0306dd-5acb-48f9-b079-d28013bac037` visibly began in the same worktree.
- #1564 wrapper session `5d0306dd-5acb-48f9-b079-d28013bac037` reaped after #1566 merged and #1564 reached Closed/Done.
- #1533 exhausted sessions through `53494db8-f7e5-446e-91b8-588247bf762a` were reaped only after their successors were visibly driving.
- #1560 exhausted sessions through `fbac9626-7c06-4065-84a1-25a3fd232d8e` were reaped only after their successors were visibly driving.

## Relay continuation — after #1566 merge

- Outgoing Coordinator authority: label `Coordinator`, session `019fef6b-8f40-7453-a6f9-4c3e245dce52`. Successor must claim the sole label, replace the lock line above with its own immutable session id, verify uniqueness, then resolve/reap this outgoing session by label + session id.
- PR #1566 merged at `0a57ef45071b924aff43eb7f30d40521dd50619f`; #1564 is Closed/Project Done and `needs-ben` message `1786433432377368580.msg` was queued.
- Pre-merge main run `31466252224` attempt 2 was fully green after one unrelated transient `ai-tools` timeout on attempt 1. A new main run from #1566 may now be pending; do not merge/spawn until it is green.
- Next merge: PR #1565 (#1121 approved spec) after fresh main-green + sole-lock verification. Send `needs-ben`, then start a fresh #1121 implementation lane from merged main.
- Next new lane: #1547 spec; use the grounded pg-boss boundary findings in `/tmp/jarv1s-monitor-state.md`. Keep #1434 and #1555 behind it unless a quadrant frees.
- #1557: #1564 prerequisite is now landed. Rebuild onto fresh main, remove residue, run exact-head live proof + six-file Fable gate with credentialed real-chat onboarding, then request fresh Fable adjudication. Never merge without it.
- Agents tab `w1:tH` currently has #1533 and #1560 successors; rebuild to a 2x2 quadrant grid as #1121/#1547 panes are added.
