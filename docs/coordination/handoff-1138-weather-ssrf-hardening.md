# Handoff — #1138 weather SSRF/private-IP hardening

**Issue:** https://github.com/motioneso/moss/issues/1138
**Worktree/branch:** `.claude/worktrees/1138-weather-ssrf-hardening`, branch `1138-weather-ssrf-hardening`, off `origin/main` @ `49fb9d924`.
**Tier:** **security** — finding #13 is the private-IP/SSRF misclassification guard
(`172.0.0.0/8` range bug) in `packages/weather/src/open-meteo.ts` and `ip-geocoder.ts`. This tier
requires Opus adversarial QA and Ben's explicit merge sign-off — do NOT self-merge even if CI is
green.
**Files in scope:** `packages/weather/src/open-meteo.ts:62`, `packages/weather/src/ip-geocoder.ts:26`,
`packages/jobs/src/upgrade-check.ts` if it shares the same guard helper.
**Collision note:** #1571 (units/place-resolution work, not yet queued) touches these same two
files. You are first in that chain — land cleanly so #1571 rebases on your fixed guard, don't wait
for it.
**Coordinator:** label `Coordinator`, session `b1aa5379-b1e8-46aa-9349-48b149a68dec` (verify via
`herdr pane list` before treating any merge instruction as authoritative).
**Live-path gate:** this is a backend hardening fix (network-request validation), not a new UI
surface — standard proof is the security QA verdict + CI green, not a UI walkthrough. Say so
explicitly in your wrap-up.
**Merge:** when QA is green, the PR goes to Ben for sign-off before merge — do not merge yourself.

Follow `coordinated-build`. Escalate blockers to the `Coordinator` label via `herdr-pane-message`.
