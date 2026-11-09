# Rust Phase 5 Tasks — implementation checkpoints

Earlier status: JS-53, Card 526 was an **approved partial checkpoint for merge**:
a real Rust component and basic routes on the merged data foundation. The user
approved pushing this slice and opening its PR so Tasks part 4 can continue.
**Full Phase 5 Tasks parity remains unfinished.** The final sections record the
verified checkpoints and the exact continuation work. Earlier
sections preserve the evidence and limits of their respective checkpoints.

## Earlier shared-host checkpoint (JS-46)

Task JS-46, Card 522. Part of #4027. Work is in the task's own checkout of
`~/Jarv1s`. This report currently covers the shared prerequisite requested by the
coordinator. **The Tasks module has not been ported in this checkpoint.**
The coordinator subsequently approved stopping JS-46 at this shared PR and
creating a separate Tasks continuation from the remaining-work list below.

## What this checkpoint adds

Package builders can use pure Rust host contracts, bounded typed queries with a
transaction per invocation, parameterized routes, host-supplied actor/time/UUID
values, an optional adapter assembly seam, verified opaque package screens and a
small shared Leptos kit with a parent bridge. Existing entry points remain
available. The coordinator authorized these shared extensions and requested an
early separate PR so People and Notes can build on main.

Each extension has a separate commit. The compile compatibility fix repairs the
Phase 4b host's use of the existing Vault API through an additive constructor.
No Tasks SQL, screens, tools or job kinds are replaced here. The host does not
open arbitrary account folders; that adapter belongs to the Notes builder.
See `rust-spike/module-host/EXTENDED_HOST.md` for contracts and limits.

## Failing-first evidence

| Extension                     | Before                                                                           | After                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| SDK                           | Missing public contracts prevented the SDK seam test from compiling              | Two contract tests pass                                                                                                          |
| Vault compatibility           | Host had five Root/Vaults type mismatches                                        | Additive module-files constructor test and host compile pass                                                                     |
| Typed queries                 | Missing compiler/authorization APIs prevented tests from compiling               | Compiler and capability tests pass                                                                                               |
| Invocation completion         | Missing call ID/completion hook prevented seam tests from compiling              | Three completion tests pass                                                                                                      |
| Per-call database transaction | Unconnected wrapper left the real insert count at zero instead of one            | Real Wasmtime/PostgreSQL test passes                                                                                             |
| Dynamic dispatch              | Missing resolver prevented route tests from compiling                            | Three decoding/ambiguity/template tests pass                                                                                     |
| Context                       | Missing context adapter prevented the capability test from compiling             | Actor, current time, distinct UUIDs and capability refusal pass                                                                  |
| Package frame                 | Missing screen/asset APIs prevented frame tests from compiling                   | Integrity, version, sandbox and asset refusal checks pass                                                                        |
| Leptos kit                    | Missing component exports prevented markup test from compiling                   | Native shared-markup test passes                                                                                                 |
| Browser bridge                | Removal control without the bound-frame/source guard allowed two forbidden calls | Guard restored; host/guest bridge tests pass                                                                                     |
| Extended assembly             | Without the new implementation, `Application::open_extended_with` is absent      | Signed install and real adapter/dispatch gate test passes                                                                        |
| Database deadlines            | Missing bounded constructor prevented the saturated-pool test from compiling     | Opt-in deadlines cover pool wait, transaction setup, queries and completion; real gate checks pool exhaustion and the next actor |

The bridge control was run after authoring its implementation; it is a real
guard-removal failure, not a claim of a pre-implementation browser failure.
Compile failures establish absent APIs, not behavioral privacy evidence.

## What was exercised

The database gate drives actual Wasmtime host imports against a throwaway
PostgreSQL database. It covers composite assignment keys, owner-only preference
keys, another account and an instance admin being unable to read or mutate the
owner's rows, forged assignment refusal, and rollback after a guest error, trap,
unsuccessful route status or SQL failure caught by the guest. Reusing an external
request ID does not reuse a transaction. Removing RLS makes the same cross-account
read see the protected row; restoring it hides the row again.

The live browser fixture installs a signed sample package and serves it through
the real frame API. Clicking its button writes through the parent bridge,
Wasmtime and account-scoped KV, then displays “Saved through the Rust module
host.” The screenshot is a real capture of that fixture. It uses a temporary
sample account and is explicitly labeled as a shared-frame check.

Validation includes the native host suite, strict host/SDK/UI clippy, SDK tests,
UI SSR markup and browser-Wasm compilation, Node bridge tests, repository lint,
format, type and file-size checks, and real database gates. The proof artifact and
PR carry their final outcomes and review findings. Screenshots, generated assets
and local logs stay out of git.

The real transaction gate first passed in the run ending `000724-dXFlbv`; the
assembly extension passed in the run ending `002529-SANMdr`. The new deadline
control and final merged-base checks are part of the final verification, not a
claim that those earlier receipts tested later code.

## Not proven and remaining work

- No Tasks package, production component ABI binding or Tasks parity harness run.
- No Tasks app-map declaration, screens, chat tools, queue consumers or People API
  integration yet. The shared APIs do not add an app-map destination by themselves.
- No authenticated Moss shell integration, sign-in, HTTPS, trusted-origin browser
  check or access from a second device in this checkpoint.
- The initial Leptos kit covers five components, not the full UI catalogue.
- File compensation is not distributed atomicity. Adapters must detect conflicting
  later edits and retain recoverable receipts rather than overwrite someone else.

The continuation is to build `modules/tasks/` against the merged shared host;
reuse original SQL bytes/ledgers and owner-only RLS; port the exact existing
routes, tools, jobs and screens; link People only through declared public APIs;
update package app-map metadata; run failing-first Tasks privacy and parity
checks; and exercise the authenticated Rust UI from a second device before
claiming full Tasks parity. Workshop and Food remain excluded.

## Independent review corrections and follow-up

Round one found two major issues: navigation could reuse the frame bridge, and
the plan failed formatting. A new public bridge test first reproduced the extra
host call after a frame load. Commands now use a single document-bound transferred port; later bootstrap
messages are ignored, and later loads revoke it. The fixture attaches before
assigning its verified URL, and the guest bootstraps during initial startup. Repository lint also
caught missing browser globals and control-character regexes; these are corrected.
The fixture now omits a GET body.

The remaining minor findings are accepted as documented limits, not merge gates:
mutation filters can be broad/tautological; mutation results have no row cap;
external side effects and nested calls are outside the typed transaction; failed
calls discard connections; cancellation during BEGIN/COMMIT lacks direct tests;
malformed non-ui screen entries fail only during serving; and encoded literal
routes can resolve differently from canonical paths. `EXTENDED_HOST.md` describes
each limitation for downstream builders. No finding was rejected to end review.

## Tasks continuation (JS-51, Card 526)

This continuation starts from merged PR #4044. Its first checkpoint builds the
native package data core in `modules/tasks/src/` and a separate host-side test
crate. The package uses only the SDK and already declared pure dependencies;
it does not import host, database-driver, filesystem or network code. Tests
must use the real existing Tasks tables through the merged typed database host.
The original migration files stay in `packages/tasks/sql/`, unchanged.

The immediate sequence is: port row serialization and typed data operations;
exercise them under a real host invocation against a disposable database; remove
RLS to verify the same cross-account assertion fails; restore it and verify the
protected case passes. Validate package metadata and the original migration
hashes. Keep each checkpoint committed and record its exact limits here.

### Decision for Ben: generated guest binding

The SDK currently supplies pure traits and JSON contracts, but no Rust component
ABI binding. The approved host accepts a component exporting the WIT `handle`
function and importing the declared Moss ports. `wit-bindgen` would generate the
canonical ABI lowering/lifting, string/result allocation and export metadata
from that WIT, allowing the native Tasks core to compile as the shipped guest
without handwritten unsafe memory glue. Its code-generation dependencies would
be new direct build inputs. A lockfile currently contains a transitive
`wit-bindgen` runtime entry; that is not approval for its code-generation feature
or new macro dependencies.

Request: approve the Bytecode Alliance `wit-bindgen` Rust binding generator and
its pinned transitive build dependencies, plus a task-local `wasm32-wasip2`
compiler target. No package or target has been installed for this request.
The coordinator instructed this continuation to proceed without the dependency
while Ben is away. A native test adapter is evidence about native package
logic and host database behavior only; it is not evidence that the package runs
as a Rust WebAssembly component. Wasm execution, signed package installation,
speed-budget measurement and live Tasks screens remain unproven until that
binding and the application joins are available.

### Native data checkpoint: what changed

The new `modules/tasks/` folder contains row-to-response conversion, basic task
reads and title updates, lists, tags and owner-only assignments, activity and
view preferences. Every effect uses the shared SDK's typed database or context
port; native host/test dependencies live in a separate verification crate.
Calendar recurrence calculations have a differential check against today's
TypeScript implementation. These are data primitives, not complete route,
chat-tool or background-job handlers.

The manifest names all six existing tables and all nine original migrations.
Its app-map feature describes only this unfinished foundation; navigation,
settings and screens stay empty so the package does not advertise a usable UI.
The TypeScript ownership declaration and the host's frozen table inventory now
include the four Tasks tables they previously omitted: lists, tags, assignments
and preferences. No migration bytes, hashes or ledger identities change. The
metadata test first failed because that inventory refused `app.task_lists`, then
passed after the ownership correction.

No new third-party package has been added: every registry package/version in the
two new lockfiles already occurs in a tracked repository lockfile. No global
installation, compiler target installation, production data change, Workshop or
Food port was performed. `wit-bindgen` remains a decision for Ben, not a hidden
fallback dependency.

### Remaining work after the data checkpoint

This is **partial implementation, unverified as a Tasks module**. The complete
Phase 5 acceptance criteria have not been met. The bounded checkpoint preserves
work before another context rollover, as requested; it does not replace the
original continuation or authorize a native-only production module.

1. Finish native route/tool/job orchestration against the SDK: validation,
   create/update/delete tasks, completion, list moves, subtasks, recurring-series
   maintenance, suggestion handling and the existing response/error contracts.
2. Declare and call People only through its published interface; port exact
   public APIs, chat tools, typed queue kinds and schedules.
3. After the binding decision, compile the same core as a Rust component,
   package the original SQL bytes, install through the signed host, add boundary
   and Wasm CI checks, and measure its speed budget. No hand-written unsafe ABI
   substitute is included.
4. Port the existing screens using the shared Leptos kit and frame bridge; update
   navigation/settings and full app-map errors/remediations alongside them.
5. Run the complete Tasks parity harness against the actual package. The current
   native recurrence comparison is only a small subset. JavaScript Date overflow,
   extended years and huge intervals are outside that subset.
6. Exercise signup/sign-in and Tasks through the real Rust shell over HTTPS,
   including trusted-origin refusal and a second physical device over LAN or
   tailnet. No live UI or second-device proof is claimed for this checkpoint.

### Checkpoint verification

The first disposable database run ended with `rc=0` (receipt suffix
`041644-DS4P7e`). Both tests passed through real host-owned transactions and the
original Tasks schema. The removal control deliberately caught two assertion
failures: another user could read and update the task while Tasks RLS was
removed. Restoring RLS made both exact assertions pass again. This is a
protection-removal control performed after the native implementation, not a
claim that the Rust component or UI was tested failing first.

The protected run also exercises all six table reads for another user and an
instance admin, owner-only list/tag mutation and assignment operations, refusal
of forged ownership and foreign activity writes, explicit manage sharing,
per-account preferences and rollback of a list rename after a failed invocation.
The Wasm in this check is the host's existing sample trampoline; Tasks logic
executes natively through a test adapter. The results establish native data and
host transaction behavior only.

Three native row/recurrence/error tests, two metadata/hash checks, 48 recurrence
comparisons against TypeScript, strict clippy for both new crates, and rustfmt
checks for both crates passed. The final proof artifact records repository
checks, the final database receipt and independent review results separately.
See `modules/tasks/README.md` for reproduction commands. There is no screenshot:
this checkpoint adds no runnable page to exercise or photograph.

### JS-51 independent review corrections

The first review of `09eb34b02` found three major issues. The existing Tasks
integration assertion still listed only two tables; it now expects the corrected
six-table declaration and is included in the disposable gate. Tasks is required
in today's application, so the package now forbids per-account disabling. A new
metadata assertion reproduced that mismatch before the flag was corrected.
The duplicate-list rename gate also reproduced an aborted host call instead of
the existing conflict response. List and tag renames now check visible,
case-insensitive names and return the original conflict messages before issuing
a conflicting update. Foreign targets still return not-found first. The final
gate exercises both duplicate renames.

The reviewer also included duplicate tag creation in that major finding. That
part is rejected: `TasksListsRepository.createTag` in `packages/tasks/src/lists.ts`
performs a plain insert without the rename methods' conflict translation;
`packages/tasks/src/routes.ts` forwards its error through the generic handler.
Changing that to a new conflict response here would change the source behavior.

The unused context UUID grant was removed. Remaining minor findings are recorded
rather than presented as proof: only the Tasks table has an RLS-removal control;
other-table assertions lack individual removal controls, and two host-refusal
assertions check only that the call fails. Recurrence numbers may serialize with
an integral decimal spelling, although the current JSON/TypeScript consumers and
the differential comparison treat them equally. Tag assembly currently scans
owner-visible tags. This unfinished package deliberately retains the Tasks id
and provisional app-map feature without advertising navigation. No CI workflow
runs these new checks yet; reproduction is explicit in the README.

One additional limit is concurrent duplicate renaming: a different invocation
can win after the preflight query, and the current host deliberately fails the
whole invocation on a SQL constraint error. That rare race does not yet preserve
the original conflict response. Full route parity requires a safe structured
constraint-error contract in the shared host, plus a concurrent regression,
before this package can replace Tasks. No raw database error is exposed.

### Second review and final setup correction

The second review of `facfa3302` found one major setup problem: the new legacy
suite needed the generated app map, but the narrowed gate did not build it.
The actual fresh-checkout run failed with the missing artifact before the
manually prepared run passed all 29 legacy tests. The gate now runs the existing
`pnpm build:app-map` command before that suite and stops if the build fails.
The final proof removes the generated artifact first, then runs the corrected
gate to check the clean-checkout path.

Both authorized review rounds are consumed. The setup correction is a later
commit and therefore needs an additional independent review round authorized by
the Assistant before Ready; passing checks do not substitute for that review.
The remaining minor review note is non-ASCII case folding: `ILIKE` preflight may
differ from the unique indexes' `lower(name)` for some names. The database still
refuses duplicates, but the structured conflict-response gap described above
covers these cases too. The shared inventory may conflict with sibling work;
regenerate it with the repository's existing inventory script if necessary.

## Tasks part 3 component checkpoint (JS-53, Card 526)

This continuation starts at merged main commit `9f57cc1e8` (Tasks data PR #4048
and shared-host PR #4044). Work remains under `modules/tasks/` plus this report.
This is a bounded implementation checkpoint, **not full Phase 5 acceptance**.
The remaining routes, tools, jobs, screens and live-device proof are substantial
enough to require more than one further context window. The brief explicitly
requires saving a clean checkpoint in that situation instead of relaying again.

### Binding approval and build

Ben approved `wit-bindgen` on 2026-11-08, overriding the earlier decline recorded
above. This checkpoint uses exact version `0.57.1`, with macros and reallocation
support only, to generate the canonical ABI from `wit/tasks.wit`. The provisional
handwritten ABI was discarded. Host-side `wit-component` `0.247.0` already belongs
to that approved generator's transitive graph and wraps the generated core Wasm;
it adds no separate third-party toolchain. The lockfiles retain the exact inputs.
A separate small `bindings/` encoder crate keeps the guest build independent of
the Wasmtime verification toolchain; producing the component does not build the
host checks. New dependency downloads stayed in scratch Cargo storage. No global tool, compiler
target, production app or production data was installed or changed.

A direct `wasm32-wasip2` build succeeded but includes WASI I/O and CLI imports.
The module host refuses those imports, so the supported build uses the existing
`wasm32-unknown-unknown` target and the component encoder, without any WASI adapter.
The host validation test must pass before calling that output runnable.

### New component surfaces

The component exports the host's `handle` contract, imports only the declared
Moss database and context interfaces, and delegates to the same Rust domain code
used by native checks. Context supplies actor, time and recurrence-series UUIDs.
The manifest declares 18 routes: basic task create/read/update, subtask reads, list
create/read/rename, tags and assignments, activity, and view preferences. Task
updates include list-move tag cleanup, child list moves, completion cascades that
skip staged suggestions, parent auto-close, and next-recurring-occurrence
creation. Host transactions own success and rollback. These are ported paths to
verify, not a claim of complete existing endpoint parity.

The archive builder uses sorted, zero-time package entries, the actual component,
icon, license, notice, changelog and all nine original, hash-checked migrations.
It produces an unsigned archive and validates it with the real package reader.
That is package-format evidence, not signed install or registry-download proof.
The app-map feature describes this incomplete component; no navigation, screen
or setting entry promises a Tasks page that does not exist.

### Validation and remaining work

The first compiled-route regression run ended with four database tests passing
and one failing: priority three incorrectly entered the important quadrant. The
source rule starts at four (`TASK_IMPORTANT_PRIORITY_MIN`). The route now uses
four; the new compiled test exercises all four quadrants, invalid query handling
and a tag query through real route envelopes. The same gate observed both
cross-account read and write assertions fail with Tasks RLS removed, then pass
with RLS restored, including for an instance admin. These are deliberate privacy
controls, not unexpected privacy failures in the protected configuration.

The compiled mutation checks passed list/tag moves, nullable dates, completion
cascades and rollback after a self-parent constraint rejects an update following
child moves and tag removals. Recurring completion creates one next occurrence;
repeating completion creates no duplicate. Earlier native test adapters stay
labeled as native evidence. The final green gate and exact reviewed commit are
recorded in the task's proof and review record; this report does not claim that
the full endpoint harness or live Tasks UI passed.

Other observed checks: six native Rust tests, 48 recurrence comparisons with the
current TypeScript implementation, two real component/archive tests, strict
clippy for the guest, checks and encoder crates, Rust formatting, shell syntax
and targeted Markdown formatting. The real host refused the preliminary WASI
component; it accepted and executed the generated component without WASI imports.
The unsigned archive round-trip validates all nine original migration hashes.
Repository static verification passed, including lint, formatting, file size,
design/catalogue, dependency and migration checks, all TypeScript checks and the
app-map build. The final clean-commit gate on `ceac38948` passed two component
tests, five database/privacy tests and all 29 legacy Tasks integration tests.
Its input fingerprint was `d716a7e92e82`. The preceding candidate run passed the
Rust tests but timed out in the legacy suite's 30-second setup hook and skipped
all 29 tests; it is not counted as green. The final gate kept the assertions and
used the supported 180-second hook/test timeout options. Actual Wasm-target
strict clippy also passed. The task proof retains both outcomes and the commands.
These receipts cover the implementation commit; the later handoff edit changes
only this report and receives its own formatting check and review.

### Independent review and limits

Round one reviewed commit `e5aa4cffc` read-only. Its major finding was the priority
boundary above; a failing-first compiled query regression reproduces it. The
review also requested query-string and failed-mutation rollback coverage; both
are now exercised. The build now isolates the encoder in `bindings/` so producing
the component does not compile the host verification toolchain. Round two
reviewed `ceac38948` and found no blocker or major implementation defect in the
explicitly incomplete checkpoint. Both rounds are recorded. A later report-only
commit records the approved partial-merge boundary and requires its own review
record before Ready. The reviewer counted 20 routes; a direct manifest/dispatcher
inventory confirms 18, which is the count used here.

Remaining minor review limits: task/tag response assembly performs per-task tag
queries and has no large-account runtime/message-size measurement. Manifest error
identifiers are descriptive app-map metadata, while wire errors retain plain
source-compatible messages. Dependency attribution in the packaged NOTICE still
needs to be completed before publication. This unfinished unsigned package must
not be published or presented as the production replacement. These limits remain
visible rather than being counted as parity proof.

### Tasks part 4 continuation boundary

This was a partial component checkpoint, Part of #4027, release note Category N/A.
Later checkpoints below supersede its route/tool counts. Remaining work is kept
in `modules/tasks/README.md` and the latest checkpoint. All six existing tables
and nine migrations remain unchanged. Workshop and Food remain excluded.
Full parity, authenticated application-shell integration and a second physical
device over HTTPS are still acceptance gates, not claims made by this checkpoint.

## Tasks part 4 checkpoint (JS-56, Card 526)

This is another **partial checkpoint**, using the brief's explicit instruction to
save a clean PR when the remaining work would exceed one further compaction.
Full Tasks replacement remains unfinished. This slice does not add a Tasks page
or claim HTTPS, signed registry installation, or second-device proof.

### What changed

The guest now runs the existing route request schemas before data effects,
including Fastify-compatible coercion, enum/range checks, required properties,
unknown-property removal and error wording. The pure schema implementation was
ported from the Phase 0b spike into the package's own source folder; the guest
does not import the native spike or host implementation. The same validation
runs for direct component route invocations.

Four existing read tools now run in the component: `tasks.get`,
`tasks.listLists`, `tasks.listTags`, and `tasks.activity`. Task details include
tags, subtasks and the last ten activity records. The tool manifest marks each
as a read and the app-map feature describes this limited set. There is no new
navigation entry. The tests call the actual guest using host-supplied actors;
chat discovery, presentation and the installed host's approval flow are not
proved by direct tool invocation.

The new disposable HTTP adapter authenticates with the existing safety core and
runs declared task routes through Wasmtime and host-owned database transactions.
It has no native Tasks repository fallback. Its HTTP parser and the unchanged
language-neutral differential harness are reused from Phase 0b. Both binaries
are built by the package verification crate. The adapter is test infrastructure,
not the production shell or an installed signed package. It pre-validates HTTP
bodies before authentication, matching Fastify's order; differential validation
cases therefore do not independently prove guest validation. The direct
component and native contract tests cover that boundary. Its listener is
loopback-only, and its script claims and releases both ports through `devports`.

The handoff's suggested extra HTTP list filters were checked against current
`packages/tasks/src/routes.ts`: HTTP listing forwards only tag and quadrant.
List, status, priority, due bounds and completion bounds are criteria for the
`tasks.list` chat tool. Adding them to HTTP would change current behavior; they
remain required for the unported tool.

No original migration changes, new tool versions, global installs, production
data changes, or Workshop/Food work are included. Locked dependencies and the
already provisioned compiler target are used from scratch storage. The new
host-side direct dependencies already exist in the project; their locked
versions are unchanged.

### Verification

The native contract regression failed before validation was added: the component
handler returned `title is required` instead of the source schema's
`body must have required property 'title'`. After the change, that exact assertion
and the other invalid-request cases pass. Native checks pass: eight unit tests,
one contract test and three row/response tests. Strict guest and host-tools
clippy passes, as do six HTTP parser tests and two metadata/migration checks.

The disposable database gate passed: two compiled-component/package checks,
six Tasks database checks, and all 29 legacy Tasks integration tests. The new
tool check covers owner results, cross-account and admin denial, numeric-title
coercion, tags, and the activity window. Its exact cross-account read assertion
was observed failing with Tasks RLS removed, then passing after restoration.
Existing compiled route read/write removal controls also still pass.

The unchanged endpoint differential harness ran against the actual component:
**61 of 77 cases passed; 16 failed**, and the gate correctly exited nonzero.
This is a baseline for the continuation, not full parity or a completion score:
the case set also includes safety-core cases. The failures are:

- One deferred-status/job case: the route and queue are absent.
- Seven list-deletion cases: the route and reassignment behavior are absent.
- Seven focus, at-risk, overdue and timezone cases: unfinished static paths
  currently fall through to the generic task-ID route and return a host error.
- One recurrence-update expectation: the harness's raw subset assertion rejects
  the numeric representation `2.0` versus `2`, although its canonical comparison
  reports no value difference. Keep the failing result visible until resolved.

The adapter does not test tool discovery or approval. The unchanged harness
does not exercise the four new tools, both queue kinds or every missing route.
Compiled tool fixtures are separate evidence and do not replace those parity
cases. `report.json` and both server logs remain outside the public repository.
The checkpoint PR and proof artifact carry the final static-check and fresh
review receipts. Database gates are repeated on committed inputs before Ready;
earlier dirty-tree receipts are not reused as final-commit verification.

Fresh review found a missing tool-service capability. A new boundary test first
failed with `moss:module/tools@1.0.0` refused as undeclared. The manifest now
declares `offer` and `run` for exactly the four read tools. The same test uses a
labeled sample trampoline through the actual host service to verify offers,
permission summaries, approval denial and one-use approval consumption. It
stops at the unbound installer after approval: installed dispatch and real
assistant tool discovery remain unproved, rather than being inferred from
these service checks. The database gate now also runs this service-boundary
test and both metadata checks alongside the existing component checks.

The review's lower-severity limits remain explicit. The current host's `Tool`
metadata cannot express the legacy `tasks.view` permission, `content: outside`
prompt-injection classification, background-read authorizers or output schemas.
Port these through public host contracts before enabling assistant integration;
read-result fixtures are not policy parity. Guest tool errors remain deliberately
generic because the SDK lacks a typed safe tool-error contract. The copied pure
schemas are package-owned, not linked to the native spike; their duplication
must be reconciled or checked when the source request contract changes.

### Remaining acceptance work

All nine missing HTTP endpoints listed above remain absent. Preserve lazy
recurrence, local-day/date behavior, suggestion/triage feedback, duplicate-name
conflict behavior under concurrency, and all existing response contracts while
porting them. The core SDK has no actor-timezone or transaction-lock operation;
these joins need explicit public contracts rather than guest SQL or reads from
other modules' tables.

Nineteen tools remain: `tasks.summary`, `tasks.list`, `tasks.heartbeatWindow`,
`tasks.focus`, `tasks.atRisk`, `tasks.overdue`, `tasks.create`, `tasks.update`,
`tasks.updateStatus`, `tasks.breakDown`, `tasks.addActivity`, `tasks.assignTag`,
`tasks.unassignTag`, `tasks.createList`, `tasks.renameList`, `tasks.createTag`,
`tasks.renameTag`, `tasks.deleteList`, and `tasks.deleteTag`. Their policies,
action presentation, chat targets, visual summaries, heartbeat/monitor and
suggestion feedback remain part of parity.

Both typed queues, schedule reconciliation, People/public core APIs, all Tasks
screens and settings, signed registry installation, speed-budget measurements,
full differential green, and live Rust-shell HTTPS UI proof from a second
physical device remain unfinished. A passing component test or HTTP fixture is
not that UI/device evidence. The manifest and README continue to say so.

## Tasks part 5 checkpoint (JS-59, Card 526)

This is a **partial screen checkpoint**, saved under the brief's instruction to
stop at a clean point rather than require another context relay. It does not
complete Phase 5. The existing HTTP/tool/job gaps above remain acceptance work.
No original migrations, shared host source, People internals, Workshop or Food
code are changed.

### Package screens and data preservation

The actual package now includes a `/tasks` screen and navigation/app-map metadata.
Shared Leptos kit components render the markup. External JavaScript uses the
canonical public frame bridge, and the CSS adds responsive layout around shared
controls and tokens. The controller covers priority/list views; list, status,
text and tag filtering; creating and editing tasks; completion; list creation
and renaming; subtasks; tag assignment/removal; comments and activity; and the
saved default view. Suggestion buttons use existing status transitions, but
suggestion feedback and policy parity remain unfinished.

Editing a title preserves the original date-time, status and recurrence fields
when their controls have not changed. The screen identifies its dates as UTC;
this does not implement the missing public actor-timezone contract. The editor
keeps drafts after a failed request and asks before discarding unsaved task
changes. Assistant chat is an affordance through the bridge, not evidence of
installed assistant integration. Settings, Focus, advanced search, list deletion,
People links, drag ordering and the rest of legacy screen parity remain absent.

Whole-number recurrence intervals now produce integer JSON tokens, matching
JavaScript's serialized response. The exact regression failed before the change
(`as_u64()` returned `None` for interval two), then passed with the complete
native guest tests. The five controller-model checks cover unchanged timestamps,
status and repeat rules, explicit clearing, filtering, quadrant boundaries and
the existing persisted view contract (`priority` for List, `matrix` for Grid).
The saved-view regression failed before the review repair and passes afterwards.

### Installed UI check and limits

`modules/tasks/tools/ui-gate.sh` runs only through `scripts/run-gate.sh`. It builds
the actual component, signs an ephemeral registry/index/package, and uses the
real module host's selection, download and install APIs. Its HTTPS server reuses
the real Rust network setup/sign-in/trusted-origin boundary. A small fixture
frame hosts the installed screen; **this is not the Phase 4 application shell**.
The fixture uses disposable data, a generated certificate and a claimed loopback
port. It does not publish a registry or change machine certificate trust.

Guest native tests, Wasm builds and host-tool checks use separate target folders.
`build-component.sh` now accepts `TASKS_GUEST_TARGET_DIR` independently of the
host's `CARGO_TARGET_DIR`, preventing target-feature leakage between them. The
approved, already-provisioned toolchain and generator are reused from scratch;
no global tool is installed. Initial gate launches stopped before tests because
the selected toolchain lacked the Wasm target; corrected runs select the existing
provisioned scratch toolchain.

### Acceptance still outstanding

The nine missing endpoints, nineteen remaining tools, both typed queues and
schedule reconciliation are unchanged from part 4. They still need actor-scoped
privacy removal controls and differential cases. Public host contracts for
actor timezone and transactional list-deletion locking are still required;
do not substitute guest SQL or a race-prone pre-check. Assistant policies,
feedback, background authorizers, People/public API links, attribution inventory,
large-account/message-size budgets and full legacy screen/settings parity remain.

The authenticated Phase 4 shell integration and a real second physical device
over LAN or tailnet HTTPS remain unproved. A loopback browser, phone-sized
viewport, signed-package fixture or green unit test must not be presented as
that evidence. Full differential green is still required before declaring the
Tasks replacement complete.

### Part 5 validation and review

The disposable database gate completed with exit zero: two compiled component
checks, two metadata checks, one tool-service boundary check, six privacy/data
checks and twenty-nine legacy Tasks integration checks. The privacy checks
observed the identical cross-account read/write assertions fail with RLS removed
and pass after restoration; the compiled read-tool check does the same. These
are pre-final-commit development receipts, not reused final-commit verification.

The new differential attempts did **not** reach any cases. The unchanged
TypeScript server missed the harness's ninety-second startup deadline twice
on this heavily loaded machine. No new parity score is claimed; the earlier
part 4 score above remains historical and full differential green is outstanding.

Fresh Claude review found a major view-preference mismatch and minor issues
with the Suggested filter, draft baseline after an extras failure and an unused
direct dependency. All were repaired: the view values match the legacy API,
the Suggested filter is enabled, the draft baseline is established before
loading extras, and the unused dependency is removed. The live fixture also
exposed a registry-identity mismatch; it now supplies the actual signed identity
and logs only static failure-stage labels for troubleshooting.

The live disposable fixture reached owner signup through the real HTTPS UI and
successfully selected, downloaded and installed the signed Tasks package. Its
certificate-verifying network checks passed for anonymous sign-in redirection,
unknown Host rejection and unknown Origin rejection. Browser navigation used
its explicit self-signed-certificate exception; this is separate from the
certificate-verifying Node check.

**The live Tasks UI did not pass.** It rendered the package's load-error state
and made no account-data API calls. A bounded browser diagnostic recorded the
frame `load` event before the opaque frame's `connect` message. The canonical
`rust-spike/module-ui/web/host-bridge.mjs` initial-load handler disposes its
listener when no command port has arrived yet. The unchanged package uses
that public bridge; this checkpoint does not patch or bypass the shared host.
The UI gate deliberately finishes unsuccessfully rather than record invented
interaction or persistence proof. Resolve this public bridge lifecycle join
and repeat task/list/tag/comment/view/draft checks through the installed UI.

The screen controller is implemented but remains **unverified on the live path**.
No successful task creation through the browser, real-shell integration,
physical second-device access or complete phase parity is claimed.

## Tasks part 6 checkpoint (JS-70, Card 526)

This continuation repairs the installed package screen's startup failure. It is
a partial checkpoint under the brief's context-boundary rule, not completion of
Phase 5. Full endpoint, tool, job and legacy-screen parity still needs more work.

### Loading repair and shared document styles

The initial frame load can arrive before the guest's queued connection message.
The old bridge closed at that boundary, so the browser displayed “Tasks could not
load” without issuing account-data requests. A regression reproduced that event
order, and the actual signed-install HTTPS fixture reproduced the load-error screen.

The public bridge now accepts an installer-verified `screenUrl`, adds a random
document key in its fragment, attaches listeners and opens the frame. The guest
returns that key with its document-bound command port. This permits either
initial event order while refusing a different document's connection without the
key. Existing unkeyed callers keep their original strict timing. Tasks and the
shared frame example use the keyed path. A later frame load revokes the bridge;
responses still waiting on the host are discarded after revocation. No account
session credential is passed into the package.

Twelve bridge checks cover both initial orders, wrong origin/source/key, later
connections, navigation before connection, late replies, path restrictions,
bounded resize, disposal and timeout. Removing the document-key check, the
frame-source check or navigation revocation in separate disposable copies makes
the checks fail assertions. The protected suite and five controller-model checks
pass. These controls test the bridge guards, not every browser navigation race.

The live frame also exposed missing document typography: isolated documents do
not inherit the parent page's body font. The shared module stylesheet now supplies
the authored sans body type, display headings, sizing and inherited control fonts.
Tasks keeps its layout-only stylesheet. Its app map and changelog describe the
loading and typography repair without claiming full parity.

### Verification and remaining acceptance

Live interaction and differential results are recorded in this section.
The task proof contains the command receipts and screenshots.
The disposable privacy/data gate passes: six compiled/native privacy checks
and twenty-nine legacy integration checks, including failing-first controls. The UI fixture installs a real signed package and routes
real account data through the Rust host, but it remains a small fixture frame;
it is not the authenticated Phase 4 application shell. A local browser or narrow
viewport does not prove a second physical device.

A second live failure was reproduced after loading: native form submission is
blocked by the package sandbox before the `submit` event. Save buttons now handle
activation directly, validate the form, and call the existing public bridge.
The sandbox and CSP stay unchanged. The installed browser check now confirms
list creation and renaming, task creation and editing, subtasks, tag assignment,
comments, completion and the Done filter. Draft protection offers Keep editing
and Discard changes. The saved Grid preference survives a full reload, as do the
edited task, tag, subtask and comment. Both desktop and narrow layouts were
inspected; screenshots are in the task proof artifact. The persistence gate
confirms exactly one browser-created proof task in the real Tasks table.
Native keyboard selection was used for the Done filter: the task browser
CLI's select helper updates the value without the `input` event this control uses.

The nine missing HTTP endpoints, nineteen tools, both queues and schedule
reconciliation listed in part 4 remain unfinished. Public actor-timezone and
transactional list-deletion contracts, People links, assistant policy/feedback,
full screen/settings parity, speed budgets and the real-shell join remain.
Second-device HTTPS proof and full differential green are still required.
The exact next priority is now to finish these parity gaps and the application
join, rather than reimplement the bridge or mistake the fixture for the shell.

No global tool, package or target was installed. The build reuses the previously
approved scratch Rust/Wasm toolchain and pinned `wit-bindgen` dependency graph.
Host, native guest and Wasm output folders are separate. JavaScript dependencies
were restored from the repository's frozen lockfile in this worktree. Database
work runs only through `scripts/run-gate.sh` on disposable servers.

### Checkpoint verification record

- `node --test rust-spike/module-ui/web/bridge.test.mjs modules/tasks/ui/model.test.mjs`: seventeen passing checks; original initial-load regression failed first.
- Scoped ESLint and Prettier checks pass. `pnpm verify:static` passes (lint, formatting, repository invariants, type checks and app map build).
- Native guest: thirteen checks pass across unit, public schema and repository contract suites.
- Shared frame example: `cargo +1.95.0 check --locked --offline --manifest-path rust-spike/module-host/Cargo.toml --example frame_check` passes.
- Disposable data gate: two component checks, two metadata checks, one tool-service check, six privacy/data checks and twenty-nine legacy integration checks pass. Cross-account read and write assertions fail with RLS removed and pass with it restored.
- Full differential gate: **62 of 77 match, 15 fail**. The failures cover deferred status work; focus, at-risk and timezone-based overdue routes; and list deletion/moves. This is current evidence, not reuse of the earlier checkpoint's result.
- Signed-install UI gate: certificate-verifying HTTPS, sign-in redirection, unknown Host/Origin refusal, signed registry selection/download/install and browser persistence pass. The frame makes real `/api/m/tasks/...` calls through the installed router. Chrome uses a temporary self-signed-certificate exception; the separate Node network assertions verify the generated certificate.
- Clippy was unavailable in the existing scratch toolchain. No Rust domain logic or migration changes were made here. No claim of complete browser, accessibility, performance, real-shell or remote-device acceptance is made.

Exact commit/fingerprint receipts and failures are attached to the task proof;
these distinguish each tested build rather than treating earlier runs as final. A future
continuation should start with the remaining parity routes/jobs and real-shell
join. The temporary fixture is loopback-only and was stopped after this check;
it is not a deployed application or a second physical device.

The first independent review found that `randomUUID` would fail in a plain HTTP
LAN caller of the shared bridge. The key now uses `getRandomValues`, available
without a secure context; application access still requires HTTPS. Screen URLs
are also checked after URL normalization to reject dot-segment escapes. Both
regressions fail first and then pass after repair. The review's remaining minor
notes are limited automated form coverage and untested initial blank-frame load
behavior in other browsers. Actual Save and Enter-key list creation were checked
in the signed installed Chrome fixture; other-browser timing remains unproven.

### Main-branch reconciliation

The current main branch independently added the public `openModuleFrame` helper
and its `moss-bootstrap` fragment protocol for Calendar. The conflict resolution
keeps that interface and its tests alongside Tasks' `screenUrl`/`moss-frame`
contract; existing Calendar and People callers remain supported. The shared guest
echoes whichever initial fragment it receives. Both paths keep source/origin
checks, private command ports and load revocation. The asset build keeps main's
startup reset and base styles plus Tasks' document foundations. No generated
inventory entries were discarded. The combined bridge/controller suite has
nineteen checks; the timeout check now waits for message delivery before closing
its received port so machine load cannot cause a cleanup-only failure.

The first post-merge gates stopped at the locked dependency check: main added
`web-sys` to the shared module UI, so the Tasks verification lockfile also needed
that existing dependency edge. An offline refresh changes only that one entry;
no dependency version or new tool installation is introduced. The gates are
rerun on the resulting clean commit.

## Tasks part 7 checkpoint (JS-74, Card 526)

This continuation adds twelve assistant mutation handlers and the ordered
breakdown route inside `modules/tasks/`. It is a bounded checkpoint under the
brief's context rule, not completion of Phase 5 or a replacement for the current
Tasks app. Workshop and Food remain excluded.

### Actions and ordered breakdown

Sixteen tools are now declared: the existing four read handlers plus create,
update, update status, break down, add activity, assign/unassign tag, create/rename
list, create/rename tag and delete tag. They call the existing account-scoped
query primitives. Tool text reaches the existing database constraints without
trimming: valid titles retain whitespace, descriptions may be empty, and blank
titles are rejected. Nullable tool fields retain null rather than HTTP form coercion.
Completion reuses the existing cascade and next-occurrence code. The host keeps
its one-use account approval guard. Automatic-action policies, approval
presentations, background authorization and installed chat integration remain
unfinished; tool handlers alone do not prove those joins.

`POST /tasks/:id/breakdown` validates and trims ordered steps, creates children in
the parent's list and records the existing `broken_down` activity. The existing
database trigger rejects grandchildren. All calls share the invocation's host
transaction. The hierarchy check verifies rejection before a grandchild is
persisted; failure after a partial breakdown is not separately proved here. Empty
breakdowns retain the legacy no-op behavior, including for an absent parent.

The package app map and changelog describe these actions and their limits.
No existing migration or shared host source is changed. The pinned approved
wit-bindgen graph and provisioned Rust/Wasm toolchain are reused in scratch;
nothing is installed globally. The offline host-tools lockfile refresh produces
no diff on this main revision.

### Validation and limits

The new checks execute the compiled component, compare mutation results against
current TypeScript executors and extend the endpoint harness with breakdown
cases while retaining every historical case unchanged. Development and final
receipts, privacy removal controls and independent review are recorded in the
task proof artifact. The development endpoint run on `307733191` completed:
**69 of 84 cases match, 15 fail**. All seven added breakdown cases match; the
fifteen remaining failures are the previously listed deferred-status, focus,
at-risk, timezone-overdue and list-deletion gaps. The first attempt timed out
starting the TypeScript server; the second completed the suite.

The first review found three major verification gaps: the removal control stopped
after its first assertion; view-shared parent ownership was untested; and tool
comparisons omitted set-value, cascade and failure scenarios. Checks now exercise
update, status and activity controls separately, foreign task/list/tag targets for
another user and an admin, and a real shared-parent query with its `Owned`
predicate removed and restored. The query control records actual attempted inserts;
it does not fabricate database responses or claim that all database protections
were removed. The tool differential covers dates, effort, parent relationships,
list moves and dropped tags, recurring completion, persisted cascades, missing
targets and rejected relationships. This remains bounded coverage, not exhaustive
input or error-message parity. Generic host errors and stricter input-schema
rejections still differ from legacy executor error details.

The first action check incorrectly expected a blank title to persist despite the
unchanged SQL constraint; the corrected check requires rejection on both sides.
The hierarchy check likewise now asserts the actual HTTP 500 response rather
than expecting the route adapter itself to throw. Native guest checks at this
checkpoint pass ten unit and five integration checks. The current-build database,
static and signed-install UI receipts are attached to the proof rather than
reusing old successful receipts as evidence for changed inputs.

The installed HTTPS fixture rendered the real package screen, saved a task through
the form and returned two ordered children from the new installed breakdown route.
Its first completion receipt hit a file-notification race (the runner read the
new file before its contents arrived); the runner now waits for nonempty content.
This remains loopback fixture evidence, not full-shell or physical-device proof.
Rustfmt is absent from the provisioned toolchain; no component was installed.

### Remaining work after part 7

- Eight endpoints remain: search interpretation, deferred status, list deletion,
  focus, at-risk, overdue, and GET/PATCH assistant-action preferences.
- Seven tools remain: summary, list, heartbeat window, focus, at-risk, overdue
  and deleteList. Both job kinds, recurrence scheduling/lazy roll-forward,
  actor timezone, People public APIs, feedback and action-policy orchestration
  remain as listed above.
- Full screen/settings parity, the authenticated application shell, large-account
  budgets and a real second device over HTTPS remain unproved. The signed-install
  fixture is a separate loopback frame and must not be called the application
  shell or a remote-device check.
- Correction to the part 4 list: current TypeScript `GET /api/tasks` only applies
  `tagId` and `quadrant`. The additional list/status/priority/date filters are a
  repository and tool contract, not current HTTP behavior. This checkpoint
  preserves that distinction.

Part of https://github.com/motioneso/moss/issues/4027. Release note Category: N/A.

## Tasks part 8 checkpoint (JS-77, Card 526)

This bounded continuation adds the heartbeat read tool and deferred-status route
and worker under `modules/tasks/`. It remains an unfinished Tasks replacement.
All earlier acceptance gaps remain unless explicitly closed below. Workshop and
Food are excluded. Part of #4027; release note Category N/A.

The heartbeat query returns at most twenty owned open tasks plus one lookahead
row, and separately checks the next later due date. It matches the existing
material revision, Unicode UTF-16 hashing, truncation and next-boundary shapes.
View sharing does not authorize this read. It never advances recurrence. The
host's one-use tool approval remains; background authorization and scheduling
are not joined by declaring this handler.

Deferred status now enqueues task/status metadata through the jobs port, whose
host envelope captures the account. The job handler reuses status completion,
cascade and recurrence mutations in the invocation transaction. The host's
namespaced queue uses kebab-case parameter names; HTTP and worker result shapes
retain their legacy names. This is not full queue parity: the public host fixes
retry/backoff and retention defaults, and its parameter schema cannot retain the
optional arbitrary request key. That key is parsed but not persisted; the legacy
route did not use it as a singleton key. The endpoint adapter still denies the
jobs port, and the existing harness observes the old spike queue rather than this
module queue. Its deferred-status case remains an acceptance gap. The dedicated
test enqueues and claims through PostgreSQL, then invokes the compiled handler
directly with the claimed actor; it does not prove installed worker dispatch.

The branch originally pointed at Phase 0a. With no task commits or local edits,
it was advanced to merged main, including Tasks part 7, before implementation.
The tools lockfile was resolved offline against the existing scratch cache; the
shared UI dependency edge was already current. No global tool or target was
installed. Builds reuse the approved pinned wit-bindgen graph and scratch Rust
1.95 toolchain. Formatting uses the already installed system Rust 1.95 rustfmt;
the scratch toolchain has no rustfmt component.

Final gate receipts and review results belong to the task proof and checkpoint PR.
Native guest checks pass eleven unit and five integration checks, including a
non-BMP UTF-16 hash vector; the host-tools Cargo check also passes. The first
independent review found no blockers or majors. Its four minor findings were
addressed: precise removal outcomes, Unicode coverage, queue-test wording and
unrelated manifest escaping. Removal controls now require successful calls and
the specific exposed row/result before catching the expected privacy assertion,
so an unrelated invocation error cannot count as evidence of a removed guard.

The signed-install frame remains a fixture,
not the authenticated application shell or a second physical device. Further work
includes seven endpoints, six tools, recurrence jobs and scheduling, queue policy
parity, actor timezone/lazy recurrence, People public APIs, policy/feedback, full
screens/settings, the application join, performance and second-device HTTPS.

## Tasks part 9 checkpoint (JS-81, Card 526)

This bounded continuation adds `tasks.list`: list, tag, status, priority, strict
due/completion dates and quadrant filters, tags, stable ordering and column order.
The HTTP route keeps its narrower contract. The app map names the new handler.
Actor-local lazy recurrence remains unfinished; rows are persisted occurrences.
The existing ISO parser is reused; free-text and offset-free date parity is incomplete.

The new database check compares the actual component with the TypeScript executor
on non-recurring rows, including private/admin/shared visibility, date boundaries,
ordering and tags. The optional thousand-task acceptance probe remains red.
An RLS removal control targets the synthetic list, exposes its six private rows
and fails the same hidden-row assertion before restoration. Before implementation,
the comparison failed against the part 8 component because the handler was absent.
Final current-build receipts, endpoint results, signed UI and review are in the proof.

No SQL, shared crate, global tool or target is changed. The approved pinned
wit-bindgen graph and existing scratch toolchain/cache are reused; the tools
lockfile is refreshed offline without a diff. Seven HTTP endpoints and five tools,
recurrence/timezone, list-delete locking, queue policies, People, feedback/policies,
full screens/settings, installed chat, real shell, performance and a second device
over HTTPS remain unfinished. Part of #4027; release note Category N/A.

## Tasks part 10 checkpoint (JS-85, Card 526)

This continuation exposes existing tag actions through the package screen's
Manage lists path: create, rename and confirmed deletion. Deleting a tag removes
its assignments and keeps tasks. The task editor continues to assign and unassign
tags. Unsaved names are protected when returning to lists and retained after
request failures; refreshed tag names and removals reach the task list and filters.
The package app map now names these controls. No new HTTP route or tool is claimed.

A compiled-component check exercises the same read, rename and delete privacy
assertions with the real tag RLS removed and restored. It also checks deletion's
assignment cleanup and task preservation. The optional signed UI tag check
verifies browser-created data in the disposable database. These are real host
transactions and installed package bridge requests, never mocked browser responses.
The legacy interface offered rename/delete through routes and chat tools; this
package also exposes them in Manage lists. This is not a claim of screen parity.
The first full endpoint comparison in this continuation matched 69 of 84 cases
and exited unsuccessfully. Its fifteen failures remain visible; no endpoint
parity improvement is claimed for this UI checkpoint. Current committed gate
receipts, browser evidence and review findings are in the task proof.

The work reuses the approved pinned wit-bindgen graph and existing scratch Rust
and Cargo cache. The tools lockfile was resolved offline before locked gates;
no global tool, package or compiler target was installed. Existing lockfile
JavaScript dependencies were installed offline inside this worktree.

Seven HTTP endpoints and five tools remain, along with actor-local dates and lazy
recurrence, list-delete locking, queue policy/worker parity, public People linkage,
feedback/action policy, remaining screens/settings, installed chat, real application
shell, performance and physical second-device HTTPS acceptance. The signed UI
fixture is loopback-only and separate from the application shell. This is an
unfinished checkpoint, not completion of Phase 5. Part of #4027; Category N/A.

## Tasks part 11 checkpoint (JS-89, Card 526)

Manage lists now offers confirmed deletion and an optional owned destination.
The DELETE list route and `tasks.deleteList` share one transaction: a nonempty
list requires a destination, every task and subtask moves, assignments outside
the destination are removed, and the source list is deleted. The last list stays.
The package app map names the controls, restrictions and recovery path. HTTP
checks cover missing-body rejection and empty-object deletion, matching legacy.
Failed confirmation retains its destination and focuses the picker; Keep list is default.

Package deletion requests lock the actor's existing lists in identifier order
using identifier-preserving updates, then count again. The public typed query
port has no advisory-lock operation. A successful-deletion check compares the
entire surviving database record, including timestamp precision. Concurrent mixed
legacy/Rust writers are not a supported or proven cutover mode.

The unchanged deletion assertion fails against the old component (404 instead of
409). New compiled checks exercise deletion as the owner, another account and an
admin. The same private-list assertions fail with actual list RLS removed and
pass after restoration, through both route and tool. The concurrency removal
control forces both unprotected counts before deletion. The strengthened protected
control holds the first count until PostgreSQL reports the second request waiting
on its row lock, then requires the second count after commit and one conflict.
Failure after tag removal must roll back tasks, assignments and list records.

The first full endpoint run matched 76 of 84 cases, up from 69; all seven existing
list-deletion cases pass. Its eight failures concern deferred-job integration,
focus/risk and timezone behavior. An additional case covers empty-object deletion.
The data comparisons pass 50 mutation-tool and 84 filtered-list cases. Native
guest checks pass. Current committed receipts and independent review results are
in the task proof. Bulk deletion uses the existing same-list tag rule and cascading
source-tag removal. A compiled 1,011-task check uses nine calls under default fuel.
Concurrent insert/FK-conflict status parity remains unproven: the public port has
no typed constraint-error contract; arbitrary host failures must not become 409.

The signed UI fixture passed cancellation, nonempty rejection, destination moves,
task/subtask retention, tag removal, last-list refusal and persistence after reload.
A narrow viewport was checked. The exact optional deletion-proof command is in
the README. This fixture binds loopback and is separate from the real shell.
The work reuses the approved pinned wit-bindgen graph, scratch toolchain/Cargo
cache and declared offline JavaScript dependencies. The tools lockfile was
refreshed offline without a diff. No global installation, shared crate or SQL
migration changed.

Six endpoints and four tools remain: search interpretation, focus, at-risk,
overdue and both assistant-policy routes; summary, focus, at-risk and overdue
tools. Actor-local dates/lazy recurrence, recurrence jobs, queue policy/worker
parity, public People linkage, feedback/action policy, remaining screens/settings,
installed chat, real shell, performance and physical second-device HTTPS remain
unfinished. This is a checkpoint, not Phase 5 acceptance. Part of #4027; Category N/A.

## Tasks part 12 checkpoint (JS-97, Card 526)

This continuation adds the focus, at-risk and overdue routes and tools, and the
bounded summary tool, inside `modules/tasks/`. It remains an unfinished Tasks
replacement. Workshop and Food are excluded. Part of #4027; release note
Category N/A.

The three drift reads run over persisted rows in the signed-in account scope.
Overdue means open and due before today. At-risk means open, priority at least
three, due within two days or with a passed do-date, and no completed subtask.
Focus is the deduplicated union, ordered by priority, due time and effort.
The summary tool returns at most twelve rows for today, overdue, upcoming,
undated, completed or all scopes, with due-state labels and an honest coverage
line. Twenty-three tools are now declared: ten reads and thirteen mutations.
The app map names the new reads through the package feature list.

Day boundaries use UTC and these reads never advance recurring series. The
guest still has no public actor-timezone seam, so actor-local day behaviour
and lazy recurrence remain unfinished, as in earlier checkpoints. Focus
returns no external readiness signals, so the legacy readiness cap never
applies in the package. Search interpretation needs an AI provider port and
both assistant-policy routes need a core preferences port; those three
endpoints are left unported rather than answered with invented data.

The database gate gains `tools/drift-parity.ts`. It compares the compiled
focus, at-risk, overdue and summary results exactly with the current
TypeScript executors on synthetic non-recurring rows, for the owner, another
account and an instance admin. Its actors carry a UTC locale, so both sides
use the same day boundary. The same private overdue rows appear when Tasks
row-level security is removed and are hidden again after restoration.

Remaining after part 12: search interpretation and both assistant-policy
routes (blocked on AI and preferences ports), recurrence jobs, deferred-queue
policy parity, actor timezone and lazy recurrence, public People linkage,
policy and feedback orchestration, full screen and settings parity, real-shell
integration, performance budgets and second-device HTTPS proof.

Part 12 validation so far: the database gate passes on the first part 12
commit, including 30 exact drift and summary comparisons and the scoped
privacy removal control. The full endpoint comparison matches 84 of 85 cases,
up from 76 of 84 in part 11; the only failure is the deferred-status job case,
whose endpoint adapter still cannot observe the module queue (the part 8
limit). The signed-install browser check passes: a new owner created a list
through Manage lists, created `Browser proof task`, and saw it in the task
list. That fixture binds loopback only, so access from a second physical
device over LAN or tailnet HTTPS is still not proven; a direct request to the
machine's LAN address got no answer from the fixture.

Independent review round one found no blockers and four major issues, all
fixed in a follow-up commit: the summary now drops rows from the end when its
plain-text form exceeds the legacy 4,000-unit bound; the at-risk
finished-subtask check and the three new routes now batch their lookups;
the parity script gained long-title, twelve-row and day-boundary cases; and
the focus sort compares due times in milliseconds.

## Tasks part 13 checkpoint (JS-101, Card 526)

Adds natural-language search interpretation inside `modules/tasks/`, plus a
second-device HTTPS proof. Still an unfinished Tasks replacement; Workshop and
Food are excluded. Part of #4027; release note Category N/A.

`POST /tasks/search/interpret` uses a new `ai` port in the guest WIT and the
manifest (`generate`, resource `chat`, the model class the TypeScript route uses; the host rejects model and
provider parameters). The prompt carries the account's lists and tags and the
UTC day. Failures map to 503 (provider unavailable) or 502 (invalid JSON).
Normalisation keeps known list ids and case-insensitive tag names, enforces
enums, priority 1-5, due kinds and confidence, and emits "Unknown list/tag
ignored" warnings. Known small difference: tag names are listed in codepoint
order where the TypeScript code uses locale order. The route is in the app map
through the package feature list.

Remaining after part 13: both assistant-policy routes (need a core
preferences port), recurrence jobs, deferred-queue policy parity, actor
timezone and lazy recurrence, public People linkage, policy and feedback
orchestration, full screen and settings parity, real-shell integration,
performance budgets.

Tooling record: wit-bindgen was used from an existing cargo cache. No global
install was made. The wasm32 standard library came from a copy of the 1.95.0
toolchain kept in scratch (`rustup target add` run there), and `pnpm install
--frozen-lockfile` ran inside this worktree.

Validation: package gate passes; parity matches 85 of 86 cases (the same
deferred-status job case as part 12 is the only failure; the new request
validation case passes against the TypeScript API); the UI gate passes.

Second device: the fixture listened on the LAN and tailnet addresses over
HTTPS with a generated certificate. From the MacBook, over the tailnet, with
only the public certificate copied: the certificate fingerprint matched, TLS 1.3
verified against the tailnet address, an unsigned request got 303 to sign-in,
a wrong host got 421 and a wrong origin got 403. A browser on the tailnet
address then signed in and listed `Browser proof task`. The owner account was
created from loopback, as the setup page requires. The Mac check was curl, not
a Mac browser.

Independent review round one found no blockers and two majors, both fixed:
the route now asks for the chat model instead of the structured one (the
router's structured class could fail for users the TypeScript route served),
and the lists and tags sent in the prompt are capped (200 and 300) so the host's
64 KB prompt limit cannot turn a large account into a false "unavailable". The
503 also covers a prompt the host refuses. The query length check now counts
code points like the schema validator. Left as noted minors: tag order in the
prompt is by codepoint, not locale; two tags differing only by case resolve to
the first, not the last; and the fixture's address variable is not validated
(it is a dev-only tool on a throwaway database).

## Tasks part 14 checkpoint (JS-108, Card 526)

List view now groups tasks by Critical, High, Medium, Low, Someday and No
priority, instead of by list. Empty priority groups stay hidden. Grid keeps
all four legacy headings: Do First, Schedule, Delegate and Later. Each group
sorts by due instant, undated tasks last, then title. Existing filters run first
and each row retains its list name. The editor now labels the endpoints of
the priority scale Critical and Someday. No data, SQL or host interface changes.
The package app map describes the actual grouping and ordering.

The package gate gains an exact comparison against the unchanged legacy
`groupByPriority` and `groupTasksByQuadrant` functions: ten comparisons over
96 synthetic tasks cover all priorities, mixed lists, absent dates, equal
instants, accented titles and both sides of the 48-hour urgency boundary.
The same comparison verifies that source task order and content stay unchanged.
Final database, endpoint, live UI and independent review receipts belong to
this task's proof artifact; a passing grouping check is not full screen parity.

Tooling uses the existing scratch Rust 1.95 toolchain, Wasm target and Cargo
cache, including the already approved pinned wit-bindgen graph. The tools
lockfile was refreshed offline before locked gates without changing its bytes.
Declared JavaScript dependencies were restored offline in this worktree.
No global tool, target or package was installed.

This remains an unfinished checkpoint. Finishing the entire remaining port
would exceed this continuation's context boundary. Both assistant-policy
routes need the public preferences seam. Actor timezone/lazy recurrence,
recurrence jobs, deferred-queue policy/worker integration, public People
linkage, policy/feedback orchestration, remaining screens/settings, installed
chat, real-shell integration and performance budgets remain. The endpoint
harness's native queue observer still cannot observe the module queue. A
signed-package fixture is separate from the real application shell; physical
second-device checks must be reported with their exact coverage in the proof.
Part of #4027; release note Category N/A. Workshop and Food are excluded.

## Tasks part 15 checkpoint (JS-114, Card 526)

The package screen now supports the legacy list selection rules: include lists,
show only one or more lists, or hide lists. The compact picker selects one list
or all lists; **Choose lists** exposes combinations and shows the current choice.
Tag filters can be combined and removed individually. A task matching any selected
tag remains visible. List counts follow status and tags, before list selection
and text search. **Clear filters** returns to open tasks across all lists and
clears tags and search. Existing List/Grid grouping and saved view remain intact.
The package manifest describes these controls and how to recover hidden tasks.

`tools/filter-parity.mjs` compares visible tasks, list counts, total count,
available tags and solo list ids with the unchanged legacy screen model over
800 combinations. These include every status, multiple solo/excluded lists,
an empty or stale list, multiple tags, missing tags, case-insensitive title
search, description search and subtasks. Source rows must remain unchanged.
The same comparison failed against the previous package model before the change
and passes afterward. This is screen-model parity, not full screen acceptance.

Review round one found a custom-selection default leaking into the New task list
picker. The default now resolves only actual list ids, falling back to the first
list. A DOM regression check covers multiple solo lists, exclusions, list-control
focus, combined tags, focus after removing a tag, counts and reset. Clear filters
is also available in the empty state. These checks do not substitute for the
signed-package browser check.

Final gate, browser and review receipts are recorded in this task's proof artifact.
The signed-package browser fixture exercises the real Rust host and account
boundary, separately from the application shell. At the start of this run the
MacBook was offline on the tailnet, so earlier second-device evidence is not
reused as proof of this work.

No route, chat tool, job kind, SQL migration or host interface changes in this
checkpoint. Both assistant-policy routes still need the public preferences seam.
Actor timezone/lazy recurrence, recurrence jobs, deferred-queue policy and installed
worker dispatch, public People linkage, policy/feedback orchestration, remaining
screen/settings parity, installed chat, real-shell integration and performance
budgets remain unfinished. The endpoint adapter's queue-observation gap remains.
Physical second-device HTTPS acceptance must be reported with its actual coverage,
not inferred from a local phone viewport. Full Phase 5 parity is not claimed.

Tooling uses existing Rust 1.95 and Wasm target caches, including the approved
pinned wit-bindgen graph. The tools lockfile was refreshed offline without a
byte change. Declared JavaScript dependencies were restored offline inside this
worktree. No global tool, target or package was installed. Part of #4027;
release note Category N/A. Workshop and Food are excluded.

## Tasks part 16 checkpoint (JS-117, Card 526)

New task now lets people prepare tags and editable, removable subtasks before
saving, as the legacy editor does. Tags are normalized to lowercase with one
leading hash removed; empty subtask drafts are dropped and the others keep their
order. A tag left in its input is included when Save task is clicked. Drafts stay
in the editor until saving and use the existing unsaved-changes protection.
The package app map describes this path and its retry instructions.

Save creates the parent, adds its ordered breakdown and assigns tags through the
existing public routes. A failed child write keeps the saved parent and receipts
for acknowledged child writes. Retry resumes pending work instead of creating
another parent or repeating those completed operations. The list and child drafts
stay locked during this recovery, while other parent fields remain editable.
A lost response after a server commit is still ambiguous; this client flow cannot
guarantee exactly-once writes without a server idempotency contract.

Validation includes retry tests for rejected parent creation, breakdown and tag
assignment, a draft-control DOM test, and twenty exact comparisons with the
unchanged legacy tag/subtask cleaning functions, including Unicode and duplicate
subtask titles. These checks are part of the package gate. They are separate from
live signed-package browser evidence and do not establish full screen parity.
Final gate, browser and review results are recorded in the task proof artifact.

The starting checkout was behind current main and was fast-forwarded with Ben's
approval. At the start, the part 15 PR was still open with CI running, despite the
continuation brief calling it merged. This slice avoids duplicating its filters.

This remains an unfinished checkpoint. Both assistant-policy routes need the
public preferences seam. Actor timezone/lazy recurrence, recurrence jobs,
deferred-queue policy and installed worker dispatch, public People linkage,
policy/feedback orchestration, remaining screen/settings parity, installed chat,
real-shell integration and performance acceptance remain. The endpoint adapter's
queue-observation gap remains. The signed fixture is separate from the real shell.
A physical second-device check must be reported with its actual coverage; the
MacBook was offline on the tailnet at the first check in this run.

Tooling reuses the existing scratch Rust 1.95 toolchain, Wasm target and Cargo
cache, including the approved pinned wit-bindgen graph. The tools lockfile was
refreshed offline without a byte change. Declared JavaScript dependencies were
restored offline in this worktree. No global tool, target or package was installed.
No route, chat tool, job kind, SQL migration or shared host crate changes.
Workshop and Food are excluded. Part of #4027; release note Category N/A.

Part 16 review round one found a major existing-tag recovery trap: creating a
name already in the list failed after the parent had been saved and the draft
locked. Matching tags are now reused through the public list route; a rejected
creation rechecks that route to handle a concurrent creator. The same pass fixed
stale list data after abandoning a partial save and focus landing on a locked
tag input. A controller regression runs against the actual rendered shared-kit
HTML, with a mocked bridge, and checks partial save, discard, list refresh and
the next independent New task. Verification also caught a second normalization
stripping a literal leading hash; committed draft names are now preserved.

The initial full endpoint run matched 84 of 86 cases. The deferred-status request
fails in the adapter's unbound jobs path, and the actor-timezone end-of-day at-risk
case differs from UTC. These are remaining port gaps, not passing comparisons.
The optional signed UI capture check asserts one parent, the exact three tags,
ordered subtasks and the absence of a removed draft tag in the real database.
Final independent review and gate receipts belong to the proof artifact.

Part 16 review round two found no major or blocker on the capture changes. A
minor remains: retrying a completed, repeating task after a partial save resends
status and recurrence, which can apply completion effects on that retry.
The final signed-browser run created one parent with both ordered subtasks and
the exact three expected tags, then confirmed them after reload. Its database
assertion exposed a proof-check ordering assumption: PostgreSQL collation put
`kept` before `#literal`. The capture assertion now sorts names in JavaScript
before comparison; the stored values and product code are unchanged.

Part 15 subsequently merged and was merged into this task branch with Ben’s
approval. Both filter and capture assets, tests, app-map descriptions and report
sections are retained. Final review and gate receipts cover their combined state.

## Tasks part 17 checkpoint (JS-121, Card 526)

The package screen now exposes the existing Rust natural-language search route.
Type a phrase, choose Interpret search or press Enter, and remove individual
conditions afterward. Status uses the normal picker. Interpreted tags require
all named tags; manual tag selections retain their any-tag behaviour. List counts
remain before search. Typing resets the interpretation; Clear filters restores
open tasks and clears all search, list and tag choices. Provider failures retain
the phrase and explain that title/description search still works. The package
app map describes these controls and recovery steps.

The unchanged legacy screen model is the oracle for 1,380 interpreted-filter
comparisons, including all due kinds, status, effort, priority, quadrant, lists,
case-insensitive interpreted tags, manual tags and literal residual text. That
comparison was observed failing against the previous package model and passing
after this change. Source rows are checked unchanged. Controller tests cover
warnings, chip removal, keyboard activation, reset and provider failure; another
test runs the controller against the real shared-kit HTML with a mocked bridge.
These are UTC screen-model checks, not actor-local date acceptance or live AI
provider evidence.

A targeted compiled-component database check uses a synthetic provider to capture
the search vocabulary. It checks that another account and an instance admin see
no private list/tag names in the prompt and cannot retain foreign list/tag filters
in the answer. The identical assertion is required to fail with list/tag RLS
removed and pass after restoration. Its removal probes are restricted to its
synthetic list, keeping earlier fixtures out of the guest fuel budget.

No route, tool, job kind, SQL migration or shared host crate changes. Both
assistant-policy routes, actor timezone/lazy recurrence, recurrence jobs,
deferred-queue policy and installed worker dispatch, public People linkage,
policy/feedback, remaining screens/settings, installed chat, real-shell integration
and performance acceptance remain unfinished. The endpoint harness still lacks
an observer for the module queue. Finishing those gaps exceeds this continuation's
single-context boundary; this is an unfinished checkpoint, not Phase 5 acceptance.
Workshop and Food remain excluded. Part of #4027; release note Category N/A.

Tooling reuses the existing Rust 1.95 and Wasm target in scratch and the existing
Cargo registry caches. The old temporary cache link was dangling, so an existing scratch
cache supplies the guest and encoder while the standard existing cache supplies
the native host checks, all offline. The tools lockfile was refreshed offline for
main's added libc dependency in the shared safety crate. Declared JavaScript
dependencies were restored offline in this worktree. The approved pinned
wit-bindgen graph was reused; nothing was installed globally.

The full endpoint run matches 84 of 86 cases. Deferred-status fails because the
adapter has no bound jobs path, and the actor-timezone end-of-day at-risk case
differs from UTC. These remain failed comparisons. The new screen-model check
passes all 1,380 comparisons; another 91 comparisons extract unchanged legacy
page helper declarations to check status handoff, structured-filter detection,
chip labels and individual removal. All seventeen screen/controller tests pass
against the rebuilt shared-kit markup.

Independent review round one found a major gap in the privacy removal control:
an unrelated panic could count as the expected failure. The control now requires
the exact private-list-name assertion, after restoring RLS. The same pass clarified
manual versus interpreted tags, named the filter group for assistive technology,
disabled interpretation for empty input and added the legacy helper comparisons.
Final gate, signed UI and review receipts are recorded in the proof artifact.
The signed fixture is separate from the real application shell and has no live
AI provider; its unavailable-provider path does not prove successful provider
composition. The MacBook was offline during this run; no physical second-device
HTTPS acceptance is claimed.

The refreshed signed-package HTTPS gate passed after a browser-created owner,
Inbox list and persisted task. Browser checks exercised the real unavailable-provider
message, description search recovery, Clear filters, disabled empty interpretation
and task persistence after reload. Desktop and narrow-viewport screenshots are in
the proof artifact; the narrow viewport is not second-device evidence.

## Tasks part 18 checkpoint (JS-125, Card 526)

New task now offers the chosen list's existing tags, excluding selected names and
showing at most eight, as the legacy editor does. Switching lists refreshes the
choices without discarding the draft. A failed tag read has an inline retry;
people can still type tags. Selecting a stored tag preserves a literal leading
hash. Existing task details reuses typed matching tags case-insensitively and
rechecks the public list route after a rejected create to recover concurrent
creation. The module app map describes these paths and recovery.

Partial new-task saves now compare parent fields with acknowledged input.
Retrying pending tags or subtasks sends only changed parent fields, instead of
replaying completion and an old recurrence schedule after the server has advanced
it. The same regression failed before this change and passes afterward. Lost
responses after a server commit remain ambiguous without server idempotency.

The worktree began at Phase 0a and was fast-forwarded to current main with Ben's
explicit approval. Changes stay in Tasks and this report. Existing scratch Rust
1.95, Wasm target and Cargo caches are reused offline, including the approved
pinned wit-bindgen graph. The tools lockfile was refreshed offline without a
byte change. Declared JavaScript dependencies were restored offline in this
worktree. Nothing was installed globally. Workshop and Food remain excluded.
Part of #4027; release note Category N/A.

Both assistant-policy routes, actor timezone and lazy recurrence, recurrence
jobs, deferred-queue policy and installed worker dispatch, public People linkage,
policy/feedback, remaining screens/settings, installed chat, real-shell integration
and performance acceptance remain unfinished. The full endpoint harness still
has an unbound queue adapter and no observer for the module queue. Full Phase 5
parity is not claimed. The signed UI fixture is separate from the real application
shell; a narrow viewport does not establish physical second-device acceptance.
Final checks, independent review and live evidence are recorded in the task proof.

The new controller scenario fails against the previous controller and passes
against this checkpoint's real shared-kit markup with a mocked parent bridge.
All 23 screen/controller tests pass. Twenty-four exact comparisons extract the
unchanged legacy editor's tag-suggestion expression, alongside twenty existing
draft-cleaning comparisons. Targeted lint and Rust formatting checks pass.
These controller checks do not replace signed-package browser or database proof.

Independent review round one found no major or blocker issues. Both minor
findings were addressed: the first save's default UTC day is retained during a
partial-save retry even across midnight, and a failed conflict recheck preserves
the original tag-creation error. All 24 screen/controller tests pass afterward,
including default-day reset for a separate capture and failed parent-edit retry.
The optional signed-UI suggestion check verifies exact persisted assigned tags,
retention of a literal leading hash and absence of duplicate list tags.

## Tasks part 19 checkpoint (JS-128, Card 526)

The package screen now includes the legacy title-only quick capture bar. Enter or
Add task sends only the trimmed title and, when exactly one list is set to Show
only, that list. Otherwise the existing route uses or creates Personal. Details
carries the title into an unsaved editor, using the sole Show only list or the
first list. The list defaults are compared with the unchanged legacy page's JSX
expressions across all nine two-list selection combinations. This also corrects
Details choosing the first list when a sole Show only list is combined with an
excluded list.

Blank capture is disabled. Repeated activation is admitted once. A rejected
create retains the title and an inline retry message. An acknowledged create
followed by a failed refresh changes the action to Refresh saved task; retrying
only reads the list, without resending the create. A lost create response remains
ambiguous without server idempotency. The new real-markup controller regression
was observed failing against the previous controller and passing afterward. Its
bridge is mocked, so it is not live installation evidence. The app map, package
asset inventory and change notes describe the capture and recovery paths.

The branch began at Phase 0a and was fast-forwarded to current origin/main with
explicit approval. Work stays in Tasks and this report. The existing scratch
Rust 1.95 toolchain, Wasm target and Cargo caches are reused offline, including
the previously approved pinned wit-bindgen graph. The tools lockfile was
refreshed offline with no byte change. Declared JavaScript dependencies were
restored offline in this worktree; nothing was installed globally. Workshop and
Food remain excluded. Part of #4027; release note Category N/A.

Both assistant-policy routes still need the core preferences contract. Actor
timezone/lazy recurrence, recurrence jobs, deferred-queue policy and installed
worker dispatch, public People linkage, policy/feedback, remaining screens and
settings, installed chat, real-shell integration and performance acceptance
remain unfinished. The existing full endpoint harness still has an unbound
queue adapter. No new route, tool, job kind, migration or shared host interface is
introduced in this checkpoint. Full Phase 5 parity is not claimed. The signed UI
fixture remains separate from the real application shell; a narrow viewport is
not physical second-device acceptance. Final gate, browser and independent review
receipts belong to the task proof artifact.

## Tasks part 20 checkpoint (JS-133, Card 526)

Task details now loads activity independently of tags and subtasks. A failed read
leaves those controls reachable, offers Retry activity, and keeps any loaded
comments. An empty history is shown only after a successful empty read. Changing
tasks clears the previous history. Enter posts a trimmed nonblank comment;
Shift+Enter keeps a new line. Failed posts retain the draft and explain recovery.
After an acknowledged post the draft clears; a failed refresh retries only the
read, without repeating the post. Rendered comments preserve line breaks. The
module app map and package asset inventory cover the new controller and recovery.

The controller regression runs against actual shared-kit HTML with a mocked
bridge. It failed against the previous controller because an activity read
failure hid every detail extra, then passed after this change. All 26 existing
and new screen/controller tests pass. The signed UI gate has an optional exact
persistence check for one multiline keyboard comment and one button-posted
comment; final gate, live browser and independent review receipts are in the
proof artifact. Mocked failure/retry checks are not live network-failure proof.

This branch started at Phase 0a and was fast-forwarded to current main, including
part 19, before editing. Existing scratch Rust 1.95, Wasm target and Cargo caches
are reused offline, including the approved pinned wit-bindgen graph. The tools
lockfile was refreshed offline without a byte change; declared JavaScript
dependencies were restored offline. No global tool or package was installed.
No route, tool, job kind, migration or shared host contract changes. Workshop
and Food remain excluded. Part of #4027; release note Category N/A.

Both assistant-policy routes still need the core preferences contract. Actor
timezone/lazy recurrence, recurrence jobs, deferred-queue policy and installed
worker dispatch, public People linkage, policy/feedback, remaining screens and
settings, installed chat, real-shell integration and performance acceptance
remain unfinished. The full endpoint adapter still lacks a bound queue path.
Full Phase 5 parity is not claimed. The signed fixture is separate from the real
application shell; a narrow viewport is not physical second-device proof.

## Tasks part 21 checkpoint (JS-137, Card 526)

The two existing `agency-auto-execute` API routes now run in the compiled Tasks
package. They retain the account's canonical policy and legacy boolean in the
existing preference rows. Canonical values always win, legacy opt-outs prevent
the initial grant, and writes update both keys together. `always_confirm` remains
stored and reads as disabled through the older boolean API. HTTP validation keeps
the existing coercions and removes undeclared body fields.

Focus, at-risk and overdue reads now use the account's persisted timezone.
Bounded summaries use that timezone for selection, due labels and reported local
date. Missing or invalid timezone preferences retain `America/Los_Angeles`.
Calendar offsets use consecutive local midnights, including twenty-three- and
twenty-five-hour days. These reads still use persisted occurrences; they do not
advance recurring series.

Ben approved two narrow shared host contracts for this checkpoint. The separate
host commit adds declared policy families and account-local dates inside the
existing invocation transaction. Policy keys come from the installed module ID
and declared family, with an optional legacy suffix under that same module ID.
Neither contract accepts an actor or an arbitrary preference key. Account RLS,
module capability checks, invocation rollback and deadlines remain in the path.
Install and upgrade permission metadata includes the policy declarations. Existing
one-use tool approval is unchanged. No sibling module, SQL migration, ownership
ledger or stored task schema is changed.

Host checks exercise actual Wasm imports and disposable PostgreSQL: policy
precedence, dual writes, legacy opt-out, trapped-call rollback, invalid and forged
requests, account privacy removal/restoration controls, and spring/fall DST
boundaries. The compiled Tasks route test checks the exact legacy keys and
account choices, including another member and an admin. Its policy-read privacy
assertion is required to fail with preference RLS removed and pass after it is
restored. The existing task read/write removal controls remain in the package gate.
Endpoint cases add policy defaults, legacy opt-out, canonical precedence,
independent accounts, HTTP coercions, rejected bodies and sign-in requirements.
The drift/summary differential expands from UTC to four account timezones;
retrieval timestamps alone are normalized, not local dates.

Existing scratch Rust 1.95, Wasm target and Cargo caches were reused offline,
including the pinned wit-bindgen graph approved on 2026-11-08. The tools lockfile
was refreshed offline without a byte change. Declared JavaScript dependencies
were restored offline in this worktree. Nothing was installed globally. Workshop
and Food remain excluded. Part of #4027; release note Category N/A.

This is a bounded checkpoint under the continuation's context limit, not full
Phase 5 acceptance. Remaining: lazy recurrence advancement; recurrence jobs;
full deferred-queue policy and installed worker dispatch; public People linkage;
policy/feedback orchestration; remaining screens/settings, including the policy
switch; interpreted-search and date-editor timezone support; installed chat and
summary presentation; real application shell integration; performance budgets;
and physical second-device HTTPS proof. The full endpoint adapter still lacks a
bound queue path and an observer for the module queue. The signed UI fixture uses
the real install, TLS and sign-in paths but is separate from the real application
shell. A narrow viewport does not establish physical second-device proof.

The full endpoint differential run finished with **92 of 93 cases matching**
(the unchanged historical suite plus seven new policy cases). All seven policy
cases pass. The prior drift-day mismatch is resolved; the remaining failure is
`smoke: deferred status job marks the task done`, where the disposable component
adapter still has no queue binding and returns an error. It is retained as a
failure, not excluded or counted as passing. The host account-contract gate
passes both tests, including preservation of a valid lowercase saved timezone.
The signed fixture passed certificate verification, sign-in redirect, rejected
untrusted host/origin checks, owner setup and a browser-created task persisted
exactly once. Its browser and server were stopped afterward. This proves the
fixture's installed package path, not the application shell or a second device.
Final package/static gates and independent review receipts are in the task proof.

The expanded differential first failed on the casing of a saved `asia/tokyo`
zone: the package gate reused an older `tasks-tool-parity` executable. The gate
now builds that executable explicitly alongside the screen adapter, so an empty
or stale target directory cannot silently select old host behavior. The failing
run and fresh-build rerun are retained in the task proof.

Independent review found no blocker or major issue in this checkpoint. Its
namespace-test explanation was corrected: module identifiers forbid underscores,
which prevents legacy aliases from entering the reserved canonical policy prefix.
Two minor limits remain documented: policy preference writes are capability-gated
but not restricted by guest entry kind, and summary rendering makes up to thirteen
account-date calls. Before stored route tiers can drive registry-module approvals,
write entry points and permission headlines need tightening. Current one-use tool
approval does not read these preference routes. Summary performance remains
unproven; the future optimization is to batch date conversions. These limits do
not establish full Phase 5 parity or physical second-device acceptance.

## Tasks part 22 checkpoint (JS-141, Card 526)

The disposable component endpoint adapter now binds the existing deferred-status
route to the real Rust queue. A separate worker claims the typed metadata and
invokes the actual Tasks Wasm handler under the captured account and the worker
database role. Queue declarations validate the parameters; the adapter checks
the manifest identity before dispatch. The adapter stops if its worker dies.
The historical endpoint harness remains unchanged. Its existing observation
table receives the real queue's terminal state and the successful handler result
only after the queue is finished; failed jobs record a generic error instead of
private error details. That table never executes these jobs.
This is a differential test adapter, not the installed module worker.

The unchanged deferred-status smoke case was reproduced failing before the
binding: Rust returned 500 and left the task open while TypeScript returned 202
and completed it. Three added differential cases check private tasks and forged
actor input, archive/reopen with a repeated legacy request key, and repeated
recurring completion. They compare job output and saved Tasks and activity rows,
assert exactly two occurrences after repeated completion, and preserve the legacy
refusal of children on recurring tasks. The old endpoint cases are retained
without exclusions.

The first complete comparison run passed 94 of 96 checks. Both servers rejected
two invalid new fixtures: priority must be numeric, and the existing SQL hierarchy
rule forbids a recurring task from being a parent. The fixtures now use a numeric
priority and assert the existing child refusal instead of expecting creation.
Shared-host load also exceeded the harness's normal startup allowance. A scratch
copy extends only that allowance from 90 to 600 seconds; case assertions and
the other harness sources remain unchanged. This does not prove the normal
startup or performance budget. Final rerun receipts are in the proof artifact.

The compiled deferred-worker privacy test now uses the real worker database
role for task effects instead of the app role. It still requires the exact
cross-account mutation assertion to fail with Tasks RLS removed and pass with
RLS restored. The broader package gate retains its read and write privacy
removal controls. The app map corrects broad unfinished-policy and timezone
wording: the saved policy API and account-local drift reads already exist;
automatic assistant actions and date-editor timezone support remain unfinished.

The clean task branch was updated from its Phase 0a starting point to current
remote main before editing. Existing scratch Rust 1.95, Wasm target and Cargo
registry caches were reused offline, including the pinned wit-bindgen graph
approved on 2026-11-08. No generator, global tool or new dependency was installed.
The tools lockfile was refreshed offline with no byte change. Declared JavaScript
dependencies were restored offline. No product route, job kind, SQL migration,
shared host contract or sibling module was changed. Workshop and Food remain
excluded. Part of #4027; release note Category N/A.

This is a bounded parity checkpoint, not full Phase 5 acceptance. Remaining:
lazy recurrence advancement; recurrence jobs; legacy deferred-queue retry and
retention policy, optional request-key retention and installed worker dispatch;
public People linkage; policy/feedback orchestration; remaining screens and
settings, including the policy switch; interpreted-search and date-editor
timezone support; installed chat and summary presentation; real application
shell integration; performance budgets; and physical second-device HTTPS proof.
The signed UI fixture exercises real installation, TLS and sign-in but remains
separate from the application shell. No attached physical device was available
through the existing device bridge; online network peers alone are not UI proof.
Final gate, browser and independent-review receipts are recorded in the task
proof artifact.

## Tasks part 23 checkpoint (JS-148, Card 526)

**Task settings** now opens inside the installed package screen. It reads and
saves the existing account-level assistant task-change preference through the
public bridge and the compiled policy routes. No new API, table, job or host
contract is introduced. The existing canonical-policy precedence and legacy
opt-out rules remain in the backend. The app map points to the implemented
Tasks screen, rather than claiming a separate settings-shell route.

The switch is unavailable until a saved value loads. A failed initial load
explains that the saved choice is unavailable; a failed refresh or save keeps
the last confirmed value. Retry loading only reads. A successful save adopts
the server response without refreshing or hiding tasks. Pending saves disable
the switch. The screen explicitly says this stores the preference and that
installed chat actions still ask for approval while automatic-action integration
is unfinished. The setting does not claim to enable automatic execution today.

The new controller regression uses actual shared-kit screen markup with a
mocked bridge. It checks independent initial-load failure, retry, persisted
true/false choices, failed-save rollback, duplicate-save prevention, failed
refresh recovery and a changed value from another session. These are controller
checks, not proof of live network failures. Real installed UI and gate receipts
are recorded separately in the task proof artifact.

This worktree was clean at Phase 0a. After explicit approval it was fast-forwarded
to remote main, including part 22, before implementation. Existing scratch Rust
1.95, Wasm target and Cargo caches were reused offline, including the pinned
wit-bindgen graph approved on 2026-11-08. The tools lockfile was refreshed offline
without a byte change. Declared JavaScript dependencies were restored offline.
No global tool, generator, target or new dependency was installed. Workshop and
Food remain excluded. Part of #4027; release note Category N/A.

This remains a bounded checkpoint, not full Phase 5 acceptance. Remaining:
lazy recurrence advancement; recurrence jobs; legacy deferred-queue retry and
retention policy, optional request-key retention and installed worker dispatch;
public People linkage; policy enforcement and feedback orchestration; remaining
screen/settings parity and integration into the settings shell; interpreted-search
and date-editor timezone support; installed chat and summary presentation;
real application shell integration; performance budgets; and physical second-device
HTTPS proof. The signed fixture exercises installation, TLS and sign-in but
remains separate from the application shell. No physical device was attached to
the existing device bridge during this work; a narrow viewport is not evidence
of second-device access.
