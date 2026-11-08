# Rust Phase 5 Tasks — implementation checkpoints

Current status: JS-53, Card 526 adds a real component and basic routes on the
merged data foundation. **The full Tasks port is unfinished and is not Ready.**
The final section records this continuation and its remaining work. Earlier
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
The manifest declares basic task create/read/update, subtask reads, list
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
Repository static validation is run separately; its final result belongs in the
proof rather than being inferred from the narrower checks.

### Independent review and limits

Round one reviewed commit `e5aa4cffc` read-only. Its major finding was the priority
boundary above; a failing-first compiled query regression reproduces it. The
review also requested query-string and failed-mutation rollback coverage; both
are now exercised. The build now isolates the encoder in `bindings/` so producing
the component does not compile the host verification toolchain. Round two must
review the final committed checkpoint; its result is recorded on that commit.

Remaining minor review limits: task/tag response assembly performs per-task tag
queries and has no large-account runtime/message-size measurement. Manifest error
identifiers are descriptive app-map metadata, while wire errors retain plain
source-compatible messages. Dependency attribution in the packaged NOTICE still
needs to be completed before publication. This unfinished unsigned package must
not be published or presented as the production replacement. These limits remain
visible rather than being counted as parity proof.

Not proven and still required before the full task can be Ready:

- Complete route schemas and errors, list deletion/reassignment, focus, drift,
  search, agency preferences, deferred status, and the remaining source endpoints.
- Actor timezone/preferences through a public core contract. ISO timestamps with
  no offset currently use UTC rather than the legacy process-local timezone;
  lazy recurrence roll-forward is deliberately absent rather than advancing a
  still-due task on the wrong local day. JavaScript legacy free-text dates and
  exceptional date/interval ranges are also outside this checkpoint's claims.
- Exact chat tools, suggestion and feedback behavior, public APIs, typed job
  kinds, scheduling and recurrence orchestration. People must remain behind its
  declared public interface; no People tables or internals were accessed.
- Full endpoint parity through `rust-spike/parity/` against this component. The
  existing runner still launches the Phase 0b native Tasks server, so running it
  unchanged would not prove this port.
- Signed installation and registry selection/download of this actual package.
- Packaged Tasks screens using the shared UI kit and frame bridge, authenticated
  Rust shell integration, HTTPS/trusted-origin behavior and a real second-device
  UI check. The present shell does not yet wire installed module frames/routes.
- A single final PR, Part of #4027, release note Category N/A, plus independent
  review and the live proof recipe before full acceptance. No push or merge is
  authorized in this task run. Workshop and Food remain excluded.
