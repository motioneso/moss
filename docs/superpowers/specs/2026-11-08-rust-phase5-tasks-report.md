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

### Tasks part 4: exact remaining work

This PR is the partial component checkpoint, Part of #4027, with release note
Category N/A. Ready applies to merging this bounded slice, not to a completed
Tasks replacement. The user approved pushing and opening this PR after the
checkpoint was saved. Merge remains the person's decision. Workshop and Food
remain excluded.

1. **Finish HTTP behavior.** `packages/tasks/src/manifest.ts` declares 27 legacy
   routes; `modules/tasks/moss.module.json` and `src/routes.rs` implement 18 after
   normalizing `/api` and parameter-name spelling. Add these nine endpoints
   under the module host's route prefix:

   | Method | Legacy path                      | Required behavior                               |
   | ------ | -------------------------------- | ----------------------------------------------- |
   | POST   | `/api/tasks/search/interpret`    | Structured search interpretation                |
   | POST   | `/api/tasks/:id/deferred-status` | Actor-scoped deferred status job                |
   | DELETE | `/api/tasks/lists/:listId`       | Existing list deletion/reassignment rules       |
   | POST   | `/api/tasks/:id/breakdown`       | Existing task breakdown and suggestion behavior |
   | GET    | `/api/tasks/focus`               | Focus selection                                 |
   | GET    | `/api/tasks/at-risk`             | At-risk/drift view                              |
   | GET    | `/api/tasks/overdue`             | Overdue view                                    |
   | GET    | `/api/tasks/agency-auto-execute` | Read assistant-action preferences               |
   | PATCH  | `/api/tasks/agency-auto-execute` | Save assistant-action preferences               |

   The 18 existing routes still need full request/response schema, validation,
   filter and error parity. In particular, the list route currently implements
   quadrant and tag filtering; port `listId`, status, priority, due bounds and
   `completedAfter` too. Preserve suggestion/triage feedback on mutations and
   legacy duplicate-name conflict responses, including the concurrent rename
   case already recorded above. Do not interpret route presence as endpoint
   parity. Keep all six existing tables and nine original migrations unchanged.

2. **Complete calendar orchestration.** Obtain actor timezone/preferences through
   a public core contract. Offset-free timestamps currently use UTC; restore
   legacy parsing/local-day behavior, free-text dates and exceptional interval
   handling before claiming parity. Port lazy roll-forward for reads and drift
   views, account-scoped schedule reconciliation and recurrence worker behavior
   from `recurrence.ts`, `drift.ts`, `jobs.ts` and `recurrence-schedule.ts`. The
   existing daily trigger is `0 3 * * *` in UTC, keyed per actor; the worker uses
   that actor's local day. Preserve schedule failure isolation and idempotency.
   Next-occurrence creation on completion is already present and tested.

3. **Port all assistant tools and policies.** No tools are declared or handled by
   this Rust package yet. Match the 23 current tool names and schemas in the
   legacy manifest and summary tool:
   `tasks.summary`, `tasks.list`, `tasks.heartbeatWindow`, `tasks.get`,
   `tasks.focus`, `tasks.atRisk`, `tasks.overdue`, `tasks.listLists`,
   `tasks.listTags`, `tasks.activity`, `tasks.create`, `tasks.update`,
   `tasks.updateStatus`, `tasks.breakDown`, `tasks.addActivity`, `tasks.assignTag`,
   `tasks.unassignTag`, `tasks.createList`, `tasks.renameList`, `tasks.createTag`,
   `tasks.renameTag`, `tasks.deleteList`, `tasks.deleteTag`. Preserve approval
   policy, action presentation, chat targets and structured visual summaries.
   Port the Tasks heartbeat/monitor and suggestion/feedback behavior through
   public host services; background reads must not advance recurrence.

4. **Port both job kinds.** Declare and consume `tasks-deferred-status` and
   `tasks-recurrence-materialize` with metadata-only typed payloads, captured
   actor context, idempotency and existing queue retention/retry behavior.
   Deferred status carries task/status metadata; recurrence carries actor and
   optional idempotency metadata, never task text. Reuse the jobs host contract;
   do not embed a separate scheduler in the guest.

5. **Use public People/core interfaces.** Add the required People linkage and
   public module API surfaces without reading People tables or implementation
   code. This checkpoint accesses only Tasks tables and has no People calls.
   Add declared host capabilities and public API tests as each call is ported.

6. **Package the real screens and install path.** Build the Tasks list/grid,
   list picker, editing/subtasks, tags, activity and action-policy settings on
   the shared UI kit and frame bridge. Preserve phone behavior, completion and
   recurrence interactions, loading/error states and chat affordances. Wire the
   installed package into the authenticated Rust shell and add truthful
   navigation/settings/features and error remediations to its app-map metadata.
   Finish dependency attribution in NOTICE, sign the actual archive and prove
   registry selection/download and installation; the current archive is unsigned
   format evidence only. No Tasks screen or navigation entry is shipped here.

7. **Close the acceptance evidence.** Adapt `rust-spike/parity/` to the actual
   component/host rather than the old Phase 0b native server and run endpoint,
   tool and job comparisons. Keep the failing-first privacy controls; expand
   cross-account/admin cases to newly added surfaces, and measure large-account
   tag/query and message-size limits. Exercise the real installed Tasks UI on a
   running Rust instance with sign-in, HTTPS and trusted origins, then from an
   actual second device over LAN or tailnet. Use a claimed dev port. Capture
   real UI screenshots and record any remaining failures; none of those live
   checks has been performed for Tasks in this checkpoint.

The component build, manifest and database tests are reproducible from
`modules/tasks/README.md`. Keep the existing approved generator pins and the
WASI-free build. Full parity, signed installation and live remote UI proof remain
acceptance gates for the continuation, not claims made by this partial PR.

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
