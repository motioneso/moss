# Notes Rust package checkpoint

The actual Notes Wasm guest provides `collectManagedNotesExportSection` through
`kind=api` with `{ "name": "collectManagedNotesExportSection", "parameters": {} }`.
The authenticated host supplies the account. Its response matches the legacy collector's
six arrays and field projection, including exact saved JSON, text and null values.
The guest uses only `moss-module-sdk` database queries on Notes-owned tables.

Notes remains required and has no standalone screen. This package is a continuation
checkpoint: Connections folder selection and saved sync status now have a package screen and
installed routes. Read-only indexed search now has a package tool and host adapter. Write tools, actual sync, managed publication, private note export,
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

## Manual sync HTTP checkpoint (part seventeen)

The experimental `write-tools` component now handles `POST /notes/sync`, exposed
by the installed test package at `/api/m/notes/notes/sync`. An absent, empty or
non-string saved source returns the legacy 409 response. A configured source
requests an owner-only durable checkpoint and returns 202 with its opaque
`jobId`. Body/query fields never select a source, actor or checkpoint. The
server-read source is saved in the private checkpoint so a later folder change
cannot retarget the request; queued metadata still contains only its ID. Filesystem
resolution remains worker work, matching the legacy HTTP prerequisite check.

The server must finish the transaction and deferred publication before sending
success. The ID names the saved request, rather than a completed indexing job.
Post-commit publication refusal can leave a recoverable checkpoint even though
the call fails. The existing experimental recovery API can discover it.
The ordinary package declares no manual-sync route and keeps returning 404;
its guest makes no host calls for that route. No Sync now button is enabled.

`tools/manual-sync-parity.ts` refreshes six vectors from the authored legacy
handler, using named preference/transaction/queue stand-ins. The native regression
was observed failing before this handler existed. The aggregate database gate
installs a signed experimental package, dispatches its declared route, verifies
owner/other-owner/admin separation under both runtime roles, removes preference
RLS to observe the denial assertion fail, restores it, and resumes the accepted
request through the real indexing adapter. Queue publication and embeddings are
still stand-ins. This is not HTTP transport, an assembled Settings/chat screen,
real configured models, legacy singleton coalescing, recall warmup, automatic
worker delivery or second-device HTTPS proof. Full Notes acceptance remains open.

## Write-triggered sync folder binding (part eighteen)

Experimental create, edit and delete save the resolved source path in the private
sync checkpoint, matching the existing manual-sync binding. Pending work refuses
a different selected folder or an unlinked source before ingestion or cleanup.
The failed attempt leaves the checkpoint available; reselecting the original
folder lets that same request resume. Queue metadata contains only its UUID.
This compares resolved paths through the existing core adapter; it does not detect
replacement of a folder at the same path or provide an immutable filesystem identity.

The regression first failed against the earlier native handler because it saved
an empty checkpoint. The compiled disposable database check exercises create,
edit and delete with folder changes and unlinking, unchanged index assertions,
restored-source retry, both runtime roles and the existing checkpoint RLS removal
control. File indexing is real; queue delivery and embeddings are named stand-ins.
No installed chat, production sync, screen change or second-device proof is claimed.

## API sync folder binding (part nineteen)

The experimental `requestNotesSync` API now reads the calling account's saved
source and binds the private request to it, using the same helper as manual sync.
A missing, empty or non-string source refuses the API before checkpoint creation
or publication. The API still accepts only empty parameters; neither account nor
source can be supplied by the caller. Resolution and filesystem validation remain
worker work. A folder change or unlink refuses pending indexing; selecting the
original folder lets the same request resume. Existing empty checkpoints remain
readable with their earlier unbound semantics; this change does not migrate them.

The native regression fails on the earlier empty checkpoint. The signed installed
experimental component is checked for both runtime roles, other-owner/admin
separation with preference RLS removal controls, folder-switch and unlink refusal,
and real indexing after restoring the folder. Queue delivery and embeddings are
stand-ins. No ordinary-package sync activation, assembled UI, installed chat or
physical second-device HTTPS proof is claimed.

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

## Installed tool-dispatch checks (part twenty-one)

The host's account-services adapter now forwards end-of-call finalization. Without
this, installed approval preparation retained a folder lock and the next approved
write failed as busy. The integration test reproduced that failure. Finalization
also reaches the existing transaction, compensation and deferred-job adapters.
Guest errors remain redacted; the test observes trusted service failures before
that boundary to distinguish approval refusals from unrelated errors.

The disposable aggregate gate now joins the existing generic `tools.run` service
to an installed, signed experimental Notes guest for create, edit, delete and
indexed search. A WAT probe only forwards the outer service request; the Notes
handler, linked files, private sync checkpoints, indexing and retrieval use the
real Rust implementations. Queue delivery is manual and both embedding adapters
use the named deterministic test provider. The fixture declares write tools only
in its experimental manifest; the ordinary package remains read-only.
The same service probe calls the installed read-only approval-preparation API;
callers without the declared Notes dependency are refused. Preparation supplies
an action version but grants no approval and makes no file or sync change.

The checks distinguish approval refusal from a later Notes conflict by counting
downstream port calls. They exercise wrong accounts (including an unrelated
admin), changed parameters, a different tool and grant replay before file or
database access, then the original approved write. They also remove checkpoint
RLS to observe cross-account read/update/delete denial assertions fail, restore
it and repeat. These checks remain installed service integration; part twenty-two adds target
freshness. An active queue, configured models, assembled chat and second-device
proof remain unfinished.

## Export limits

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
The package offers read-only indexed search but no write tools or sync job. Do not enable this feature
in a release package until the core memory/sync worker and approval join exist.
`notes.search` is now ported separately; see the indexed-search checkpoint below.

The separate tool-check component uses the same generated ABI and SDK calls with
extra permissions supplied only by its test manifest. It reads the actor's selected
folder, compares the current destination and exact file text, then saves a private durable request containing the resolved source folder. After the
outer call commits, queued metadata carries only that request’s UUID. The tool result matches
the legacy `{ data: { path, synced: true } }` shape; it means a sync request, not
completed ingestion. The test queue acknowledges metadata; it does not ingest.
A refusal before call finalization compensates file writes. A queue publication
failure after finalization can leave the file saved without sync; no atomic
filesystem/database/queue guarantee is made.

Read-only approval preparation matches the legacy card fields and version for
ordinary canonical POSIX folder preferences. It grants no approval. The experimental installed dispatcher can now carry its version in a trusted grant and recheck it before writing; see part twenty-two below.
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
and approval hooks (48 cases), with explicit filesystem/sync/target stand-ins.
The real-component tests use actual temporary files and the linked-folder adapter,
with a queue acknowledgement stand-in. These are tool-boundary checks, not installed
chat, HTTP differential, full sync or second-device proof.

## Installed action details (part six)

Since package version `0.1.1`, Notes declares `prepareNoteAction` version `1.0.0`.
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

## Indexed-search checkpoint (part seven)

Package version `0.1.2` adds `notes.search` to the ordinary component. It preserves the legacy query
trim, empty-query no-op, default limit of eight, one-to-twenty clamp and four-field
chunk projection. The input corpus executes the actual legacy handler with an
explicit retrieval stand-in. Unknown input fields are rejected more strictly than
legacy, rather than accepting actor/source overrides. The adapter also caps queries
at 64 KiB, and the guest rejects malformed chunk line ranges. These deliberate
bounds are stricter than the legacy handler.

The guest calls `vault/index.search` on the `source` alias. It has no database
grant on core memory tables and cannot select a source kind, actor or embedding
model. Assembly must wrap its ports in `MemorySearchPorts`, binding
`("notes", "source")` to `"notes"`, and supply `QueryEmbeddings`. That trusted
service must resolve the actor's configured query embedding model, including any
query prefix, and honor the invocation deadline. No production implementation of
that service, local model port, or app-shell chat join is included here. A missing
adapter/provider fails closed. This is installed tool-boundary support, not a claim
that chat search works in the assembled app. Before joining chat, the host must
preserve the legacy input/output schemas and mark returned note text as outside,
untrusted content (`content: "outside"`, `externalContent: true`). The current
Rust `Tool` manifest represents only description and risk; those missing contracts
are required chat-integration work, not permission to treat note text as instructions.

The host reads existing `app.memory_chunks` with the same source-kind, non-null
embedding, explicit owner predicate, cosine ordering and limit as legacy, under
the app/worker data context and existing RLS. It never indexes a new file. Search
can therefore use migrated index data; new folder selections or edits need the
still-unfinished sync worker. The ordinary package still has no write grants or
sync job, and is not a replacement for working legacy Notes.

```sh
pnpm exec tsx modules/notes/tools/search-parity.ts
CARGO_TARGET_DIR=/tmp/notes-domain cargo +1.95.0 test --locked --manifest-path modules/notes/src/Cargo.toml --test search
```

The standard Notes database gate now also creates two synthetic index owners and
an unrelated administrator, executes the actual legacy search body with the real
memory retriever/repository, then compares the installed compiled Notes tool in
both runtime roles. Only query embeddings are a named deterministic stand-in;
no actual model-quality or provider-configuration claim is made. The checks cover
semantic ordering, limit, exact text/line projection, null embeddings, other source
kinds and empty queries. Direct database cross-account read/update/delete privacy
assertions must fail with memory RLS removed, then pass restored. The compiled
search must remain owner-only even during that removal because of its independent
owner predicate. A temporary source copy then removes that predicate and repeats
the installed-component test with RLS also removed: the compiled search assertion
must fail, and must pass after restoring the source. The worktree protection is
never changed. These are distinct protections and distinct assertions.

## Sync coordinator parity checkpoint (part eight)

Version `0.1.3` ports the legacy sync coordinator into the existing **test-only**
`write-tools` build. Its `job` envelope is
`{"queue":"notes.sync","parameters":{...checkpoint}}`, matching the host's local
job dispatch envelope. It is not declared in the
ordinary package, not reachable through an installed HTTP route, and not scheduled.
The ordinary component continues to reject it. The native and actual-Wasm tests
compare the coordinator against 64 executions of the authored legacy worker and
cleanup helper, including the real error-message sink.

The coordinator preserves the hundred-chunk run budget, file/checkpoint selection,
resume hashes and managed snapshot keys, progress counts, deferred continuations,
partial versus total failure, and unlink no-op. Deleted-file selection retains
walked and resolved paths, only removes missing descendants of the current root,
and leaves an empty walk alone. Filesystem admission, embedding, per-file indexing,
transactions and the actual deletion are explicit stand-ins in these checks.
They do not establish ingestion, managed publication, queue or privacy behavior.

```sh
pnpm exec tsx modules/notes/tools/sync-parity.ts
CARGO_TARGET_DIR=/tmp/notes-domain cargo +1.95.0 test --locked --offline --features write-tools --manifest-path modules/notes/src/Cargo.toml --test sync
NOTES_COMPONENT=/tmp/notes.wasm NOTES_TOOL_COMPONENT=/tmp/notes-tools.wasm CARGO_TARGET_DIR=/tmp/notes-host cargo +1.95.0 test --locked --offline --manifest-path modules/notes/tools/Cargo.toml --test sync -- --nocapture
CARGO_TARGET_DIR=/tmp/notes-domain python3 modules/notes/tools/sync-controls.py /tmp/notes-sync-controls
```

Regenerate the committed JSONL corpus with the first command when the legacy
worker changes; generation is manual. The controls remove five protections from
a scratch copy (unlink no-op, empty walk retention, cleanup source boundary,
chunk budget and unknown-error redaction), require each assertion to fail, then
require the restored source to pass. They never edit the source worktree.

The draft ingestion calls remain confined to the test build's `vault` source
resource. They are `index.sync-open` and `index.sync-file`; they still have no
production implementation or permission. Before enabling sync, core must bind
the actor and selected source, validate every file through VaultContext, fence
source/file changes, index per file atomically under RLS and preserve managed
publication admission. These remain release blockers.

| Operation            | Parameters                                                                                 | Successful response                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `index.sync-open`    | `{sourcePath: string \| null}` override, otherwise saved preference                        | `{sourcePath: string, resolvedSourcePath: string, files: string[]}`; unlinked: `{sourcePath: null}`                   |
| `index.sync-file`    | `{sourcePath, filePath, chunkOffset, chunkLimit, expectedFileHash?, expectedSnapshotKey?}` | `{status: "ingested" \| "skipped", chunksProcessed, filePath?, continuation?: {chunkOffset, fileHash, snapshotKey?}}` |
| `index.sync-cleanup` | `{sourcePath, walkedPaths: string[]}`                                                      | `{}`                                                                                                                  |

The open response preserves the configured `sourcePath` for continuations and
separately returns canonical `resolvedSourcePath` for file operations and cleanup.
Other operations receive that canonical root as `sourcePath`. Failures use
`{error: string}` with an errno or `OUTSIDE`; other values produce a generic safe
error. A missing walk is permitted for an unlinked source. Canonical alias vectors now exercise the cleanup stand-in behind the single
request; they do not prove actual adapter alias handling. The real rewalk uses
regular files under the resolved root and does not follow symlinks, matching the
legacy walk admission. Full alias/path parity remains open.

## Atomic cleanup checkpoint (part nine)

The coordinator now makes **one** `index.sync-cleanup` request after the file loop.
It no longer asks the host to list and delete individual index paths separately.
The real, additive core adapter is `MemoryCleanupPorts` in the module host.
Assembly binds `(module, resource)` to `MemoryCleanupSource`, containing the
source kind, preference key and each account's allowed roots. It must use the same
source configuration as folder settings and ingestion. The ordinary package still
has no cleanup permission or sync job; no real sync is enabled here.

The adapter locks the calling account's existing source preference until commit,
checks the supplied canonical root against that selection, obtains a VaultContext
and folder lock, and rewalks the actual folder. Guest-supplied `walkedPaths` can only
retain rows, including paths that disappeared or failed to resolve during the run.
They cannot select an account, kind, root or individual deletion target. The host
walk independently retains currently present Markdown files even if the guest
omits them. An empty host walk leaves the index untouched. That extra empty-walk
check and retention of files that appeared since the original walk are deliberate,
conservative differences from legacy during concurrent filesystem changes.

The indexed-path snapshot and every selected chunk, outgoing link and index-row
delete share one account-scoped transaction. Explicit owner predicates supplement
existing RLS. Like legacy, cleanup retains other source kinds, other roots,
root-prefix collisions and incoming links; outgoing links have no source-kind
column and are removed for the exact deleted path. A late failure rolls back the
whole sweep. No new SQL, schema ownership or module database grant is introduced.

The walk and selected index are capped at ten thousand entries/rows; source and
walked paths are capped at 4096 bytes. Exceeding those bounds refuses the entire
sweep. Large-folder pagination is still required before activation. Symlinks are
not followed. Existing vault ancestor-swap and platform limits remain; folder locks
do not fence external editors, and no atomic filesystem/database snapshot is
claimed. Sharing the folder lock with future ingestion must be designed at assembly
rather than holding a conflicting linked-file lock through this call. The
synchronous filesystem walk can pin the source row lock and a pooled connection
while a disk call stalls; the timer cannot interrupt that call. Non-UTF-8 names
refuse the sweep, which is stricter than legacy. Production activation needs a
bounded worker design for these cases. Adapter errors currently become the generic
safe sync error; the stand-in errno vectors do not establish installed saved-error
parity. A typed safe-error channel is still required.

The standard Notes gate now runs `cleanup-gate.ts`. It executes the actual legacy
`purgeDeletedNotes` body with the real MemoryRepository, transactions and synthetic
files, then compares all three persisted tables with the compiled guest and real
adapter, for both roles, two owners and an unrelated admin. Per-file ingestion and
opening the job walk remain named stand-ins. Late database failure, invalid input,
unlink, stale source, missing allowed roots and omitted walk paths are checked.
Direct cross-account read/delete assertions fail when each table's RLS is removed,
then pass restored. A scratch source copy removes the explicit owner predicates;
the compiled privacy assertion must fail with memory RLS removed too, and pass
when the source is restored. Source-boundary and empty-host-walk removals must
also fail their compiled persistence assertions. These are compiled tool-boundary checks, not installed
chat, HTTP parity or working ingestion.

## Production ingestion checkpoint (part ten)

`MemoryIngestPorts` in the module host now implements the coordinator's
`index.sync-open` and `index.sync-file` operations for real. Assembly must
bind a resource to the source kind, the `notes-source-path` preference and
each account's allowed roots, exactly like cleanup, and supply a trusted
`DocumentEmbeddings` service for the calling account's configured document
model. No production assembly or real embedding service is connected yet;
only the gate builds this adapter. The guest chooses no account, model or
table. It may name a folder only inside the calling account's allowed roots,
and the adapter ingests only the account's saved folder. The Notes package
remains a pure client of these server ports.

Open resolves the saved folder, refuses a coordinator override that names a
different folder, walks Markdown files under the canonical root and returns
the configured and canonical source paths with the file list. Sync-file
rechecks the saved source, locks the folder, reads one file with a 16 MiB
bound, hashes it with SHA-256 and skips it unchanged when the saved index
hash and model match. Otherwise it parses the document with the legacy rules
(frontmatter, `## ` sections, paragraph/line/character splitting at 2000
UTF-16 units, wiki links), embeds the requested chunk window through the
trusted service, and writes that window in one account-scoped transaction.
A file longer than the run's remaining chunk budget is therefore written
over several pages, each page atomic, with the file index written on the
final page. Search can see a partly indexed long file until the
continuation runs. The file is re-read under the write transaction, so a
change during embedding refuses the write instead of indexing stale text.
Continuations carry the chunk offset and file hash, never a managed
snapshot key. A requested snapshot key is refused because managed
publication is not connected yet.

The walk is name-sorted, which is a deliberate deterministic difference from
the legacy operating-system directory order. Two smaller parser differences
are also deliberate. A hard 2000-unit cut never splits a character outside
the basic plane, where legacy JavaScript could split a surrogate pair. A
heading split happens only after a newline, where the legacy pattern also
split after a lone carriage return or Unicode line separator. Files over
the bound and non-UTF-8 notes fail that file instead of the whole run. No
sync job, schedule, manual route or write tool is enabled in the ordinary
package by this adapter.

```sh
pnpm exec tsx modules/notes/tools/ingest-gate.ts
```

That gate runs through `scripts/run-gate.sh` as part of the standard Notes
gate. It executes the real legacy `ingestVaultDocument`, `MemoryRepository`,
`StubEmbeddingProvider` and vault context on synthetic notes, including one
note longer than a single run's chunk budget, clears those rows, then runs
the compiled sync guest through the real Rust adapters for both runtime
roles. It compares every saved chunk row including a hash of its embedding,
plus link and index rows, follows the deferred continuations to completion,
and requires a snapshot-key request to be refused without changing the
indexed file. A second run must skip every unchanged file, and another
owner and an unrelated admin must each read none of the first owner's
chunks through a direct database check. The stub provider is a named
stand-in whose vectors the Rust test reproduces from the same hash rule;
no real model quality is claimed.

The synchronous checkpoint envelope/result may contain source/file paths and
hashes. **Do not enqueue that envelope or continuation as job parameters.** The
future worker must store checkpoint state under the account and enqueue only its
opaque ID using the host's typed metadata schema. The coordinator does not publish
jobs, write last-sync status, run after-sync hooks, reconcile the fifteen-minute
schedule, or implement the manual sync route. No-op/deferred results must not
replace saved status. Safe error comparisons cover ordinary `Error` and the
listed errno/path failures, not arbitrary JavaScript error subclasses.
The host currently scrubs guest errors, so installed saved-error parity requires
a typed safe-error channel. Its default whole-call limits are five seconds and
ten million fuel units. A real folder scan/ingestion must fit a bounded resumable
worker design; this synchronous test coordinator is not evidence that a whole
folder fits those limits.

Run the standard Notes gate with both component paths as before; it now includes
the compiled sync corpus. The actual SQL/privacy and installed-search checks remain
separate evidence. Full indexing/sync, approved write execution, assembled Settings
and chat, and a separate physical-device HTTPS check remain required before Notes
can replace the working legacy module.

## Durable sync checkpoint seam (part twelve)

Package `0.1.5` adds `app.notes_sync_checkpoints` in new package SQL; the
three original Notes migrations remain unchanged. The installer applies its
ordinary generated owner-only policies, including for an unrelated admin.
The `write-tools` test component accepts `requestNotesSync` with empty parameters
and resumes a `notes.sync` job with `{ "checkpointId": "<uuid>" }`. It reads the
private continuation through SDK typed queries and calls the existing sync
coordinator. Deferred results save the next continuation before queue publication;
queue parameters contain only its UUID. Each page may use a newly opened worker.

This is a worker seam, not an activated sync service. The ordinary package does
not declare that API or job. The test component retains the earlier raw coordinator
entry for the legacy differential suite; production activation must accept only
the UUID worker envelope. Embeddings and queue publication in the durable test
are named stand-ins, while files, database queries, ingestion and cleanup are real.

Checkpoint rows remain available for retry if publication fails after commit.
There is no durable outbox, recovery sweeper, deduplication of continuation rows,
or retention policy yet. Replaying a checkpoint can repeat coordinator work and
create another continuation ID. These are activation blockers; a captured ID can
be retried in the test, but automatic recovery after a crash is not proved.
Real account-configured model assembly, saved last-sync outcomes, manual and
scheduled sync, installed write approval/chat, managed publication and exports,
assembled Settings and physical second-device HTTPS proof remain open.

## Saved sync outcomes (part thirteen)

Package `0.1.6` adds final-outcome recording to the durable sync test worker.
It matches the legacy worker's last-sync counts and safe failure messages.
Successful deferred pages and ticks with no linked source leave earlier stats
alone. A failed continuation publication records a generic safe failure instead
of exposing the backend error. No paths, hashes or raw backend messages enter
this status through the worker.

Host assembly must wrap `TransactionalDatabasePorts` and its deferred queue
publisher **outside** with `FolderSyncStatusPorts`, binding `(notes, source)`
to the existing `notes-last-sync` preference. Grant `folder.record-sync` only
to the future assembled sync component. The adapter timestamps and saves in a
fresh account-scoped transaction after downstream finalization, including failed
calls. Status writes are best effort and do not change the sync result. Deadline
exhaustion, process death, a missing adapter or missing grant can leave old stats.
This is not a durable status outbox or a guarantee that every failure is recorded.
The ordinary package still declares no sync worker or write tools.

`tools/sync-parity.ts` now executes the actual legacy worker wrapper and status
writer in addition to its coordinator oracle, with explicit coordinator, queue
and data-context stand-ins. Native tests compare those outcomes and simulate a
status service refusal. The disposable ingest gate exercises real compiled sync,
post-finalization status persistence and reads through the compiled status route
for app and worker roles. Its owner, other-owner and admin privacy assertions
are observed failing when preferences RLS is removed and passing after restoration.
Status read/update controls cover both roles; deletion follows RLS for the app
role, while the worker's missing DELETE grant must refuse deletion throughout.
This does not prove installed chat, assembled UI sync or a separate device.

## Successful page replay (part fourteen)

Package version `0.1.7` saves a successful test-worker page's counts and optional
child checkpoint ID in its existing private checkpoint row. The worker first
uses a typed no-op update to lock that row until the outer call commits or rolls
back. Assembly must use `TransactionalDatabasePorts`; a nontransactional database
adapter cannot provide this serialization. Assembly must also bound worker
concurrency and reserve pool capacity for the ingestion adapter's separate data
contexts; waiting checkpoint transactions occupy connections. The concurrency
fixture uses four connections for two workers. An independent worker then reads the
saved result instead of repeating ingestion, cleanup or child allocation.

A deferred replay requests publication of the same child UUID and idempotency key.
This allows retry of a known parent after post-commit publication failure. A final
or no-op replay returns the previous result without overwriting newer saved sync
status. Failed deferred publication can record a new safe failure, including on
replay. To scan again after files or folder settings change, request a new sync;
redelivery of an old job is deliberately the same page. Existing raw checkpoint
rows remain readable. Successful rows replace private input with a bounded result;
no applied migration changes and no new table is required.

Native tests observe the retry regression failing before implementation. The
compiled database gate checks reopen/replay, concurrent delivery, stable child IDs,
publication-failure retry, unchanged legacy rows and owner/admin privacy with RLS
removal controls. Queue publication and embeddings are still named stand-ins.
This is not automatic outbox recovery: it needs a caller to retry the known parent.
Crash recovery of the initial request, checkpoint retention, sync activation,
approved installed chat, complete parity and physical second-device HTTPS proof
remain unfinished. No ordinary-package sync capability is enabled by this change.

## Write requests join durable sync (part fifteen)

Package `0.1.8` connects the experimental create, edit and delete handlers to the
same private checkpoint request as `requestNotesSync`. After changing a linked
file, the handler inserts an empty owner-scoped checkpoint and defers publication
of a `notes.sync` job carrying only its UUID. The worker can resume that job and
index the changed file or clean up the deleted note. The legacy success response
still means sync was requested, rather than completed ingestion.
Deletion cleanup still requires a nonempty folder walk; deleting the last note
retains its index under the existing empty-walk safety rule.

Assembly must put `TransactionalDatabasePorts` outside `AfterCommitJobs` and the
linked-file adapter. A checkpoint-save refusal before finalization rolls back
that transaction and compensates file changes. A publication refusal after commit
leaves the file and checkpoint saved; a caller that knows the ID can resume it.
There is still no automatic initial-request recovery or durable publication outbox.
The failed tool response does not return that ID; retrying create can report that
the note already exists after the first file was saved.
The ordinary package continues to refuse write tools and sync; installed approval
consumption, chat integration and configured embedding assembly remain unfinished.
Activation also requires manifest grants for file mutation and sync.

The native legacy write corpus now requires checkpoint creation before UUID-only
queue publication. The disposable compiled ingest gate additionally runs create,
edit and delete through real files, checkpoint transactions and indexing, tests
checkpoint-save compensation and post-commit publication retry, and probes the
new checkpoints as owner, another owner and an unrelated admin under app/worker
roles. RLS removal controls must expose the otherwise denied read/update/delete
probes. Queue delivery and embeddings are named stand-ins. These tests are not
proof of installed chat, a working manual-sync screen or a separate device.

## Saved request publication recovery (part sixteen)

Package `0.1.9` adds experimental `recoverNotesSync` to the write-tools component
only. An authenticated trusted server caller supplies `{}` for the first page,
then `{ "after": "<nextCursor>" }` for each following page. No account, path,
source or page-size override is accepted. Each page scans at most 25 of the
calling owner's checkpoints in ascending UUID order. It requests post-commit
publication for unfinished rows, including initial requests whose publication
failed and continuation rows whose parent already completed. Successful saved
pages are skipped. Only scanned/requested counts and the next UUID cursor are
returned; jobs still carry just a checkpoint UUID with the same idempotency key.

Advance the cursor only after the whole call, including finalization, succeeds.
Retry a failed page from its previous cursor. Publication can succeed for some
jobs before a later one fails; retries deliberately reuse queue identities. A
trusted timer must periodically restart at the first page to notice new UUIDs
below an earlier cursor. Concurrent worker completion can produce a redundant
request; saved worker results and queue idempotency handle that duplicate.

This adds explicit recovery by scanning, not an active timer or a new automatic
outbox service. The existing queue does not resurrect an exhausted/completed job
with the same idempotency key. This API recovers missing publication; it cannot
retry an exhausted job. Checkpoints remain retained, so full scans cost more as
history grows; retention and trusted timer assembly remain activation work.
The ordinary manifest declares neither this API nor a sync job. Configured real
embeddings, manual/scheduled sync, installed chat approvals, full parity and
physical second-device HTTPS acceptance remain unfinished.

Native tests cover cursor pages, retries and refusal before host access. The
compiled disposable ingest gate covers first-request publication loss without
knowing its ID, continuation discovery, completed-page skip and real worker
resume, with other-owner/admin recovery denial under both runtime roles. Removing
checkpoint RLS must expose those otherwise denied rows and publications; restoring
it restores denial. Queue publication and document embeddings remain named
stand-ins; these checks do not prove the queue's live delivery or phone use.

## Folder failure responses (part twenty)

Installed folder selection and browsing now match legacy responses for missing
paths inside allowed roots and existing paths outside them. Other in-root vault
policy refusals retain the general message. The chooser shows separate guidance for these
fixed failures and keeps its generic fallback for other errors. Rejected saves
keep the current link, entered path and focus. The expanded legacy differential
uses real empty, missing and other-account paths with an existing link; it compares
the saved value and revision as well as each response (60 cases across three users).
It was observed failing on the earlier generic host response.

Existing vault admission is unchanged: symlink descendants, relative paths and
traversal remain refused. Missing paths outside roots and non-directory sources
can still differ from legacy, as can directory ordering and other invalid inputs.
This does not activate chat, production sync or the assembled settings shell.

## Displayed-target approvals (part twenty-two)

Experimental tool declarations opt into `"approvalVersion": true`. The trusted
server prepares the existing `prepareNoteAction` API, shows its details to the
account, and saves the version that was shown with
`ServicePorts::approve_tool_at_version`. Plain approvals are refused for these
tools. The dispatcher obtains the version only from that account's saved grant;
caller-supplied envelope versions are ignored. It consumes the grant before
calling Notes, retaining the existing account/tool/input binding and expiry.

Notes compares that version to its current resolved source, relative path and
exact file content before create/edit/delete. It also checks that the returned destination matches
the resolved source, refusing a folder switch between resolving and reading.
The linked-folder adapter retains
its existing call lock from notes.read through comparison and guarded mutation;
the earlier folder resolution itself is not locked. external writers
are still fenced by the adapter's exact expected-text comparison. Changed content
or a different source refuses the action without saving a sync checkpoint. A
fresh preparation and approval are required after refusal. This detects state
changes, not filesystem identity replacement at the same path with the same text.

Only the signed experimental integration fixture declares these write tools.
Legacy direct-handler parity fixtures remain unversioned; the ordinary package
continues to offer only search. No assembled chat card, live approval endpoint,
configured model, active queue or second-device HTTPS acceptance is claimed.
The generic host flag is additive and defaults off for existing packages.
