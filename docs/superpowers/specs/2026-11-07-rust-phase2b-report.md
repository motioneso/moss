# Rust port, Phase 2 part 2: queue, modules and capability routing

- Task JS-39, Card 477. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
- Code: `rust-spike/platform/`, an independent Cargo workspace under `~/Jarv1s`.
- Read the Rust port plan (Phase 2 and section 3), data/install rules, and the
  merged Phase 0b and Phase 1 reports before implementation.
- This branch started from `6d4eba749`; the later merged reports were read from
  `origin/main` without importing another task's code. JS-38 files are untouched.

## Summary

Rust now has a working queue, a list of modules and their declared pages and
settings, and a way to choose each person's configured AI model. The work lives
in new crates, ready to join to the separate sign-in and privacy work. It does
not switch the running app to Rust or finish the whole Phase 2 safety gate.

## What was built

| Part               | Behavior                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres queue     | New `moss_queue` schema, delayed jobs, per-actor/queue UUID idempotency, concurrent claims with `SKIP LOCKED`, bounded retries/backoff, renewable fenced leases, terminal failure codes, timezone-aware schedules, invalid-row quarantine and cancellation.                                        |
| Metadata contracts | Closed envelope with actor/module IDs, job kind, manifest hash and per-queue semantic params. UUIDs, declared enums, bounded numbers, booleans, nulls and bounded arrays only; no generic text kind. Payload and params byte limits. Unknown fields and actor mismatches refused before insertion. |
| Module registry    | Loads manifests including navigation, settings, features, routes, migrations and owned SQL tables. Duplicate ownership and unsafe migration paths refused. Query APIs retain declarations.                                                                                                         |
| Route coverage     | Checks actual registered patterns in both directions: undeclared handlers and declarations without handlers fail. HEAD is normalized to GET, matching TypeScript. Explicit platform allowlist for core routes.                                                                                     |
| App map            | Builds the same declaration document from the existing built-in manifests and core declarations, including nested errors, remediations, module ownership and core-path deduplication. No new product surfaces require new TypeScript map entries.                                                  |
| Capability routing | Selects configured model IDs using actor-scoped configuration, capability, tier, admin pins, explicit service binding, defaults and permitted user override. HTTP protocol/provider details stay in adapters.                                                                                      |
| HTTP adapters      | Real outbound HTTP text generation for the three existing HTTP protocols, with model IDs supplied by configuration; an additional local protocol is available but not parity-qualified. Bounded responses, no redirects, timeouts, and fixed error codes.                                          |
| Build checks       | Checks module-to-module dependency edges, HTTP client ownership, provider/model string literals, payload type shapes and raw filesystem/network use in this workspace. Negative controls exercise these checks.                                                                                    |

The queue's runtime connections explicitly require the existing non-superuser,
non-bypass app or worker role. Producer operations set transaction-local actor and
request IDs. Workers may inspect all queue metadata to dispatch jobs; resource
content must be loaded through the actor's DataContext. This is not an admin
private-data bypass. Applied TypeScript migrations and pg-boss schema are unchanged.

## TypeScript reference and parity method

Read `packages/jobs/src/module-jobs.ts`, module parameter schemas, module-registry
route guard and app-map builder, capability/service resolution and the existing
HTTP adapter before porting. The companion rules deliberately tighten the old
parameter schema: a short arbitrary identifier or string is not safe metadata.
The Rust schema therefore refuses free-text kinds even where an older manifest
might have accepted one. Each migrated queue needs an approved semantic schema.

The harness starts the existing Fastify API using `createApiServer` and its real
capability-route handler, backed by a freshly migrated throwaway database. Rust
uses a gate-only Axum host with synthetic sessions and per-actor fixture snapshots.
The same requests compare availability, reason and selected model identity.
Anonymous requests are checked on both hosts. Responses are projected to the
comparable contract; this does not certify full API response-shape parity.

Payload validation, route coverage, app-map generation and adapters have no
matching standalone production endpoints. Gate-only `/probe` wrappers call the
real TypeScript functions and the Rust equivalents over HTTP. The fixture exporter
loads every built-in manifest, rather than maintaining a second hand-written map.
For outbound adapter parity a local HTTP sink captures real request paths, JSON
bodies and credential-header presence; the Google reference URL is redirected
only at the injected fetch boundary. No external provider is contacted. Failure
bodies contain a sentinel and both wrappers expose only a fixed failure code.
These checks prove tested protocol contracts, not live provider acceptance.

## Evidence

The focused verify-gate completed with exit zero on Linux on 2026-11-07. It used
its own throwaway pgvector Postgres container, applied the existing migrations,
and removed the container afterward. The live dev database was never used.

| Check                      | Result                                                                                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP differential suite    | **50/50 matched**: 21 metadata/route contract cases, one complete built-in app-map comparison, 22 routing cases and six adapter success/failure cases.                                                                                                               |
| Existing TypeScript server | Real Fastify capability-route endpoint, with seeded app users and sessions in the gate database. Both servers refuse anonymous lookup.                                                                                                                               |
| Built-in declarations      | All 28 manifests loaded, including 140 owned-table declarations. Full app-map output matches, including nested errors and remediations.                                                                                                                              |
| Cargo                      | Eight unit/regression tests pass; the separate gated Postgres lifecycle test passes. Database test is ignored in ordinary cargo runs by design.                                                                                                                      |
| Queue database scenarios   | Duplicate keys, actor mismatch, actor isolation, concurrent claims, retries, stale fencing, delayed execution, actor context handoff, schedules, sentinel absence, heartbeat, invalid schedule quarantine, missed-run coalescing and actor-scoped cancellation pass. |
| Guard sensitivity          | Removing each of five guards makes its corresponding regression check fail; restoring the guards passes.                                                                                                                                                             |
| Maintainability            | Repository lint, format check, file-size check and typecheck pass. Standalone harness TypeScript check, scoped lint, Rust formatting and workspace boundary checks pass.                                                                                             |

Reproduce through the commands in `rust-spike/platform/README.md`. Rust formatting
uses the already-installed `+1.95.0` toolchain. The root format ignore gains only
the new workspace's generated `target` folder; otherwise Cargo fingerprint JSON
is incorrectly treated as authored source. No new global tool was installed.

These are real excerpts from the protection-removal run. Each mutation is made
in a disposable copy; no weakened guard is committed:

```text
NEGATIVE payload refusal removed: expected failure, exit 101
accepted forbidden top-level field content
test payload_refuses_content_and_secrets ... FAILED
NEGATIVE route coverage removed: expected failure, exit 101
undeclared route reached startup
test undeclared_route_is_refused ... FAILED
NEGATIVE provider lint removed: expected failure, exit 101
provider guard accepted a hardcoded provider in feature code
test provider_literal_is_rejected ... FAILED
NEGATIVE payload shape lint removed: expected failure, exit 101
payload guard accepted free text
test payload_shape_is_rejected ... FAILED
NEGATIVE module edge check removed: expected failure, exit 1
AssertionError: private implementation edge was allowed
NEGATIVE PASS: all five removed protections made their own regression check fail
```

The passing run ends with:

```text
PARITY 50/50 cases match; anonymous capability lookup refused on both servers
### FINAL rc=0
```

Logs, generated exports and the task's proof recipe are kept outside commits.
There is no screen change in this internal platform slice; command output is the
proof. A local HTTP sink proves protocol requests, not a production AI reply.

## Independent review disposition

Round one identified three major findings. All are addressed: the complete
parity run is green and reported here; invalid schedule rows are quarantined
without rolling back healthy work; and missed cron occurrences coalesce into one
job before advancing from database time. Tests cover two corrupt schedules beside
a healthy one, concurrent ticks, and no further replay after the first tick.

The review's minor findings are recorded too:

- Tightened job-kind spelling and raw UUID validation before deserialization.
- Scoped expired-lease cleanup to the queues owned by that worker.
- Added schedule cancellation with actor RLS and a schedule-payload storage bound.
- Dependency checks have synthetic private/public, renamed I/O and target-specific
  cases. This workspace contains platform crates, so there are no real feature
  module edges yet. Future module crates must declare their ownership metadata.
- Core deduplication and manifest spread precedence intentionally match the
  TypeScript builder, including its behavior for missing fields. This is a
  compatibility decision, not a stronger manifest-validation claim.
- The loader preserves trusted built-in absolute SQL-directory declarations
  without opening them; traversal is refused. Normalizing only the test export,
  as suggested in review, would conceal the existing manifests' real shape.
- Queue registration, rich app-map description validation and hostile add-on SQL
  installation checks remain installer integration work. This slice loads and
  queries those declarations rather than executing add-on code or SQL.
- A failed heartbeat stops the handler rather than continuing after ownership may
  be lost. External side effects still require idempotency or reconciliation.
- The queue currently connects without database TLS for the private bundled
  cluster. An external TLS-required Postgres is unsupported here. Browser HTTPS
  is separate and belongs to the product host.

## Joining JS-38 and the product host

1. Adapt authenticated sessions into `Actor`, which contains only user and request
   IDs. Its public constructor is a trusted-host seam, not an authentication check.
2. Implement `ConfigurationStore::for_actor` using an actor-scoped DataContext.
   Filter providers/models for visibility and ownership there. Preserve the
   instance policy and override eligibility loaded by the TypeScript resolver.
3. Implement `EndpointStore::for_model` through that context and JS-38's cipher.
   `Secret` has no Debug, Display or Serialize and zeroizes its own string. This
   does not claim every temporary HTTP-library buffer is zeroized.
4. Implement `JobHandler::execute_in_data_context` with a fresh actor context and
   resource reload. Apply the new SQL once via the migration ledger. Reconcile
   uncertain side effects; lease fencing cannot make a remote send exactly once.
5. Compare `Registry::assert_coverage` with the assembled server's real route
   inventory before accepting traffic. Integrate these build checks into its CI.

There is no global browser identity, local-storage identity or singleton account
in these libraries. Every configuration and endpoint lookup receives an actor;
jobs persist the actor and workers reconstruct a fresh request identity. This
supports several desktop accounts and simultaneous remote clients in one build.
The libraries do not choose a server bind address. JS-38/the assembled host must
honor configured non-loopback listening, explicit trusted origins, TLS/proxy
handling and authenticated remote sessions. The unauthenticated parity probes
remain loopback-only and must never be exposed as the product server.

## Not proven and remaining work

- JS-38 session, cipher, RLS context and vault integration; the whole Phase 2 kill
  gate remains open until both slices run together. No real key or private data
  was used or inspected here.
- Phone, laptop, LAN and tailnet browsers; remote login, secure cookies, HTTPS,
  forwarded-header policy and origin rejection. These need the assembled host.
- Windows and macOS runtime/packaging. This run is Linux only; the Phase 1 report's
  remaining platform gates still apply.
- Live AI vendors, structured generation, native web search/citations, audio
  transcription, cancellation/activity telemetry and the later chat/agent
  orchestration. The tested transport surface is ordinary bounded text chat.
- Importing old pending jobs, protected-history UI, installation fencing across
  hosts and reconciliation of uncertain external writes. These belong to the
  explicit move/cutover path, not this queue's ordinary enqueue API.
- Full pg-boss operational parity, retention/cleanup policy, restart/load/soak
  tests, exhaustive cron/DST edges and all legacy module queue declarations.
- Static checks are regression guards for cooperating source code, not a sandbox
  for hostile native crates. Add-on SQL validation/installation is not implemented
  by this manifest reader; the later installer must enforce the companion rules.

## How to proceed

Join the narrow ports to JS-38 without moving raw database or cipher handles into
feature crates. Then run the combined privacy and sentinel suite, attach route
coverage to the real host and qualify the remaining HTTP operations as their
features are ported. Keep the rewrite proceeding; these measurements size the
remaining work and do not propose a no-go decision.
