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

## Stage an unsigned Linux install

Build `moss-db` from `rust-spike/bundled-db` and put it alongside the two programs in
`dist/`. Build the PostgreSQL bundle with the existing Phase 1
`rust-spike/bundled-db/proof/linux/build-pg.sh`. Then stage into a new folder:

```bash
python3 rust-spike/shell/tools/stage-install.py \
  --dist "$CARGO_TARGET_DIR/dist" --postgres /path/to/phase1/postgres --out /path/to/new/install
/path/to/new/install/moss-app --data /path/to/new/data --install /path/to/new/install
```

The stage includes the canonical supervisor schema and a hash inventory. On first use,
This computer reuses the database supervisor to provision its local server.
The live provision test is ignored by default and must run through `scripts/run-gate.sh`, with
`MOSS_CLEAN_INSTALL` pointing at the stage and `MOSS_CLEAN_DATA` at a new scratch folder.

Add `--linux-server-runtime` to include the build machine's headless server ELF dependencies
(including PostgreSQL's loadable extensions), OpenSSL executable, public CA bundle and C.UTF-8
locale data. Run `install/moss-run moss-shell serve ...` or `install/moss-run moss-db ...` to
select those files. The launcher preserves real executable names for supervisor ownership
checks. It requires a POSIX shell and the build platform's ELF interpreter ABI; this is not a
cross-distribution compatibility promise. Inputs must be trusted: closure discovery uses `ldd`.
It copies no OpenSSL host configuration or private keys. `--openssl` and `--ca-bundle` choose
explicit build inputs. The CA snapshot must be refreshed by restaging when its trust list changes.

This option **does not package the native WebKit app runtime** or change its launcher/autostart.
Signing, updates, desktop helper/resource closure and general clean-machine app installation
remain unqualified. It is still one staged install containing both app and server programs.

To remove a stage, disable Start Moss at login, quit the app and stop its servers. As the
ordinary install owner, run `python3 /path/to/install/uninstall.py`. Python 3 and Linux `/proc`
are required for this maintenance command. It removes only unchanged inventory files, refuses
running install executables and redirected directories, and retains unlisted files, including
instance folders placed inside the installation. It never recursively deletes the install root.

`python3 -m unittest discover -s rust-spike/shell/tools -p test_install.py -v` checks the
packaging boundaries. For the real headless clean-root proof, claim a task port with `devports`,
set `MOSS_CLEAN_INSTALL` to a stage with the runtime option, `MOSS_RUNTIME_PROOF` to a new
scratch directory and `MOSS_PROOF_PORT` to that port, then run
`scripts/run-gate.sh start --gate test:rust-linux-runtime`. Use the verify-gate skill. The proof
imports a scratch Docker root with the stage and an explicit shell/interpreter baseline, with
no host mounts or external network; it exercises real PostgreSQL, migrations, pgvector,
certificate generation, HTTPS hello, Stop and data-preserving uninstall. It does not load the UI.
