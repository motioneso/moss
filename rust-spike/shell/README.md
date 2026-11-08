# Rust UI shell (Phase 4 part 1)

The app frame, Today and the chat drawer in Leptos, served by one Rust program that also opens
as a desktop window. Report: `docs/superpowers/specs/2026-11-07-rust-phase4a-report.md`.

## Layout

| Crate      | What it holds                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `contract` | JSON shapes the UI reads, the `ShellData` trait the server calls, and `StubShellData` (feature `stub`)         |
| `ui`       | Leptos client-side app compiled to wasm: frame and navigation, Today, chat drawer                              |
| `app`      | `moss-shell`: axum server for the UI and its `/api/*` routes, plus the tao + wry desktop window                |
| `assets`   | `index.html` and the script that copies the current app's CSS, fonts, textures and theme boot script unchanged |

This is its own cargo workspace so it never touches `rust-spike/Cargo.toml`.

## Build

Needs a rustup home with the `wasm32-unknown-unknown` target. Nothing is installed globally.

```bash
export RUSTUP_HOME=/path/to/task-local/rustup
export CARGO_TARGET_DIR=/path/to/scratch/target
rust-spike/shell/build.sh
```

The program lands in `$CARGO_TARGET_DIR/dist/moss-shell` with the web build in `dist/web` beside it.

## Run

Both browser and desktop modes require the authenticated HTTPS network configuration described
in `rust-spike/network/README.md`. There is no plaintext or anonymous mode.

```bash
moss-shell serve --network <private-configuration>
moss-shell desktop --network <private-configuration>
```

Start with a loopback listener and sharing off. For access from other devices, configure exact
HTTPS origins and certificates, bind the intended interface, and enable sharing as the owner.

`--web <dir>` points either mode at a web build somewhere else.

## Data

Today still reads explicitly labelled sample data. With `--runner <runner-state-folder>`, chat
uses the Phase 3 runner for the signed-in account; otherwise it shows sample replies. The shell
name comes from the signed-in person's database record. Every route and app file is wrapped by
`moss-network`, and each actor gets separate shell/chat state.
