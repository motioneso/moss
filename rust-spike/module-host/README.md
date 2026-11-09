# Rust module host

Phase 4b is an isolated library under `rust-spike/module-host/`. It supplies the package,
registry, Wasmtime and lifecycle services for the Rust application. It adds no registry screens
and does not replace the running Docker app. The implementation and proof limits are recorded
in `docs/superpowers/specs/2026-11-08-rust-phase4b-report.md`.

The sample in `sample/module.wat` is a real WebAssembly component. Tests build a deterministic
`.mosspkg`, sign it with fresh test keys, publish a signed registry and install it through the
real host. No production signing keys or pretrusted registry address ship with this library.

## Joining the application

`Application::open` connects the existing account database, typed database port, Phase 2b queue,
service ports, installer and Wasmtime host. The authenticated server supplies an `AccessContext`
and calls `dispatch` for declared `/api/m/<module>/...` routes. Workers call `Installer::run_job`.
Public API calls use the separate `api` handler kind with a host-built `{name, parameters}`
envelope. Only names in the provider's `provides` declaration can be called; caller arguments
stay inside `parameters` and never select a route handler.
Both interfaces are synchronous: call them on a bounded blocking executor, never directly from
an async request task. The application supplies its trusted keys, secret cipher, AI router and
optional compiled-cache key. The queue and module-host schema constants must be applied by the
application's migration bootstrap first. `Configuration::migrations` is the trusted bootstrap
connection: it must be able to administer module roles and read the forced-RLS catalog (the
current local bootstrap uses a superuser connection). Never use it as an account or worker
pool. This adapter does not check that bootstrap privilege at startup.

The bridges directory contains Cargo manifests pointing at unchanged Phase 2b source files.
It avoids changing those crates' workspace declarations or copying their implementation.

`FileLifecycle` supports files-only modules; `PostgresLifecycle` adds transactional migrations,
sharing policies, both historical ledgers, startup audits and durable queue fencing. The
compiled legacy inventory is a release input, not something a downloaded package can extend.
Its two frozen meeting sidecars have trusted Rust implementations; downloaded JavaScript never
executes as a migration.

Registry settings, signed metadata, serial floors, revocations and publisher bindings persist.
Folder sources support offline mirrors; HTTPS sources accept an explicit public CA for that
source only. `preview_list` returns one consent per package, bound to both package digest and
previous installation. `apply_list` accepts those exact consents. A failed install retains the
old version and pin. Network transfers run outside lifecycle locks; activation rechecks current
trust, dependencies, pins and consent, and registry commits refuse a changed revision. Snapshot APIs list, expire and explicitly restore retained recovery points.

## Attachment permissions

A signed package declares `{"port":"attachments","operations":["read"],"resources":["handed"]}`
to read future uploads. `handed` is a stable attachment scope, not a wildcard on other ports.
The request resource is the upload UUID returned by the host's `hand_attachment`. Each read
still requires an attachment handed to that module by the signed-in account. A package may
also declare exact attachment UUIDs. Permission data describes that account-and-module scope.

## Verify

Run from `~/Jarv1s`. Use Rust 1.95 and keep build output outside the checkout.

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 clippy --locked --manifest-path rust-spike/module-host/Cargo.toml --all-targets -- -D warnings
cargo +1.95.0 fmt --manifest-path rust-spike/module-host/Cargo.toml --check
CARGO_TARGET_DIR=/tmp/moss-module-host-target python3 rust-spike/module-host/tools/remove-protections.py
```

Database tests run only through verify-gate. The wrapper creates and migrates a disposable
PostgreSQL server, runs the database tests serially, then removes the server. Never run ignored
database tests against a normal development database.

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate ./rust-spike/module-host/tools/gate.sh
scripts/run-gate.sh wait --follow
```

The explicit HTTPS proof uses the already installed `openssl`, `python3` and `devports`. It
claims a development port, starts a temporary TLS file server, checks the real transport and
releases the port on completion. It changes no system trust settings.

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml --test registry real_self_hosted_https -- --ignored --nocapture
```

The removal-control runner changes disposable sibling copies and requires each matching
assertion to fail. It never adds a bypass option to the delivered host. Use its log alongside
the passing protected tests; a stand-in upstream is not proof of a live provider integration.

The stalled-network proof also claims and releases development ports. It holds actual TLS
handshakes open while an installed Wasm module is called, covering index and package transfers.
Run it separately from the database gate:

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml --test transfers -- --ignored --nocapture
```

### Account policy routes and local dates

The typed transactional host additionally handles two opt-in account contracts.
Neither returns a database handle or accepts an actor, role or preference key.

- `context / local-date / account` takes `{instant?, date?, offsetDays?}`. Choose
  either an ISO instant or a calendar date, or omit both for now. It returns the
  account's persisted IANA timezone, calendar `date`, UTC `start` and `nextStart`,
  and `now`. Missing/invalid zones use the legacy `America/Los_Angeles` fallback.
  Day offsets use calendar arithmetic; a day across DST can have 23 or 25 hours.
- `action-policy / route-read|route-write / <family>` requires a `policyRoutes`
  declaration. Read takes `{}`; write takes `{tier}` with `ask_each_time`,
  `always_confirm` or `trusted_auto`. The host derives the canonical preference
  key from the installed module ID and a single-segment family. Optional
  `legacyBoolean` names a single-segment suffix under that same module ID;
  `installTier` defaults to `ask_each_time`. Canonical values win over legacy
  booleans. Only when neither row exists does read insert the declared install
  tier, then reread storage. Write updates both rows in one transaction.

Declarations are included in install/upgrade permission metadata. These are
preference routes, not a replacement for the existing one-use tool approval
contract. Both account contracts participate in guest commit/rollback and use
runtime account RLS. The module still cannot query core preference tables.
Run `scripts/run-gate.sh start --gate rust-spike/module-host/tools/account-contracts-gate.sh`
for real-component database, policy compatibility, account isolation and DST checks.

Current limitation: these routes store module-owned preferences; they do not
enforce tool approval. A declared `route-write` capability works from any guest
entry point, and `installTier` can grant a tier on first read. Before registry
packages can use these stored tiers for approval decisions, constrain writes to
user-initiated routes and make that grant explicit in the permission headline.
Module IDs forbid underscores, preventing legacy keys from entering the reserved
`assistant.action_policy.v1.` canonical namespace.
