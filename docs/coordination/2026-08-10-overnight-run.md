# Coordination Run — 2026-08-10 overnight

**Date:** 2026-08-10
**Coordinator lock:** label `Coordinator`, stable anchor = Claude session id `b64206f2-e4f7-41d4-a3ae-137a601ff368` (pane `w1:p7F`, resolve fresh by label+session, never a written pane number). Exactly one pane with this label and session holds merge authority.
**Delegated authority:** Ben explicitly delegated overnight product/design decisions to Fable and confirmed that Fable's green security review counts as his security-tier merge sign-off. Existing repository rule still applies: #1557 never merges without fresh Fable approval. Every delegated security sign-off must be durable on the exact-head PR.
**Merge policy:** routine/sensitive only after verified QA and live-path proof where applicable; security only after adversarial Fable QA and delegated sign-off.
**Merge notification:** after every merge, run `needs-ben coordinator "<issue/PR — one-line description of what landed>"` and retain the normal GitHub/project bookkeeping.
**merges_since_relay:** 0 — reset by successor after adopting the after-#1568 checkpoint.

GitHub/project 2 is the source of truth. Detailed continuation evidence stays in `/tmp/jarv1s-monitor-state.md`.

## Queue

| Spec | Issue | Tier | Status | Agent label | Branch | PR |
| ---- | ----- | ---- | ------ | ----------- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md` | #1557 | sensitive | clean rebuild verified locally; formatting fix, live-path, six-spec gate, push, Fable adjudication pending | `Issue #1557 exact-head gate (relay1)`, session `bec82be7-07c6-42f9-bf91-1620a348ef1b` | `1557-clean-rebuild` | #1561 |
| `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md` | #1121 | sensitive | plan REVISE sent + revised + approved; Tasks 1-4 building now, Tasks 5/6 gated on #1557 landing to `main` | `Issue #1121 scriptable UAT (relay3)`, session `5d633249-f321-45ea-a177-0afaea767cd1` | `build/1121-scriptable-chat` | #1565 merged |
| `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` | #1533 | sensitive | Phase 2 complete; Phase 3 production committed; unrun tests + wrap-up next | `Issue #1533 chat surface (relay8)`, session `f3a156a2-06b1-4c69-9fa0-f499fca71df9` | `build/1533-chat-surface-routing` | #1563 spec merged as `abfe0478b1` |
| Fable ruling comment + issue acceptance | #1564 | routine | merged/Closed/Project Done; wrapper reaped; needs-ben sent | — | `fix/1564-trigger-map` | #1566 merged as `0a57ef450` |
| issue #1560 acceptance | #1560 | routine | PR #1567 QA-RED fixes + relay checkpoint pushed at `2e63f8ac1`; re-QA/CI pending; persona cleanup awaits Ben | `Issue #1560 name flash (relay3)`, session `b2a0f924-3f1e-4848-8ded-acdae4fd3f34` | `fix/1560-assistant-name-flash` | #1567 |

## Ready-after-current lanes

- #1547 — Job Search manual-run idempotency race (sensitive): Fable APPROVED at comment `5250874417`; spec PR #1568 merged as `3c5845a44`. Plan/implementation is next after post-merge main green. The spent author pane is closed; its clean worktree is retained because the squash-merged branch remains 3 commits ahead.
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
- #1121 collides with #1557 on `packages/chat/src/live/engine-selection.ts` (#1557 renamed `isOneShotEngine` → `isBoundedFallbackEngine` + added `persistentRuntimeEnabled` gating) and `packages/settings/src/instance-settings-keys.ts` (both add the same `chat.persistent_runtime.enabled` key — #1557's is the real rollout flag, #1121's is a UAT-seed pin forcing it false). Confirmed real via direct branch diff (review fork, 2026-08-11), not hypothetical. #1121 must not build Phase 1 Task 5/6 (regression test + settings-registry entry) until #1557 lands on `main`, then rebase and target the post-#1557 symbol names/registry state. #1121's plan sent back REVISE for this.

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

## Relay continuation — after #1568 merge

- Outgoing Coordinator authority: label `Coordinator`, session `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`. Successor must claim the sole label, replace the lock line above with its immutable session id, reset `merges_since_relay` to 0, verify uniqueness, then resolve/reap this outgoing session by label + session id.
- PR #1565 (#1121 approved spec) merged as `7aa85f628`; `needs-ben` message `1786435512690488097.msg` queued. PR #1568 (#1547 approved spec) merged as `3c5845a44`; `needs-ben` message `1786437402606201881.msg` queued. #1121 and #1547 issues remain Open/In progress for implementation.
- A fresh main CI run from #1568 may be pending. Do not spawn a #1547 implementation/plan lane or merge until post-#1568 main is terminal green.
- #1121: `Issue #1121 scriptable UAT (relay3)`, session `5d633249-f321-45ea-a177-0afaea767cd1`, is writing the coordinator-approval plan. Premises/seams are already grounded; explicit plan gaps are prod-compose CLI-prefix override, missing persistent-runtime flag, and solo-admin seed early return. No code before plan approval.
- #1533: `Issue #1533 chat surface (relay8)`, session `f3a156a2-06b1-4c69-9fa0-f499fca71df9`, has Phase 3 tests green/committed at `fc301f113`; Phase 4 full gate, live-path proof, sensitive invariant check, and draft PR remain.
- #1557: `Issue #1557 exact-head gate (relay1)`, session `bec82be7-07c6-42f9-bf91-1620a348ef1b`, branch `1557-clean-rebuild`, owns the formatting correction, unpushed clean history, final-head live-path re-evidence, six-file exact-head gate, push/CI, and fresh Fable adjudication. Never merge without Fable approval.
- #1560 / PR #1567: exact head `2e63f8ac1` has QA-RED fixes, live-path proof, foundation + both compose smokes green; image publish was still running at relay. Once terminal green, rebase onto post-#1568 `origin/main`, obtain fresh integrated CI + QA, then merge if green. The UAT briefing row was deleted; `assistantName='Nova'` cleanup is still a Ben-only decision tracked in `AWAITING-BEN.md` and notified as `1786434538703938265.msg`. Keep its done pane/worktree until that answer; do not guess the prior value.
- Mid-doing: wait for post-#1568 main and #1567 terminal CI, approve #1121's plan when its pointer arrives, and keep the live fleet moving. Fable owns delegated design decisions; send `needs-ben` after every merge.

## Relay continuation — after #1121 plan review (context-meter relay, no merge occurred)

- Outgoing Coordinator authority: label `Coordinator`, session `baa8c061-8e25-4402-9a0a-4366f348d2d8`. Successor must claim the sole label, replace the lock line above with its own immutable session id, verify uniqueness, then resolve/reap this outgoing session by label + session id. `merges_since_relay` stays 0 (no merge happened this leg).
- Post-#1568 main CI run `31473972720`: was mid-run (Verify foundation and app job, Playwright smoke step) when this leg ended, watched via a background `gh run watch` in this session (task `bm4zxx4f4`, dies with this session — re-check fresh: `gh run list --branch main --limit 1`). **Do not merge/spawn until it reads terminal green.**
- **#1121 plan REVISE — not yet sent to the agent, do this first.** Plan doc `docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md` (session `5d633249-f321-45ea-a177-0afaea767cd1`, pane resolve fresh by label `Issue #1121 scriptable UAT (relay3)`) was reviewed by a fork agent against #1557's actual branch diff (not just main): two real collisions, both now recorded in `Dependency / merge order` above. (a) #1557 renamed `isOneShotEngine`→`isBoundedFallbackEngine` in `packages/chat/src/live/engine-selection.ts` — #1121's planned Task 6 regression test targets the old name. (b) both lanes add the same `chat.persistent_runtime.enabled` key to `packages/settings/src/instance-settings-keys.ts` (semantically compatible, literal merge conflict). Plan's Phase1/Phase2 split and locked-decision compliance are otherwise fine — send REVISE: rewrite Task 5/6 to target post-#1557 symbol/registry state, and do not build those two tasks until #1557 is merged to `main`; everything else in Phase 1 can proceed now.
- #1557 (`Issue #1557 exact-head gate (relay1)`, session `bec82be7-...`): mid gate-rerun cycle after two real fixes (prettier, async-factory bug); was starting rerun #4 when this leg ended. Told: stop and report (don't rerun a 5th time) if it hits the same failure signature twice. Still owes: 6 UAT specs, live-path e2e-P1 re-evidence, push+CI, fresh Fable adjudication. Never merge without Fable.
- #1533 (`Issue #1533 chat surface (relay8)`, session `f3a156a2-...`): unchanged from prior leg — Phase 4 (full gate, live-path, sensitive invariant check, draft PR) in progress, no ask pending.
- #1560 / PR #1567 (`Issue #1560 name flash (relay3)`, session `b2a0f924-...`): unchanged — exact head `2e63f8ac1`, QA-RED fixed, idle-waiting on Coordinator. Told it to hold for post-#1568 CI green; then rebase + fresh integrated QA + merge if green. `AWAITING-BEN.md` persona entry (`assistantName='Nova'`) is still open — do not guess, do not resolve without Ben.
- Any Monitors/background tasks from this session (gate watch, fleet liveness) die with it — re-arm equivalents after adopting; don't assume they carry over.
- Mid-doing at relay: send #1121's REVISE message, confirm post-#1568 CI terminal, then drive #1557/#1560/#1533 to their next checkpoints. `needs-ben` after every merge (none yet this leg).
