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

## Finishing Work

- **Leave your worktree clean when you finish.** Commit and push anything worth keeping (docs,
  plans, handoffs), delete everything else you created (scratch scripts, logs, screenshots, test
  output), and stop any server or browser you started. An hourly sweeper removes worktrees whose
  work is merged and whose tree is clean; one stray untracked file keeps the whole worktree alive.
  This applies however you were launched: Claude, Codex, Muse, OpenCode, a pane or a headless run.

## Rust Gate Notes

- Calendar server test fixtures anchor dates to the account zone (`America/Los_Angeles` by
  default), never UTC's today. A UTC anchor fails in Los Angeles evening hours.
- The Sports installed gate reads live ESPN data, so a red run can depend on that night's game
  volume. Rerun near the failing hour before blaming the code.
- `pnpm test:rust-connectors-live` and `pnpm test:rust-calendar-server` need `RUSTUP_HOME` set
  explicitly (`export RUSTUP_HOME=$HOME/.rustup`), or the gate refuses after the whole build.
- Live chat fixture runners need `gateway_bin` pointing at the built `moss-tool-gateway` binary.
- A script that copies the tree for a protection check must also copy `modules/` and use its own
  `CARGO_TARGET_DIR`.
- Guest module cargo tests build under their own `CARGO_TARGET_DIR` subfolder. Sharing the host's
  target folder makes rustc see two `moss_module_sdk` crates.
- Calendar deadline fault fixtures set `deadline_ceiling` as well as `deadline`. A manifest call
  budget overrides the fixture default.
- The module publisher CLI is `cargo run --bin moss --manifest-path
  rust-spike/module-publisher/Cargo.toml`. Its artifact gate is `pnpm test:rust-phase6-registry-artifacts`.
- `pnpm test:rust-phase6-offline-bundle` removes and restores refusal guards, and refuses to start
  without explicit `RUSTUP_HOME` and an isolated `CARGO_TARGET_DIR`. Never run it beside another
  cargo build.
- CI compares first-party package digests across Linux, macOS and Windows. A package build change
  must stay byte-identical on all three.
- Format Rust with `cargo +1.95.0 fmt` (rustfmt 1.95.0), not the default toolchain's rustfmt.
- Finance import previews return the ledger revision as `view.revision`.
- Browser proof on this box runs `herdr-browser` with
  `AGENT_BROWSER_ARGS='--no-sandbox,--force-prefers-reduced-motion'`.
