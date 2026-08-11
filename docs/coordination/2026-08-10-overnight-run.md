# Coordination Run — 2026-08-10 overnight

**Date:** 2026-08-10
**Coordinator lock:** label `Coordinator`, stable anchor = Codex session id `019fef6b-8f40-7453-a6f9-4c3e245dce52`. Exactly one pane with this label and session holds merge authority.
**Delegated authority:** Ben explicitly delegated overnight product/design decisions to Fable and confirmed that Fable's green security review counts as his security-tier merge sign-off. Existing repository rule still applies: #1557 never merges without fresh Fable approval. Every delegated security sign-off must be durable on the exact-head PR.
**Merge policy:** routine/sensitive only after verified QA and live-path proof where applicable; security only after adversarial Fable QA and delegated sign-off.
**Merge notification:** after every merge, run `needs-ben coordinator "<issue/PR — one-line description of what landed>"` and retain the normal GitHub/project bookkeeping.
**merges_since_relay:** 1

GitHub/project 2 is the source of truth. Detailed continuation evidence stays in `/tmp/jarv1s-monitor-state.md`.

## Queue

| Spec | Issue | Tier | Status | Agent label | Branch | PR |
| ---- | ----- | ---- | ------ | ----------- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md` | #1557 | sensitive | Fable ruling resolved; final-head rebuild/UAT pending | `Fable #1557 UAT ruling` | `1557-p1-persistent-adapter` | #1561 |
| `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md` | #1121 | sensitive | draft PR, docs CI + Fable approval pending | collaboration agent `spec_1486_proxy` (redirected) | `docs/1121-scriptable-chat` | #1565 |
| `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` | #1533 | sensitive | implementation planning/building | `Issue #1533 chat surface` | `build/1533-chat-surface-routing` | #1563 spec merged as `abfe0478b1` |
| Fable ruling comment + issue acceptance | #1564 | routine | wrap-up successor pushing/opening PR | `Issue #1564 wrap` | `fix/1564-trigger-map` | — |
| issue #1560 acceptance | #1560 | routine | planning/building | `Issue #1560 name flash` | `fix/1560-assistant-name-flash` | — |

## Ready-after-current lanes

- #1547 — Job Search manual-run idempotency race (sensitive).
- #1560 — assistant-name loading flash (routine).
- #1434 — page-context throttle/rate-limit behavior (security by mechanical tier rule).
- #1555 — AI capability-selection timeout investigation (sensitive).
- #1352 — CLI-runner liveness accounting (sensitive; current mode disabled).
- #1486 — proxy trust boundary (security; design pass required).
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
- [ ] Fable: approve #1121 and #1533 specs before build.

## Reaped sessions

- Old Coordinator session `019fe9e2-7fc6-7243-9894-d258562db9a6` closed after successor drive was confirmed.
- #1564 build session `ddf1eb71-08b3-4cd3-ab5e-1cf53d4c4bd1` reaped after wrap successor `5d0306dd-5acb-48f9-b079-d28013bac037` visibly began in the same worktree.
