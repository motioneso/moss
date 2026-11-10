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

For the app's real staged lifecycle check, use task-owned `CARGO_HOME`, `RUSTUP_HOME` and
`CARGO_TARGET_DIR`, and select an installed toolchain with `RUSTUP_TOOLCHAIN` if that rustup home
has no default. Set `MOSS_PROOF_PORT` to a claimed devports port and run
`scripts/run-gate.sh start --gate test:rust-app-runtime-routing`. This ignored test creates two
independent instances, starts each server sequentially on that port, verifies HTTPS hello and
bundled libc loading, then stops the server and database. It checks production app functions,
not the This computer UI or a clean desktop root.

Add `--linux-server-runtime` to include the build machine's app and headless server linked ELF dependencies
(including PostgreSQL's loadable extensions), OpenSSL executable, public CA bundle and C.UTF-8
locale data. Run `install/moss-run moss-app ...`, `install/moss-run moss-shell serve ...` or `install/moss-run moss-db ...` to
select those files. The launcher preserves real executable names for supervisor ownership
checks. It requires a POSIX shell and the build platform's ELF interpreter ABI; this is not a
cross-distribution compatibility promise. Inputs must be trusted: closure discovery uses `ldd`.
It copies no OpenSSL host configuration or private keys. `--openssl` and `--ca-bundle` choose
explicit build inputs. The CA snapshot must be refreshed by restaging when its trust list changes.

The app now uses `moss-run` for local server startup, database lifecycle commands and OpenSSL
certificate generation when its install contains a runtime folder. Linux start at login also
records `moss-run moss-app`, preserving the selected install and data paths. Missing launchers
fail instead of silently choosing direct programs. Unstaged development installs still use direct
programs and the installed OpenSSL.

The server-runtime option does not package native WebKit helpers or desktop resources.
Use `--linux-desktop-runtime` instead to also stage the build platform's WebKit processes and
injected bundle, GIO TLS backend, compiled GSettings schemas, MIME cache, basic DejaVu fonts,
and Mesa software renderer (including its dynamically loaded EGL/GLES inputs). No tools are
downloaded or installed. Desktop staging additionally needs the build host's `pkg-config`,
`gio-querymodules`, WebKitGTK 4.1 and Mesa files at their declared library directory.

Release WebKit uses compiled-in absolute helper paths. The desktop stage therefore has an
explicit **target-root payload** in `runtime/rootfs`, with its required absolute destinations in
`runtime/closure.json`. A target-root assembler must copy that payload's contents into its new
root, preserving paths. Staging never modifies the host's system folders. `moss-run moss-app`
refuses missing fixed-path files with a payload error. It does not verify that pre-existing
system helpers match the staged WebKit; the assembler must deploy the matching payload.
The launcher selects the staged schemas, TLS backend, fonts and Mesa files. This is a native
software-rendering checkpoint on the build ABI, not a relocatable desktop bundle or general
installer. Hardware graphics, media plugins, desktop services, signing and updates remain open.
The inventory covers the staged payload only; `uninstall.py` does not remove copies deployed
outside the install folder. A future target-root installer owns their installation and removal.

For a native scratch-root startup proof, set `MOSS_CLEAN_INSTALL` to a desktop stage and
`MOSS_DESKTOP_PROOF` to a new scratch output directory, then run `pnpm test:rust-linux-desktop`.
This proof does not touch a database. It copies an explicit Xvfb/X11/D-Bus test desktop from the
host, imports a scratch Docker root, mounts no host folders, disables external networking and
runs as uid 1000. It uses software rendering without compositing, omits portal/accessibility
services, and never sets a sandbox-disable flag. It records a missing-helper negative control,
native process/window assertions, logs and a cropped `native.png` to inspect for the real first-run
screen. The root, container and image are removed even on failure. Docker, Xvfb, `xdotool`, `xwd`,
`xkbcomp`, D-Bus and ffmpeg must already be available; the script installs nothing.
This proves neither a real desktop login nor This computer creation or second-device HTTPS.

For local creation through the real native UI, use the same desktop stage and a new
`MOSS_DESKTOP_PROOF` directory, then run
`scripts/run-gate.sh start --gate test:rust-linux-creation` with the verify-gate skill.
This reuses that root, starts with no instance folder, chooses This computer, creates an owner,
signs out and signs back in. Keyboard and pointer actions use a fixed 1100×780 test window;
the test explicitly focuses it because this minimal desktop has no window manager. Form links
use keyboard activation; pointer link activation in this fixture is unreliable and unqualified.
The app's normal listening port stays inside the isolated network namespace; no host port is
published. The proof checks fresh database creation, migrations, HTTPS hello with certificate
verification, setup changing from incomplete to complete, and pgvector. It captures the real
sign-in, owner, Sharing, sign-out, Today and account screens. **Inspect these PNGs:** this fixture
does not make semantic DOM assertions about the final sign-in or Today screen. Today still uses
the shell's labelled sample data. The temporary password is generated in memory and typed via
stdin. The fixture removes its database with the entire test root when it finishes.
This remains a software-rendered build-ABI checkpoint, not a general Linux installer or a
second-device connection qualification.

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
