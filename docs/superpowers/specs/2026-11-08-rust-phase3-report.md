# Rust port, Phase 3: chat and agents

Task JS-42, part of #4027. Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 3.
Install rules: `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`, "Several
accounts on one install". Code: `rust-spike/agents/` and the `--runner` flag in `rust-spike/shell/`.

## Summary

- The kill gate passes on Linux. Rust drives Claude, Codex and OpenCode with no Node process
  anywhere in the agent's process tree, and each agent called a Moss tool and returned its answer.
- One runner process owns every account's agent. Each account gets its own agent process, its own
  folders and a private temporary folder, and runs under Landlock confinement.
- Confinement blocks another account's files, the Moss data folder, database files and the Moss
  process. It does not block the key store, which a confined agent can still reach over the
  session bus. Closing that is the first item for part 2.
- The permission and approval rules match the TypeScript chat on every case tried (225 + 127
  permission cases, 14,336 approval-route cases). The parity check caught one porting mistake that
  would have let unattended mode send something out; it is fixed.
- The Phase 4 chat drawer now talks to the real runner. A live message reached a confined Claude,
  which called a Moss tool, and the answer came back to the drawer.
- macOS and Windows confinement, the classifier, approval cards in the drawer and sign-in are not
  built. They move to part 2 (below).

## Kill gate: agents driven from Rust, no Node

Each run used the person's own CLI sign-in and the cheapest model they have. Moss passed one tool
(`secret_word`, returning a random word) and checked the reply held that word. A sampler read the
whole process tree every 100 ms through the turn, across every thread's children.

| Agent    | Protocol                    | Model used                      | Turn   | Process tree                                               | Node seen |
| -------- | --------------------------- | ------------------------------- | ------ | ---------------------------------------------------------- | --------- |
| Claude   | stream JSON over stdio      | haiku                           | 4.7 s  | claude, moss-tool-gateway                                  | no        |
| Codex    | app-server JSON-RPC         | the person's configured default | 19.5 s | codex, moss-tool-gateway, bash, dash, git, git-remote-http | no        |
| OpenCode | agent client protocol (ACP) | the person's configured default | 4.9 s  | opencode, moss-tool-gateway                                | no        |

So decision 7.5 (whether Moss downloads Node for an agent) is not needed for these three on Linux.
Each agent is a native binary the person installs; Moss ships none of them.

### What the gate found along the way

- **Codex and OpenCode started the person's own tool servers, some of them Node.** Both read the
  person's global config. Codex's command-line override adds to that config instead of replacing
  it. So each account now gets its own Codex config folder and its own OpenCode config folder,
  owned by Moss. Sign-ins stay where the CLI keeps them. After the change no user tool server ran.
- **Moss must never name a model.** Codex's model list is a fixed catalogue, not what the account
  can use. A ChatGPT sign-in rejected both models it offered. The runner now sends no model unless
  the account picked one, so each agent uses the person's own default.
- **OpenCode wraps tool calls.** Its "code mode" runs a script that calls Moss tools, so the real
  tool names only appear when that call finishes. The client reads them from there.
- **A nameless permission ask is refused.** One OpenCode model raised a permission ask with no
  tool name. The rules treat it as an unknown tool and say no.

## What was built

| Part              | Where                                            | What it does                                                                                                         |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Agent drivers     | `src/claude.rs`, `src/codex.rs`, `src/acp.rs`    | Start a session, send a turn, stream text and tool events, answer permission asks                                    |
| Moss tool gateway | `src/gateway.rs`, `src/bin/moss-tool-gateway.rs` | A small tool server the agent launches; it proves a per-session secret and relays each call to the runner            |
| Permission rules  | `src/policy.rs`                                  | Port of the TypeScript agent permission rules (allow, ask, refuse)                                                   |
| Approval route    | `src/approvals.rs`                               | Port of the gateway's run, ask or YOLO choice for Moss tools                                                         |
| Confinement       | `src/confine.rs`, `src/bin/moss-confine.rs`      | Landlock launcher: read system folders, write only the account's own folders                                         |
| Runner            | `src/runner.rs`, `src/bin/moss-runner.rs`        | One agent per account, private folders, clean environment, owner-only socket for the app                             |
| Terminal layer    | `src/terminal.rs`                                | A real pseudo-terminal per session for agent sign-in and the terminal screen, same clean environment and confinement |
| Probe             | `src/bin/moss-agent-probe.rs`                    | The kill-gate driver and process-tree sampler                                                                        |
| Chat drawer link  | `rust-spike/shell/app/src/runner_data.rs`        | `moss-shell serve --runner <dir>` sends chat through the runner                                                      |

### How an agent is launched

- The environment is built from nothing: home, a fixed search path, language, a private
  temporary folder, and the agent's own config folder. No database address, password, auth secret,
  provider key or recovery key is passed.
- The tool gateway gets only a per-session secret and the runner's socket. It holds no Moss data.
- Each account's folders are created owner-only (0700). The runner refuses a data folder inside a
  system folder or the shared temporary folder, and refuses a sign-in home that contains the data
  folder, because either would hand the agent another account's files.
- The shared temporary folder is not writable by agents. An early test showed one account's agent
  could read what another left there.
- With no approval waiting (between turns), any permission ask is refused.

## Confinement: what holds on one OS user (Linux)

Measured with `rust-spike/agents/proof/containment.sh`. Alice's confined shell tries each item.
The same probes run unconfined first as the control. Landlock ABI 4, kernel 6.8.

| Attempt by alice's agent                       | Unconfined (control)            | Confined    |
| ---------------------------------------------- | ------------------------------- | ----------- |
| Read bob's work folder                         | reached                         | blocked     |
| Read bob's agent home (sign-in)                | reached                         | blocked     |
| Read the runner secret in the Moss data folder | reached                         | blocked     |
| Read database files                            | reached                         | blocked     |
| Read the Moss process's environment            | reached                         | blocked     |
| Read the Moss process's memory                 | blocked (kernel ptrace setting) | blocked     |
| Talk to the key store over the session bus     | reached                         | **reached** |

Two more checks went through the real agent and the plain shell:

- Through Claude: alice's agent was asked to read bob's file. The approval was answered yes, the
  command ran, and the result was "Permission denied".
- Plain commands: unconfined `cat` reads bob's file; confined `cat` is denied; alice can write her
  own folder; writing the shared temporary folder is denied.

Memory reads were already blocked by the kernel's ptrace setting on this machine (level 1), so
that row does not prove Landlock. On a machine with that setting at 0, only Landlock's own ptrace
rule would hold, and that is not measured.

### The key store gap

Landlock does not control connecting to an existing socket, so a confined agent can open the
session bus and ask the Secret Service for what Moss stored there. The fix belongs in part 2. The
likely route is an unprivileged namespace launch (bubblewrap style) with no session bus inside, or
a key store that is not the shared Secret Service. Until that is proven, the notice must say the
key store is not confined.

### macOS and Windows

Not built and not measured. The plan's candidates are a sandbox profile on macOS and
AppContainer or a restricted token on Windows. On those systems the notice must say agent
confinement is unproven.

## The shared-install notice

Proposed text for Linux, using only the results above:

> Everyone on this Moss runs under the same user on this computer. Moss keeps each person's notes,
> chats and connections private inside the app. But someone who can sign in to this computer may be
> able to open other people's files. Only share this Moss with people you trust.
>
> On this computer, each person's AI agent is kept out of other people's files, Moss's own data
> folder, the database files and the running Moss program. It can still reach this computer's
> password store, so an agent could ask for saved passwords.

The screen that shows it, and its app-map entries, come with the account screens. They are not in
this phase.

## Parity with the TypeScript chat

Both sides read the same generated cases. The TypeScript side runs the app's own rule files
(`packages/acp/src/permissions.ts`, `packages/ai/src/gateway/policy.ts`). Details and commands are
in `rust-spike/agents/parity/README.md`.

| Check                                                                 | Cases  | Result   |
| --------------------------------------------------------------------- | ------ | -------- |
| Agent permission asks, shared tool names                              | 225    | 0 differ |
| Agent permission asks, OpenCode's lowercase names against their twins | 127    | 0 differ |
| Approval route, every combination of facts                            | 14,336 | 0 differ |

- The first route run found 544 differences. All came from one ordering mistake in the Rust port.
  An outbound tool that was resolved per call could run unattended under YOLO. The TypeScript
  checks outbound first. The port now does too, and a test pins it.
- The TypeScript rules treat OpenCode's lowercase tool names as unknown and refuse them. The port
  keeps that, so OpenCode's own built-in tools ask or are refused the same way.
- The classifier (`packages/ai/src/structured/classifier.ts`) was not ported or compared.

## Reaching Moss from other devices

The runner never listens on the network. It listens on an owner-only socket inside the data
folder, and every connection must first prove the secret in an owner-only file. Only a program
running as the same OS user can reach it. So the agent side adds nothing to what other devices
can reach.

Everything another device needs is in the web server, which Phase 4 part 1 already serves with
`moss-shell serve --host`:

| Need                                  | State after this phase                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listen on LAN or tailnet              | Works in the shell server; it warns while there is no sign-in                                                                                                              |
| Sign-in and sessions                  | Not built. With `--runner`, anyone who reaches the server can chat with the one local agent. Do not expose a runner-linked server beyond this computer until sign-in lands |
| Trusted origins                       | Not built. No Host or Origin check yet                                                                                                                                     |
| https                                 | Not built. Needed for phone features such as location; the dev setup today uses a tailnet https address                                                                    |
| Per-account agents from other devices | The runner already keys agents by account; the web server sends one fixed account until sign-in exists                                                                     |

## Modules and the registry

Agents see Moss tools through the runner's tool host, which takes a list of tools and their risk
facts. Today the runner offers one built-in tool. In the module design
(`2026-11-07-rust-module-packages-and-registry-design.md`), each downloaded package declares its
tools in its manifest. The host will hand those to the runner, and the approval route reads the
same risk and family facts the manifest declares. Nothing here assumes in-repo modules. Workshop
and Food are not touched.

## Evidence

Kept in the task's scratch folder, not the repo, because the logs hold local paths:

- Kill gate runs for each agent, with process trees and tool calls.
- The runner with confined Claude calling a Moss tool.
- The containment table above, control and confined.
- The agent negative control (asked to read bob's file, got "Permission denied").
- The drawer run. A message through `moss-shell serve --runner` asked for the `current_time`
  tool, and the reply quoted the time the tool returned. A second message asked for a shell
  command; the runner raised an approval, the drawer answered no, and nothing was written.
- Parity outputs from both sides.

Builds and tests:

- `cargo test` in `rust-spike/agents`: 16 pass. These cover account names, the clean launch
  environment, own-folders-only, the refused data folders, the route rules, and the terminal
  (echo, resize, clean environment).
- `cargo build -p moss-shell`: builds clean.
- Lint (`cargo clippy`) was not run, because it is not installed and the task does not allow
  installing it.

## Not proven

- Chat on macOS and Windows, and any confinement there.
- The key store is reachable from a confined agent on Linux.
- Memory reads with the kernel ptrace setting at 0.
- Codex and OpenCode through the runner and the drawer. The kill gate drove them directly; only
  Claude went through the runner and the drawer.
- Approval cards in the drawer. Every card is answered no and the reply says so.
- The classifier.
- Sign-in, trusted origins and https for the drawer.
- Agent sign-in through the terminal layer. The terminal works; no sign-in flow uses it yet.
- The runner as a long-running service that restarts on failure.
- The real Moss tool list. The runner offers one built-in tool.

## Part 2 (second task)

In order:

1. Close the key store gap on Linux and measure again with the control.
2. Approval cards in the chat drawer, wired to the runner's approval events.
3. Port the classifier and add it to the parity check.
4. Run Codex and OpenCode through the runner and the drawer, with the same live checks.
5. Agent sign-in per account through the terminal layer.
6. Feed the runner the real tool list from the module host (JS-43).
7. macOS confinement (sandbox profile) and Windows (AppContainer or restricted token), each with
   the control run, and the notice text per OS.
8. Runner as a user service that restarts on failure.

Sign-in, trusted origins and https belong to the core platform port, not part 2.
