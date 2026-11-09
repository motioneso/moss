# Rust UI shell (Phase 4 part 1)

The app frame, Today and the chat drawer in Leptos, served by the Moss server. The desktop app
is a separate program that connects to a server on this or another computer. Report:
`docs/superpowers/specs/2026-11-07-rust-phase4a-report.md`. Server and app split:
`docs/superpowers/specs/2026-11-08-rust-server-and-app-split-design.md`.

## Layout

| Crate      | What it holds                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `contract` | JSON shapes the UI reads, the `ShellData` trait the server calls, and `StubShellData` (feature `stub`)         |
| `ui`       | Leptos client-side app compiled to wasm: frame and navigation, Today, chat drawer                              |
| `app`      | `moss-shell`: the server; axum routes for the UI and its `/api/*` calls behind `moss-network`                  |
| `connect`  | `moss-app`: the desktop app; server list, certificate pins, local start, tao + wry window                      |
| `assets`   | `index.html` and the script that copies the current app's CSS, fonts, textures and theme boot script unchanged |

This is its own cargo workspace so it never touches `rust-spike/Cargo.toml`.

## Build

Needs a rustup home with the `wasm32-unknown-unknown` target. Nothing is installed globally.

```bash
export RUSTUP_HOME=/path/to/task-local/rustup
export CARGO_TARGET_DIR=/path/to/scratch/target
rust-spike/shell/build.sh
```

Both programs land in `$CARGO_TARGET_DIR/dist/` with the web build in `dist/web` beside them.

## Run

The server requires the authenticated HTTPS network configuration described in
`rust-spike/network/README.md`. There is no plaintext or anonymous mode.

```bash
moss-shell serve --instance <data>/servers/default
moss-shell serve --network <private-configuration>
```

With `--instance`, the server reads `network.json` from that folder and writes an owner-only
`running.json` while it listens, which is how the desktop app finds it. `<data>` is
`$XDG_DATA_HOME/moss`, or `~/.local/share/moss`.

```bash
moss-app
moss-app --data <data-folder>
```

The app opens the last server it used. A local instance that is not running is started in the
background and keeps running after the window closes. Another computer is added by its HTTPS
address, after comparing its certificate code with that computer's Sharing screen.

Start with a loopback listener and sharing off. For access from other devices, configure exact
HTTPS origins and certificates, bind the intended interface, and enable sharing as the owner.

`--web <dir>` points the server at a web build somewhere else.

## Data

Today still reads explicitly labelled sample data. With `--runner <runner-state-folder>`, chat
uses the Phase 3 runner for the signed-in account; otherwise it shows sample replies. The shell
name comes from the signed-in person's database record. Every route and app file is wrapped by
`moss-network`, and each actor gets separate shell/chat state.
