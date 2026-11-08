# Additive package-builder interfaces

This checkpoint adds opt-in interfaces to the Phase 4b host. Existing
`Application::open`, `dispatch`, database operations and package handlers remain
available. It does not connect module screens to the authenticated Moss shell.

## Assembly

`Application::open_extended` enables typed queries and the context port.
`open_extended_with(..., adapter)` additionally accepts a host-owned
`FnOnce(Arc<dyn Ports>) -> anyhow::Result<Arc<dyn Ports>>`. The adapter forwards
unknown operations and `finish_call` to the supplied ports. No guest chooses an
adapter, database connection, actor or filesystem root.

The stack is `TransactionalDatabasePorts → ContextPorts → adapter → existing
ServicePorts → JobPorts → DatabasePorts → LocalPorts`.

Each invocation has a fresh `CallScope::call_id()` independent of request IDs.
The runtime calls `finish_call(scope, success)` once after the guest finishes.
Guest errors, traps, invalid output and route responses with a numeric status of
at least 400 finalize unsuccessfully. The default trait method is a no-op for
existing adapters. Typed database transactions commit before downstream success
finalization, or roll back before downstream failure finalization. This permits
file compensation; it is **not** a distributed database/filesystem transaction.
An adapter must handle compensation conflicts without overwriting another edit.

## Guest contracts

`moss-module-sdk` is a pure Rust crate. Implement its `Host::call(port, operation,
resource, serde_json::Value) -> Result<Value>` at the component ABI boundary.
`Client::api(module, name, parameters)` sends `{name, parameters}` to the existing
public API dispatcher. `Client::query(table, &Query)` sends `db/query`.
This checkpoint supplies contracts, not a generated Rust component ABI binding.

The optional SDK `component` feature now supplies a handwritten canonical ABI and
`export_module!` macro for compiled Rust guests. `guest_component::wrap` and the
`wrap_guest` build example lift a Rust `wasm32-unknown-unknown` core into the same
Moss string/result component interface. They reject imports outside Moss ports and
the shared memory, and validate the completed component. This path uses the existing
Wasmtime/WAT dependencies; it adds no generator, WASI adapter or native module driver.
It does not fulfill the package spec's `wasm32-wasip2` shipping-build requirement.

An additional build-time `guest_component::wrap_generated` entry accepts the canonical
exports emitted by the approved `wit-bindgen` generator. The `wrap_generated_guest` example
and People build script compile a `wasm32-wasip2` core with `--skip-wit-component` and shared
memory, then assemble the existing Moss component interface. Standard-library WASI function
imports become internal trap-only functions; invoking one fails, rather than reaching a host
service. Foreign non-Moss/non-WASI imports remain rejected. The runtime's import validator
and linker are unchanged. This path provides generated allocation/result ownership without
granting WASI authority, and leaves the handwritten assembly available.

Typed queries allow select/insert/update/delete, explicit nested filters, ordering,
paging and insert conflict-ignore. They accept checked identifiers and bound JSON
values, never SQL. Mutations reject a bare `Filter::All`; nested tautologies and broad account filters
are permitted. This is a guard against an omitted filter, not proof of a narrow write. The host supplies insert
ownership and UUID IDs where those columns exist. Composite keys and owner-only
preference keys work without an artificial ID. Database grants and forced RLS
remain the privacy boundary. Select queries are bounded to a thousand returned rows; large reads require paging.
Update/delete return all affected rows and have no row-count cap. SQL errors poison the whole invocation even if the
guest catches them. Legacy database operations retain their existing transaction
behavior; do not mix them into an atomic typed-query operation.

The additive `lower-eq` comparison applies PostgreSQL `lower(column::text)` and compares it
with the bound text parameter exactly. The caller normalizes the parameter; `%` and `_`
are literal characters rather than patterns. Ordering accepts `nullsFirst`, defaulting to
false to preserve existing queries. People opts into true for legacy descending link dates.

The opt-in wrapper uses additive `DataContext::open_bounded` and `commit_bounded`
helpers. Pool acquisition, context initialization, queries and completion share
the invocation's remaining deadline. The connection-discard guard is established
before `BEGIN`; canceled initialization or commit cannot recycle an unfinished
transaction. The existing unbounded constructors remain unchanged. The gate covers a saturated
pool and subsequent account isolation; cancellation during BEGIN/COMMIT is not
directly exercised. Failed invocations discard their connection even after a
successful rollback, which can create connection churn.

Jobs, events and public API calls are outside the typed-query transaction; rollback
does not undo those side effects. Nested public calls use separate connections
(up to eight levels) and can wait on outer-call row locks until their deadline.
Keep such effects outside an operation that needs database-only atomicity.

Declare the context capability before calling `context/read/call {}` for
`{actorUserId, now}` or `context/uuid/new {}` for `{id}`. These values are supplied
by the host. Context parameters must be empty.

`dispatch_extended` accepts template routes such as `/tasks/:id` and query
strings. The guest receives SDK `RouteRequest`: method, declared path, decoded
params, query and body. Repeated query values become arrays. Literal routes win;
ambiguous templates and unsafe decoded segments fail. The original dispatcher
still performs literal matching with its original envelope.

## Frames

After authentication call `Installer::screen(access, module, declared_path)`.
It checks account enablement, active package integrity and the declared screen.
Use the returned URL and `sandbox` value, which permits scripts without same-origin
privileges. `ui_asset(module, digest, path, policy)` returns public static package
code only, plus headers that the server must apply. It does not return account data.
Create `AssetPolicy` from the configured trusted origin, never a request header.

Serve the generated shared stylesheet/fonts at `/module-shared/` with opaque-frame
CORS and no credentials. Install the bridge in `../module-ui/web/host-bridge.mjs`
in the signed-in parent. It binds messages to one opaque frame, restricts requests
to that module's routes and uses transferred message ports for private replies.
The parent owns authenticated HTTP, CSRF checks, navigation, theme and chat.
The bridge itself does not establish a session or supply those server protections.

## Checks

Run native host tests and clippy, SDK tests, shared UI SSR/CSR checks and Node
bridge tests. Database tests run only through verify-gate:

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate rust-spike/module-host/tools/transaction-gate.sh
scripts/run-gate.sh wait --follow
```

`examples/frame_check.rs` is a browser fixture using a real signed sample package,
Wasmtime and account-scoped KV. Use a claimed dev port and generated shared assets.
Its temporary account has no sign-in or private data. It is not Tasks parity,
authenticated Moss UI, HTTPS, LAN or second-device proof.

## Current integration limits

Attach the bridge before assigning the verified frame URL. The guest creates
`moduleClient` during initial startup and transfers a command port. Later
documents cannot replace that port, even before their load event. If bootstrap
is missing at the first load, or on any later load, the bridge is revoked.
Do not automatically reconnect it.
Screen entries outside `ui/` are rejected by asset serving, but screen lookup does
not yet fail early, so such a malformed screen can appear blank. Literal routes
use raw spelling while parameterized routes decode segments: `/tasks/tod%61y`
can resolve to `/tasks/:id` rather than `/tasks/today`. Callers should use canonical
unencoded literal paths until this opt-in dispatch seam is normalized.
