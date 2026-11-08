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
NOTES_COMPONENT=/tmp/notes.wasm NOTES_TOOL_COMPONENT=/tmp/notes-tools.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/notes-host scripts/run-gate.sh start --gate ./modules/notes/tools/gate.sh
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

## Write-tool parity checkpoint (part five)

The `write-tools` Cargo feature contains `notes.create`, `notes.edit` and
`notes.delete` execution plus read-only approval details. It is off by default.
The package still offers no chat tools or sync job. Do not enable this feature
in a release package until the core memory/sync worker and approval join exist.
`notes.search` remains unported; embeddings alone do not provide memory retrieval.

The separate tool-check component uses the same generated ABI and SDK calls with
extra permissions supplied only by its test manifest. It reads the actor's selected
folder, compares the current destination and exact file text, then requests sync
with empty job parameters after the outer call commits. The queued result matches
the legacy `{ data: { path, synced: true } }` shape; it means a sync request, not
completed ingestion. The test queue acknowledges metadata; it does not ingest.
A refusal before call finalization compensates file writes. A queue publication
failure after finalization can leave the file saved without sync; no atomic
filesystem/database/queue guarantee is made.

Read-only approval preparation matches the legacy card fields and version for
ordinary canonical POSIX folder preferences. It grants no approval. Its version
must be rechecked after approval and before writing in the future host join.
Delete and overwrite must still require explicit approval even with a trusted
write policy. Neither approval consumption nor that orchestration is implemented
here. Source aliases, Windows paths, symlink selection, missing-file error parity,
and invalid-input/source-error parity remain unproven or stricter than legacy.
Concurrent-change refusals currently return a generic service-unavailable error
instead of the legacy conflict and retry hint.

```sh
pnpm exec tsx modules/notes/tools/write-tool-parity.ts
CARGO_TARGET_DIR=/tmp/notes-domain cargo +1.95.0 test --locked --features write-tools --manifest-path modules/notes/src/Cargo.toml
NOTES_TOOL_CHECKPOINT=1 MOSS_GUEST_CARGO_HOME=/tmp/notes-cargo MOSS_GUEST_RUSTUP_HOME=/tmp/notes-rustup MOSS_HOST_TARGET_DIR=/tmp/notes-host CARGO_TARGET_DIR=/tmp/notes-tool-guest modules/notes/tools/build-component.sh /tmp/notes-tools.wasm
NOTES_COMPONENT=/tmp/notes.wasm NOTES_TOOL_COMPONENT=/tmp/notes-tools.wasm CARGO_TARGET_DIR=/tmp/notes-host cargo +1.95.0 test --locked --manifest-path modules/notes/tools/Cargo.toml --test component --test write_tools --test screen
```

The ordinary package build leaves `NOTES_TOOL_CHECKPOINT` unset. Use distinct
Cargo guest target folders for the two builds: the wrapper reads each target's
core guest after the host helper has built. Installing the tool-check component under
the ordinary package is rejected because its additional imports are undeclared.
The database gate now also needs `NOTES_TOOL_COMPONENT`; the SQL-only parity gate
is unchanged. After all builds/gates finish, run the compiled-guest account guard
removal control separately:

```sh
NOTES_TOOL_COMPONENT=/tmp/notes-tools.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/notes-host python3 modules/notes/tools/write-tool-controls.py /tmp/notes-tool-controls
```

The manually refreshed corpus executes actual TypeScript write handlers (55 cases)
and approval hooks (41 cases), with explicit filesystem/sync/target stand-ins.
The real-component tests use actual temporary files and the linked-folder adapter,
with a queue acknowledgement stand-in. These are tool-boundary checks, not installed
chat, HTTP differential, full sync or second-device proof.

## Installed action details (part six)

The ordinary signed package now declares `prepareNoteAction` version `1.0.0`.
Call it through the host's public API with this envelope:

```json
{
  "name": "prepareNoteAction",
  "parameters": {
    "tool": "notes.delete",
    "inputJson": "{\"path\":\"Journal/note.md\"}"
  }
}
```

`inputJson` is the serialized original tool input. Keeping it as a string preserves
submitted field order through the SDK's deterministic JSON maps. The result is
`{ "ok": details }`, `{ "ok": null }` for undisclosable fields, or
`{ "error": { "statusCode": 409, "error": "Notes source is not configured" } }`
for a prerequisite failure. The details match the legacy approval hook, including
its opaque `version`. Keep that version on the server. It is neither a permission
nor an approval token; the eventual approval executor must recheck it before writing.

The host composes both `FolderSettingsPorts` and `LinkedNotesPorts` using the same
account-specific roots and `notes-source-path` preference. The new `folder.resolve`
operation takes `{}`, resolves the saved source to its canonical identity and
returns fixed prerequisite errors. It accepts no caller-selected root or account.
The ordinary component imports only database and vault ports and grants no write
or queue operations. This API does not enable installed chat execution or sync.

The standard database gate now additionally executes actual TypeScript approval
hooks against temporary files and real actor-scoped preferences, compares their
results with the installed compiled package for app and worker roles, and removes
preference RLS to prove the cross-account approval assertion detects exposure.
It checks canonical root aliases, invalid approval fields, source prerequisites,
no mutation during preparation and content-sensitive versions. This remains a
checkpoint: symlink descendants, all missing-file/path errors, Windows paths and
concurrent folder changes do not have complete legacy parity. The existing
Connections UI is unchanged; full shell/chat and physical second-device checks
remain on the continuation list.
