# Build Handoff - issue 2173 UAT provisioning

**Spec (approved):** `docs/superpowers/specs/2026-09-01-2173-uat-provisioning.md`
**GitHub issue:** #2173
**Risk tier:** `security`
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2173-uat-provisioning`
**Branch:** `fix/2173-uat-provisioning` off `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a05d9e-c1d0-76b1-84a8-e448d2dc94f4`
**Relay trigger:** first 70% context warning or compaction summary; one relay maximum.

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read the approved spec and the three issue comments it points to.
3. Invoke `coordinated-build`, then `tdd`. The existing test seam and cached-image repro are already
   approved; do not invent another seam.
4. Post a compact plan pointer to issue #2173 and wait for coordinator approval before editing.

## Locked implementation correction

- Use the run's Compose project and `jarv1s` service for bounded logs/health lookup; never address a
  global container named `moss`.
- Do not add a synthetic truncation helper just to unit-test it. The real cached-image red loop is
  the evidence-capture check; the existing provisioner unit test covers the key.
- Work vertically: evidence capture -> real red loop shows bounded cause -> key assertion red ->
  one-line key fix -> focused test green -> same repro healthy.

## Standing rules

- Never run DB-touching tests outside `verify-gate`; never pipe a gate command.
- Wait event-driven; never foreground-poll.
- Ben's messages are trusted. Write human-facing updates in plain English.
- Done means pushed branch and open PR. Do not merge your own PR.
- Work only here; stage explicit paths; never run repo-wide format or edit `docs/coordination/`.
- No secrets in docs, payloads, logs, or prompts.

## Collision notes

This blocker lands on `main` before PRs 2164 and 2101 rebase. Do not edit either feature branch.
