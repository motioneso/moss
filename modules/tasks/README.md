# Tasks component checkpoint

Part 26 loads subtasks, list tags and activity independently in task details. Each
panel has its own loading, empty and retry state. Failed refreshes retain loaded
rows and unsaved editor fields. Assigned tags remain usable if list suggestions
cannot load. Retrying a read does not repeat a completed write. This adds no
route, tool, job kind or host contract.

Part 25 retains a completed recurring task's stored history when its owner
retries completion alone and the next occurrence already exists. The atomic
next-occurrence insert decides whether the retry can reuse the completed row;
if the next occurrence was deleted it is recreated. This applies to the worker,
HTTP update and status tool paths. Other edits keep using the ordinary update
path. It does not add lazy advancement, recurrence jobs or installed dispatch.

Part 24 connects date editing, task due-day labels and interpreted-search day
filters to the saved account timezone through the existing public host calendar
contract. The package-only `GET /tasks/local-day` route supplies the signed-in
account's timezone; callers cannot choose another account or a timezone. A failed
initial read keeps the date editor closed until Retry succeeds. Selected due and
do dates save at local noon, including DST and UTC+14. Unrelated edits retain the
original timestamp. Recurrence starts from the selected due day or the account's
local day, retaining that day across partial-save retries. The AI search prompt
uses the same account-local date. This does not add lazy recurrence or workers.

Part 23 adds **Task settings** in the package screen for the existing assistant
task-change preference. Opening the section reads the saved choice; the switch
is unavailable until it loads. Failed refreshes or saves keep the last confirmed
value, and Retry loading does not write a default. A successful save updates the
confirmed choice without reloading tasks. The screen explicitly says installed
chat actions still require approval while automatic-action integration remains
unfinished. The app map links this account setting to the implemented Tasks
screen rather than advertising an unimplemented settings-shell route.

Part 22 connects the disposable endpoint adapter to the real Rust queue and a
worker-role compiled guest invocation. The old harness table records only the
actual terminal state and successful handler result after the real queue finishes;
failed jobs record a generic error rather than private error details. The table does
not enqueue or execute work. Added comparisons cover private tasks, captured
accounts, archive/reopen and repeated recurring completion. This adapter still
is not installed worker dispatch or legacy queue retry/retention parity. The
privacy removal control now runs the guest with the actual worker database role.

Part 21 adds the two existing assistant-policy API routes and account-local day
boundaries for focus, at-risk, overdue and bounded summaries. The host supplies
scoped policy and calendar-day contracts; Tasks never queries core preferences.
Canonical policy beats the legacy toggle, including `always_confirm`, and a
legacy opt-out prevents the initial grant. These routes preserve the saved choice;
part 23 exposes the saved choice in the package screen, while installed chat still
requires one-use approval. The summary's timezone and local date now reflect the saved
account locale. Missing or invalid zones retain the legacy fallback. Consecutive
midnights follow DST rather than assuming every day lasts twenty-four hours.

Current remaining work: lazy recurrence advancement, recurrence jobs, full
deferred-queue policy and installed worker dispatch, public People linkage,
policy/feedback orchestration, remaining screen/settings parity, installed chat and summary presentation,
real application shell integration, performance budgets and physical second-device
HTTPS proof. The full endpoint run now matches all 96 existing cases. This is
coverage of those cases, not full semantic parity: manage-share completion
retries can still rewrite history, and duplicate HTTP/tool completion returns
success where the legacy aborted transaction can produce an error. Historical
checkpoint notes below describe the earlier state.

Part 15 adds list inclusion, show-only and exclusion under **Choose lists**,
alongside the compact list picker. Tags can be combined (any selected tag
matches) and removed individually. Counts follow status and tags before search;
**Clear filters** returns to open tasks across all lists. The screen model is
compared exactly with the existing screen over 800 combinations, including
counts, available tags and selected lists. This adds no route, tool or host seam.

This is an unfinished Tasks module package. Rust code now compiles into a real
component and handles basic task, list, tag, activity and view preference routes.
It also handles twenty-three tools: ten reads and thirteen mutations, with request
schemas enforced inside the guest. It is not a
complete replacement for Tasks. A package screen now covers list and priority views,
task editing, subtasks, tags, comments and list creation, renaming and confirmed deletion. Full screen parity,
background
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
the ISO branch; offset-free timestamps currently use UTC. The account-local day contract now
exists, but lazy recurrence roll-forward and the timestamp parser have not yet
been connected to it. Additional routes, queued work
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

Part 12 adds the focus, at-risk and overdue routes and tools, and the bounded
`tasks.summary` tool (six scopes, at most twelve rows). Twenty-three tools are
declared: ten reads and thirteen mutations. Focus returns an empty signal list
because the package has no external readiness source, so no readiness cap is
applied. Day boundaries use UTC and recurring series are never advanced by
these reads; actor-local days still need the public timezone seam. Search
interpretation needs an AI provider port and both assistant-policy routes need
a preferences port, so those three endpoints remain unported rather than faked.
The database gate includes `tools/drift-parity.ts`: exact comparisons with the
TypeScript executors for synthetic non-recurring rows under a UTC locale,
private/admin visibility, and an RLS removal/restoration control scoped to
these reads.

Part 13 adds the natural-language search interpretation route
(`POST /tasks/search/interpret`) over a new `ai` port (`generate`, resource
`chat`, the same model class the TypeScript route uses). The host supplies the model; the guest names none. The prompt
lists the account's lists and tags, the reply is parsed as JSON, and unknown
list ids and tag names are dropped with warnings. An unavailable provider, or a prompt the host refuses,
returns 503 and invalid JSON returns 502. Only the two assistant-policy routes
(they need a core preferences port) and the items listed after part 12 remain,
except that the UI fixture can now listen for a second device over HTTPS:
set `TASKS_UI_LAN_HOSTS` to comma-separated addresses before the UI gate.

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
component against disposable PostgreSQL. Run the signed UI deletion check with:

```sh
TASKS_UI_LIST_DELETE_PROOF=1 TASKS_UI_OUT=/tmp/tasks-ui scripts/run-gate.sh start --gate modules/tasks/tools/ui-gate.sh
scripts/run-gate.sh wait --follow
```

It verifies that `Browser proof task` moves from
`Removed proof list` to `Kept proof list` with its old tag assignments removed.
Six HTTP endpoints and four tools remain; earlier acceptance gaps still apply.

## Part 14: task view ordering

List view now groups tasks by Critical, High, Medium, Low, Someday and No priority,
with empty groups hidden. Grid keeps all four quadrants (Do First, Schedule,
Delegate and Later). Both views order each group by due instant, undated tasks
last, then title using browser locale comparison, matching the legacy screen.
List, status, text and tag filters still apply before grouping. The priority
picker uses the same Critical and Someday labels. No stored task order changes.

`pnpm exec tsx modules/tasks/tools/view-parity.mjs` compares package groups with
the unchanged legacy functions, including multiple lists, every priority,
undated tasks, title ties and the urgency boundary. The normal package gate
runs this comparison and the existing screen-model tests.

The current continuation boundary is the part 13 list: both assistant-policy
routes, actor timezone/lazy recurrence, recurrence jobs and deferred-queue policy,
public People linkage, policy/feedback, remaining screen/settings parity,
installed chat, real-shell integration and performance acceptance. The full
endpoint harness still needs an observer for the module queue; it currently
looks only at the earlier native spike queue. Second-device evidence from a
signed fixture does not prove real-shell integration.

## Part 16: prepare a new task before saving

New task now offers editable, removable subtask drafts and removable tag drafts.
Tags use the legacy lowercase/hash normalization; blank subtasks are dropped and
remaining steps keep their order. A tag still in the input is included on Save.
Matching list tags are reused by name, including a concurrent creator discovered after a rejected creation. These drafts do not write until Save task. Leaving the editor uses the existing
unsaved-changes warning.

If a child write fails after the parent was created, retry Save task. The screen
keeps the list and child drafts locked and resumes pending writes using receipts
for the parent, breakdown and tag assignments. Other parent fields remain editable.
This avoids repeating acknowledged work; an ambiguous lost server response still
needs server-side idempotency and is not an exactly-once guarantee.

`node --test modules/tasks/ui/capture.test.mjs` checks retries and draft controls.
`pnpm exec tsx modules/tasks/tools/capture-parity.mjs` compares draft cleaning with
the unchanged legacy editor. Both run in the package gate. This adds no route,
tool, job kind or migration. The remaining port and acceptance gaps listed above
are still outstanding; this is a screen parity checkpoint.

For the controller regression, build `tasks-domain-check` and set
`TASKS_SCREEN_BIN` to that binary when running
`node --test modules/tasks/ui/capture-app.test.mjs`. The package gate does this
and renders the actual shared-kit page for the test. Its bridge is mocked;
this is not live UI evidence.

Set `TASKS_UI_CAPTURE_PROOF=1` on the signed UI gate to verify one
`Browser proof task` with tags `#literal`, `kept` and `typed`, subtasks
`First proof step` then `Second proof step`, and no `discarded` tag.
The fixtures are synthetic. This optional check asserts actual persisted rows
created through the browser, not a mocked bridge.

## Part 17: interpreted search in the package screen

Type a phrase and choose **Interpret search**, or press Enter in Search. The
screen calls the existing account-scoped Rust route. Status moves to the normal
picker; other interpreted conditions appear as individually removable filters.
Interpreted tags require every named tag, while manual tag selections still match
any selected tag. Counts still follow status and manual tags, before search.
Typing again clears the interpretation. Clear filters resets all search, list
and tag choices to open tasks. If interpretation fails, the screen keeps the text
and explains that ordinary title/description search is available.

Dates use UTC, matching the current route; actor-local days still need the public
locale seam. `tools/search-filter-parity.mjs` compares the package with the unchanged
legacy screen over 1,380 combinations, including every due kind, combined manual
and interpreted filters, and input preservation. DOM tests cover the controller
and the actual shared-kit markup. Their bridge is mocked, so successful provider
composition still needs live proof with a configured AI service.

The existing full-port and real-shell acceptance gaps above remain. No new HTTP
route, tool, job kind, SQL or shared host interface is added by this screen slice.

## Part 18: list tag suggestions and retry safety

New task offers up to eight unselected tags from its chosen list, matching the
legacy editor. Changing lists refreshes the choices and keeps the draft. If a
list's tags cannot load, Retry list tags fetches them again; typing still works.
Selecting an existing tag preserves its stored name, including a literal leading
hash. Task details reuses a case-insensitive existing tag instead of trying to
create a duplicate; a rejected creation rechecks for a concurrent creator.

A partial new-task retry sends only parent fields changed since the last
acknowledged write. Unchanged completion and recurrence are not replayed while
retrying tags or subtasks, preserving a schedule already advanced by the server.
A lost response after a commit remains ambiguous without server idempotency.
No route, tool, job kind, SQL or host interface changes. Remaining Phase 5 gaps
listed in the report are still open; this checkpoint does not claim full parity.

Part 19 adds the legacy title-only quick capture bar. Enter or Add task uses the
sole Show only list; otherwise the existing route uses or creates Personal.
Details uses that same sole list, or the first list if none is singled out. Details carries
the title into an unsaved editor. Failed creates keep the title. If creation was
acknowledged but refresh fails, Refresh saved task only reloads; it never resends
the create. An ambiguous lost create response still needs server idempotency.
The controller regression uses the actual rendered shared-kit markup and a
mocked bridge; signed-package UI proof is a separate check. Set
`TASKS_UI_QUICK_PROOF=1` for the interactive gate to verify the two named proof
tasks and their chosen lists, and that the Details draft was not saved.

## Part 20: activity recovery and keyboard posting

Task details loads activity independently of tags and subtasks. A failed activity
read offers **Retry activity**, keeps previously loaded comments, and does not
claim the history is empty. A rejected post keeps the comment text. Enter posts
a trimmed nonblank comment; Shift+Enter keeps a new line. After an acknowledged
post, a failed refresh retries only the read. Comments retain their line breaks.
Switching tasks clears the previous task's activity. The app map describes the
controls and recovery. No route, tool, job, migration or shared host changes.

The real-markup controller regression uses a mocked bridge and runs in the
package gate. It was observed failing before this change. Set
`TASKS_UI_ACTIVITY_PROOF=1` for the signed UI gate, post the multiline comment
`First proof line` / `Second proof line` with Enter and `Button proof comment`
with the button on `Browser proof task`, then finish the gate. The gate asserts
both exact comment bodies are stored once each. This fixture remains separate
from the application shell; the full-port and second-device gaps above remain.

The signed UI fixture can seed its synthetic owner's saved timezone with
`TASKS_UI_TIMEZONE=America/Los_Angeles`. With `TASKS_UI_DATE_PROOF=1`, set the
browser-created proof task's due date to `2026-03-08` and do date to `2026-11-01`.
The gate additionally requires their persisted timestamps to be Pacific local
noon across the spring and fall clock changes. This seeds account preferences
in the disposable fixture; it does not prove Profile's timezone-setting UI.
