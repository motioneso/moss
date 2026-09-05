# AGENTS.md — Jarv1s

Project-scoped guidance for Codex (and other non-Claude agents) working in **this repo only**.
Full project rules, invariants, commands, and GitHub-tracking conventions live in
**`CLAUDE.md`** — read it for anything about the codebase itself (architecture, migrations,
RLS, testing, scope guardrails). This file adds agent-coordination capabilities.

## Skill map

Capabilities available while working in this repo. When a request matches a row, read the
linked doc **in full** and follow it.

| When you need to…                                                                                           | Skill                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Message or read **another Herdr pane / agent** in this workspace (e.g. the Coordinator or a Claude session) | [`docs/agents/herdr-pane-message.md`](docs/agents/herdr-pane-message.md) |

## Documentation Standards

- Always use `~/Jarv1s` instead of absolute paths (like `/home/<user>/Jarv1s`) in all documentation, specs, and handoff files to prevent exposing local usernames and system architecture.
- Every product change must keep Moss's app map truthful in the same PR. Add, change, or remove the
  matching core declarations in `packages/shared/src/app-map-core.ts` or the owning module
  manifest's `navigation`, `settings`, and `features` metadata, including errors and remediations.
