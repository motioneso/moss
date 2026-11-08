# Phase 5 Tasks package

Task JS-46, Card 522. Part of #4027. Work stays in this task's worktree under
`~/Jarv1s`. Workshop and Food are excluded.

## Approved scope

Port Tasks as-is under `modules/tasks/`, following section 7 of the module-package
spec. Keep the original SQL bytes, ledgers, data, privacy rules, screens, chat tools
and job kinds. People integration uses declared public APIs only.

The initial host inspection found missing package-builder interfaces. On November 8,
the parent explicitly approved extending the shared host in this task, with these
conditions: changes are additive, existing behavior and signatures remain supported,
each extension has a failing-first test and its own small commit, and the report
identifies those extensions. Rebase on current main before starting. Do not wait for
a prerequisite task.

## Build order

1. Add a pure `moss-module-sdk` crate with host-port traits and typed query contracts.
   Coordinate that contract with the People builder; never import host internals
   into a guest module.
2. Add opt-in typed filters, composite-key operations and a transaction that covers
   one module invocation. Existing database requests keep their current behavior.
   Extend route dispatch through a new entry point, preserving literal dispatch.
3. Build the Tasks package, native tests and WebAssembly component. Read legacy SQL
   from its existing directory and verify it against the host inventory.
4. Add the module frame and shared Leptos bridge, then port the existing Tasks
   screens and update the package app map. Integrate with the authenticated server.
5. Exercise HTTP/tools/jobs through the package with the parity harness; prove
   privacy failures with the protection removed. Run database work only through
   verify-gate. Exercise the real UI and a second device, then independent review.

## Core split

| Area | Placement and reason |
| --- | --- |
| Sign-in and accounts | Host: establishes the actor before calling packages |
| Settings frame and app map | Host: combines trusted account controls and module declarations |
| Chat and agents | Host: owns conversations, approvals and agent execution |
| Memory and embeddings | Host: shared account knowledge and capability routing |
| Vault | Host: enforces account roots and file permissions |
| AI router | Host: selects each account's configured capabilities |
| Connectors framework | Host: brokers credentials without exposing them to packages |
| Notifications | Host: routes account-scoped delivery |
| Job queue | Host: enforces actor envelopes and typed metadata |
| Workflows and structured state | Host: coordinates cross-module state through public ports |
| Today shell | Host: composes module contributions |
| Tasks | Package: owns task behavior and existing task tables |
| People | Separate package: exposes only declared public APIs to Tasks |

## Verification and completion

The report at `docs/superpowers/specs/2026-11-08-rust-phase5-tasks-report.md` must
distinguish passing checks from unproved behavior. A native-only spike, mocked UI
or same-machine LAN request does not establish the required package/UI/device parity.
Finish with the task's proof artifact and Ready action; never merge or mark Done.
