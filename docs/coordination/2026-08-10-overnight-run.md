# Coordination Run — 2026-08-10 overnight

**Date:** 2026-08-10
**Coordinator lock:** label `Coordinator`, stable anchor = Codex session id `019fef6b-8f40-7453-a6f9-4c3e245dce52`. Exactly one pane with this label and session holds merge authority.
**Delegated authority:** Ben explicitly delegated overnight product/design decisions to Fable and confirmed that Fable's green security review counts as his security-tier merge sign-off. Existing repository rule still applies: #1557 never merges without fresh Fable approval. Every delegated security sign-off must be durable on the exact-head PR.
**Merge policy:** routine/sensitive only after verified QA and live-path proof where applicable; security only after adversarial Fable QA and delegated sign-off.
**Merge notification:** after every merge, run `needs-ben coordinator "<issue/PR — one-line description of what landed>"` and retain the normal GitHub/project bookkeeping.
**merges_since_relay:** 0

GitHub/project 2 is the source of truth. Detailed continuation evidence stays in `/tmp/jarv1s-monitor-state.md`.

## Queue

| Spec | Issue | Tier | Status | Agent label | Branch | PR |
| ---- | ----- | ---- | ------ | ----------- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md` | #1557 | sensitive | blocked on Fable UAT ruling | `Fable #1557 UAT ruling` | `1557-p1-persistent-adapter` | #1561 |
| pending #1121 scriptable-UAT spec | #1121 | sensitive | spec-writing | collaboration agent `spec_1486_proxy` (redirected) | `docs/1121-scriptable-chat` | — |
| `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` | #1533 | sensitive | spec-ready, package for approval | collaboration agent `spec_1533_adopt` | `docs/1533-chat-surface-routing` | — |

## Ready-after-current lanes

- #1547 — Job Search manual-run idempotency race (sensitive).
- #1560 — assistant-name loading flash (routine).
- #1434 — page-context throttle/rate-limit behavior (security by mechanical tier rule).
- #1555 — AI capability-selection timeout investigation (sensitive).
- #1352 — CLI-runner liveness accounting (sensitive; current mode disabled).
- #1486 — proxy trust boundary (security; design pass required).
- #1558/#1559 — persistent runtime fast follows (sensitive; blocked until #1557 kill gate passes).

## Dependency / merge order

- #1121 is the prerequisite for the attachments/runtime-context fixmes exposed by #1557's six-file UAT gate.
- #1557 awaits Fable's ruling on the intentionally non-runnable #1089/#1090 UAT file, then prerequisite work and an exact-head gate.
- #1558/#1559 remain serialized after #1557.
- #1533 is independent but shares chat-surface code with #1557; build only after current diff collision is checked against fresh `main`.
- Routine #1560 may run independently once a build slot opens.

## CI waivers

None.

## Outstanding escalations

- [ ] Fable: binding interpretation of #1557's zero-skip gate versus pre-existing unconditional fixmes.
- [ ] Fable: approve #1121 and #1533 specs before build.

## Reaped sessions

- Old Coordinator session `019fe9e2-7fc6-7243-9894-d258562db9a6` closed after successor drive was confirmed.
