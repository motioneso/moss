# Issue #1872 — Service Worker image recovery fix

## Assignment

Implement issue #1872 from the approved spec
`docs/superpowers/specs/2026-08-23-service-worker-image-fetch-recovery.md` and the confirmed
diagnosis at https://github.com/motioneso/moss/issues/1872#issuecomment-5384238958.

- Branch/worktree: `1872-service-worker-image-diagnosis`
- Tier: routine, with mandatory live-path proof because this is user-facing
- Coordinator: agent `coordinator`, session `01a02cde-59a6-7900-99d9-aa65f8989e49`
- Collision: no known file collision with the active #1500 shared-form CSS lane

## Plan gate

Invoke `coordinated-build` and use its planning workflow. Produce the smallest root-cause plan and
send only its durable pointer to `coordinator`. Stop before implementation. For run 1834, the
coordinator may authorize implementation only after a separate Fable-model review agent approves
the plan; coordinator inline judgment is not approval.

The plan must retain one deterministic regression check for the exact rejected-fetch behavior and
one live-path proof covering representative article and sports images plus offline navigation.

## Guardrails

- Reuse the confirmed shared Service Worker seam; do not patch Today, News, and Sports separately.
- Do not weaken CSP or bundle the unrelated chat-stream warning.
- Do not touch `docs/coordination/`, run repo-wide formatting, or use broad `git add`.
- Do not implement anything until the coordinator sends the Fable review verdict and explicit go.

## Start

Dependencies are already installed. Read the spec, issue, and diagnosis comment; invoke
`coordinated-build`; write and publish the plan pointer; then wait for Fable review.
