# Notes Rust package checkpoint

The actual Notes Wasm guest provides `collectManagedNotesExportSection` through
`kind=api` with `{ "name": "collectManagedNotesExportSection", "parameters": {} }`.
The authenticated host supplies the account. Its response matches the legacy collector's
six arrays and field projection, including exact saved JSON, text and null values.
The guest uses only `moss-module-sdk` database queries on Notes-owned tables.

Notes remains required and has no standalone screen. This package is a continuation
checkpoint: Connections folder selection and saved sync status now have a package screen and
installed routes. Chat tools, actual sync, managed publication, private note export,
daily archives and the account export screen join are unfinished. The Connections
screen still needs joining into the assembled Phase 4 settings shell. Do not replace a
working legacy Notes installation with this checkpoint.

## Build

From `~/Jarv1s`, use the installed Rust 1.95.0 toolchain. The build needs its
`wasm32-wasip2` target in a worktree-local or scratch rustup home, not a global
installation. `wit-bindgen = 0.57.1` is a pinned project dependency approved for
this task; no standalone generator CLI is needed. Populate a scratch Cargo home
from the lockfile before using the offline build, and pass its path with
`MOSS_GUEST_CARGO_HOME`. `MOSS_GUEST_RUSTUP_HOME` selects the prepared toolchain.

```sh
CARGO_TARGET_DIR=/tmp/notes-domain cargo +1.95.0 test --locked --manifest-path modules/notes/src/Cargo.toml
MOSS_GUEST_CARGO_HOME=/tmp/notes-cargo MOSS_GUEST_RUSTUP_HOME=/tmp/notes-rustup MOSS_HOST_TARGET_DIR=/tmp/notes-host CARGO_TARGET_DIR=/tmp/notes-guest modules/notes/tools/build-component.sh /tmp/notes.wasm
CARGO_TARGET_DIR=/tmp/notes-host cargo +1.95.0 run --locked --manifest-path modules/notes/tools/Cargo.toml --bin notes-pack -- /tmp/notes.wasm /tmp/notes.mosspkg
NOTES_COMPONENT=/tmp/notes.wasm CARGO_TARGET_DIR=/tmp/notes-host cargo +1.95.0 test --locked --manifest-path modules/notes/tools/Cargo.toml --test component
```

The builder reads existing SQL from `packages/notes/sql/`, checks exact hashes
and the complete inventory, then includes the original bytes in the archive.
The archive is deterministic for a given component and is unsigned. The build
remaps source, Cargo, sysroot and target paths for the guest and all dependencies.
Compiled component bytes differed between source directories in this work despite
path remapping. Byte-identical compilation across builders is not established.
Only archive packing from fixed component bytes is claimed deterministic; release
signatures must cover the exact built artifact rather than an assumed rebuild.
Registry publishing and real publisher signatures belong to the release process;
tests use fresh synthetic signing keys.

## Disposable database checks

Read `.claude/skills/verify-gate/SKILL.md`. Never run the database tests directly.

```sh
NOTES_COMPONENT=/tmp/notes.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/notes-host scripts/run-gate.sh start --gate ./modules/notes/tools/gate.sh
scripts/run-gate.sh wait --follow
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/notes-parity PARITY_OUT=/tmp/notes-parity-result scripts/run-gate.sh start --gate ./modules/notes/tools/parity-gate.sh
scripts/run-gate.sh wait --follow
```

The first gate retains the earlier SQL privacy and linked-folder checks, then
compares the compiled Notes export against the real TypeScript collector on the
same committed synthetic rows. Both runtime roles, two owners and an unrelated
admin are exercised. It removes each table's RLS in the disposable database,
observes export assertions fail, restores it and repeats. It then installs the
signed package from a temporary folder registry with the real PostgreSQL lifecycle
and checks dispatch, required-module disable refusal, saved rows and ledger identity.
The second gate remains the two-server SQL-only comparison; it is not Notes HTTP parity.

## Limits

The host uses its ordinary transaction isolation. This is not a point-in-time
snapshot across all pages/tables while another process changes data. Paging,
fuel, deadline and message limits can refuse a large export; no partial section
is returned as success. Streaming and the account export UI join remain work.
Private note export and daily archive file behavior are separate from this managed
source export. Existing linked-folder compensation, crash and platform limits in
`HOST_ADAPTER.md` and the phase report still apply.

## Connections checkpoint

The package declares `/settings/connections`, without a Notes navigation entry.
Its Leptos screen uses the shared UI kit and the opaque-frame bridge. Authenticated
requests go through `/api/m/notes/notes-source`, `/notes-source/directories` and
`/notes-last-sync`. The host must use `Application::open_extended_with` to connect
`FolderSettingsPorts` with the `source` resource, the existing `notes-source-path`
and `notes-last-sync` preference names, and each account's allowed folders. Do not
share one account's root map with other accounts. Selection does not run sync yet.

`tools/ui-gate.sh` runs a disposable signed-package HTTPS fixture through
`run-gate.sh`. Supply `NOTES_COMPONENT`, `CARGO_TARGET_DIR` and `NOTES_UI_OUT`.
After the browser has linked a folder and confirmed unlinking, create the output
folder's `finished` file containing `checked`. The gate verifies the real saved
unlink and a preference revision showing prior writes, stops the server and releases
its claimed port. The fixture bounds Tokio and compiler workers so its nested host
runtimes do not each create a worker for every CPU on a shared machine. This fixture is not the
assembled Phase 4 shell or proof from a separate physical device.

The standard Notes gate now also compares actual legacy Settings handlers with
installed guest routes and performs a preference RLS removal control. Differential
coverage is limited to the cases in `tools/settings-oracle.ts`. Symlink descendant
selection, locale-sensitive directory ordering, invalid-input response parity and
sync scheduling remain unfinished. Existing linked-file platform limits apply.
