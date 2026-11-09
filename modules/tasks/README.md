# Tasks component checkpoint

This is an unfinished Tasks module package. Rust code now compiles into a real
component and handles basic task, list, tag, activity and view preference routes.
It also handles nineteen tools: six reads and thirteen mutations, with request
schemas enforced inside the guest. It is not a
complete replacement for Tasks. A package screen now covers list and priority views,
task editing, subtasks, tags, comments and list creation, renaming and confirmed deletion. Full screen parity,
four other chat tools, background
jobs, People calls and full endpoint parity remain unfinished.

`src/` uses the guest-safe SDK. `wit/` defines its ABI. Ben approved the pinned
`wit-bindgen` generator on 2026-11-08, superseding the earlier decline. `tools/`
is a separate host-side verification crate, never linked into the guest.
The small `bindings/` crate uses the same approved generator graph's
`wit-component` encoder to wrap the core Wasm. Building directly for WASI imports services the host deliberately
refuses; the shipped build therefore targets `wasm32-unknown-unknown` and has no
WASI adapter. No global tool or compiler target installation is required by
these scripts: use an already provisioned Rust 1.95 toolchain with that target.
Restore the locked Cargo dependencies into a worktree or scratch Cargo home first.

From the repository root, use separate target folders: native guest tests with
`CARGO_TARGET_DIR=/tmp/tasks-native-target`, host tools with
`CARGO_TARGET_DIR=/tmp/tasks-host-target`, and component builds with
`TASKS_GUEST_TARGET_DIR=/tmp/tasks-wasm-target`. Set `CARGO_HOME` and
`RUSTUP_HOME` to existing task-local dependencies/toolchains as needed:

```sh
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/src/Cargo.toml
modules/tasks/tools/build-component.sh /tmp/tasks-component.wasm
TASKS_COMPONENT=/tmp/tasks-component.wasm cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --test component --test metadata
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --test tool_services
cargo +1.95.0 run --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-pack -- /tmp/tasks-component.wasm /tmp/tasks.mosspkg
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-domain-check
JS51_DOMAIN_BIN=modules/tasks/tools/target/debug/tasks-domain-check pnpm exec tsx modules/tasks/tools/recurrence-parity.ts
```

When using `CARGO_TARGET_DIR`, point `JS51_DOMAIN_BIN` at that directory's
`debug/tasks-domain-check` instead. The archive is reproducible and unsigned;
registry trust, signing, installation and publication are separate checks.
The tool-service test uses an explicitly labeled sample port trampoline to check
the real host's offers, install-permission descriptions and one-use account
approval guard. It stops at the unbound installer after approval; actual installed
tool dispatch is not proved. Compiled tool result checks remain in the database gate.
All nine SQL files come from the original `packages/tasks/sql/` and are checked
against the host's frozen migration hashes. No migration bytes or ledger change.

Database tests **must** use the repository's verify-gate workflow:

```sh
scripts/run-gate.sh start --gate modules/tasks/tools/gate.sh
scripts/run-gate.sh wait --follow
```

The gate builds and validates the actual component before running the privacy
checks. The new component test dispatches declared route envelopes through real
Wasmtime, typed host calls and disposable PostgreSQL transactions. It removes
Tasks RLS and requires the exact cross-account read/write assertions to fail,
then restores RLS and requires them to pass. It also checks recurring completion
and repeated completion, and checks the four compiled read tools as the owner,
another account and an admin. The tool privacy assertion must fail when Tasks
RLS is removed and pass after restoration. Earlier native data checks retain their explicitly
labeled sample trampoline; those are not component-execution evidence.

The full existing endpoint differential harness can now target the actual
component through a disposable, authenticated loopback HTTP adapter:

```sh
TASKS_PARITY_OUT=/tmp/tasks-parity scripts/run-gate.sh start --gate modules/tasks/tools/parity-gate.sh
scripts/run-gate.sh wait --follow
```

The script builds both servers, claims and releases ports, and writes
`report.json` plus server logs to the output folder. It reuses the existing
cases and TypeScript server unchanged. Expected failures from unported routes,
tools and jobs are reported as failures; this script is not an installed package
or live UI proof. The endpoint harness does not compare tools; the database gate
separately compares the thirteen mutation handlers with the TypeScript executors,
including set-value fields, cascades, recurrence and selected rejected operations.
It also checks persisted task effects and tags dropped by list moves; it does not
claim exhaustive input/error-message parity. Empty titles remain rejected by the
unchanged database constraint. A shared-parent removal control strips the real
`Owned` query predicate and counts attempted inserts before and after restoration.

The package screen is rendered with the shared Leptos kit; its controller uses
the public parent bridge. The interactive check below creates a disposable signed
registry and installs the actual archive through the module host. It uses the
real network TLS/setup/sign-in boundary and a small fixture frame, **not** the
Phase 4 application shell. It binds loopback only. A phone viewport is not proof
of access from another physical device.

```sh
TASKS_UI_OUT=/tmp/tasks-ui scripts/run-gate.sh start --gate modules/tasks/tools/ui-gate.sh
scripts/run-gate.sh wait --follow
```

Use a fresh output folder. Read its `url.txt` for the local setup URL, create a
synthetic owner through the browser and exercise Tasks. The certificate check
trusts only the generated certificate; it does not install a machine trust root.
Create one task titled `Browser proof task`, then write `checked` to the output
folder's `finished` file. The gate verifies persistence and stops the server.
Its credentials and keys are private scratch files: never open, print or commit
them. Do not use this fixture with real data.

The recurrence differential check covers ordinary
calendar dates and invalid inputs, not full endpoint parity. Date parsing covers
the ISO branch; offset-free timestamps currently use UTC because the host has no
actor-timezone port. Lazy recurrence roll-forward needs that public host seam
before it can preserve the actor's local day. Additional routes, queued work
and public People calls also remain to be ported. See the
Phase 5 Tasks report for the exact validation results and continuation boundary.

Part 6 repairs initial screen loading through the keyed public frame bridge and
adds the shared document typography. The bridge opens the installer-verified
screen URL itself; callers must not assign a second URL after attaching it.
Form saves use submit-button activation because the opaque sandbox blocks native
form submission; validation and authenticated bridge writes remain in place.
See the final part 6 section of the Tasks report for current live verification
and remaining parity work. The fixture remains separate from the application
shell and physical-device acceptance.

Part 7 adds the ordered breakdown route and twelve mutation handlers:
`tasks.create`, `tasks.update`, `tasks.updateStatus`, `tasks.breakDown`,
`tasks.addActivity`, `tasks.assignTag`, `tasks.unassignTag`, `tasks.createList`,
`tasks.renameList`, `tasks.createTag`, `tasks.renameTag` and `tasks.deleteTag`.
Together with the four read handlers, sixteen are declared. Tools preserve
supplied text; the HTTP breakdown route trims its steps. Tool inputs are typed
JSON, without the HTTP form coercions. The current host still requires one-use
account approval; legacy automatic-action policy and chat presentations are not
ported by these handlers.

The database gate now compares these mutation handlers against the current
TypeScript executors using two synthetic accounts and the actual component.
Only generated identifiers and clock timestamps are canonicalized. The endpoint
harness keeps every existing case unchanged and adds the package's breakdown
cases from `tests/parity/`. Failed comparisons remain failures.

Remaining after part 11: six HTTP endpoints (search interpretation, focus,
at-risk, overdue and both assistant-policy routes); four tools
(summary, focus, at-risk and overdue); recurrence jobs and full deferred-queue policy parity, timezone and lazy recurrence contracts, public People linkage, policy
and feedback orchestration, full screen/settings parity, real-shell integration,
performance budgets and second-device HTTPS proof. The legacy HTTP list route
only applies tag and quadrant filters; the wider filter set belongs to its
repository/tool contract and must not be silently added to that HTTP route.

Part 8 adds `tasks.heartbeatWindow`: bounded owner-only open/due tasks, UTF-16
material revisions and time boundaries, without writes or lazy recurrence. The
host still requires tool approval; scheduled background authorization is not joined.
`POST /tasks/:id/deferred-status` enqueues typed status metadata and the job handler
uses the captured account context. Host queue defaults differ from legacy retry
and retention options; the optional request key is parsed but not retained or used
for deduplication (the legacy route did not use it as a singleton key either).
Full deferred-job parity and the endpoint harness queue observer remain unfinished.
The database gate compares heartbeat results exactly with the TypeScript executor
and enqueues/claims from a real PostgreSQL queue, then directly invokes the compiled
handler with the claimed actor. Installed automatic worker dispatch is not proved. Privacy removal controls
are separate from any claim of complete package or physical-device acceptance.

Part 9 adds the `tasks.list` handler with list, tag, status, priority, due-date,
completion-date and quadrant filters, stable updated-time/identifier ordering,
tags and the legacy column order. The HTTP list route retains its narrower filters.
Date comparisons are strict. The existing ISO date parser is reused; free-text
dates and process-local offset-free timestamps still differ from JavaScript.
Rows are persisted occurrences: actor-local lazy recurrence remains unfinished
on both interactive listing paths, so this handler is not full list parity.

The database gate includes `tools/list-parity.ts`: exact comparisons on synthetic
non-recurring rows, private/admin/shared visibility, an RLS removal/restoration
control. These are component
handler checks, not proof of installed chat dispatch. No timezone, lock, People,
action-policy, recurrence-worker or application-shell seam is fabricated here.
Full-shell and second-device HTTPS acceptance remain outstanding.

Large-account acceptance is separate and remains red. Run the same gate with
`TASKS_LIST_LARGE_ACCOUNT=1` to include a list containing 1,011 tasks. The compiled
handler exceeds the default host runtime allowance on that probe. The check is not
truncated, its limits are not raised and its failure must not be reported as parity.
Tag membership is chunked at the public query limit; quadrant filtering runs in
the database. Cross-page success and the package speed budget remain unproved.

Part 10 exposes existing tag actions through list tag management in the package screen. Open **Manage lists**
and choose **Manage tags** for a list to create, rename or delete tags. Deletion
requires confirmation, removes assignments and keeps tasks. Unsaved tag names
are protected on return and retained on failed writes. Task details still assigns
and unassigns list tags. The app map describes this path. No new route or tool is
claimed; the seven endpoints, five tools and other acceptance gaps above remain.
Set `TASKS_UI_TAG_PROOF=1` for the signed UI gate to additionally verify that
`Browser proof task` retains exactly `Kept proof tag`, with `Removed proof tag`
absent after browser deletion. These fixture names are synthetic.

Part 11 adds list deletion through Manage lists, the DELETE route and
`tasks.deleteList`. A nonempty list needs a different owned destination; tasks
and subtasks move together and tags outside the destination are removed. The
last list is kept. Package deletion requests lock the actor's existing lists
through identifier-preserving updates in stable order, then count again; no
SQL migration or private host contract is added. These row locks replace the
legacy advisory lock within package requests; mixed legacy/Rust writers are not
a supported cutover mode. Privacy and lock-removal controls execute the compiled
component against disposable PostgreSQL. Set `TASKS_UI_LIST_DELETE_PROOF=1` for
the signed UI fixture to verify that `Browser proof task` moves from
`Removed proof list` to `Kept proof list` with its old tag assignments removed.
Six HTTP endpoints and four tools remain; earlier acceptance gaps still apply.
