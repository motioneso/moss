# Module management service contract

JS-403, Phase 6 part 1. These contracts extend the existing shell installer; screen work
belongs to later Phase 6 parts. Paths below are relative to `~/Jarv1s`.

## Requests

All management endpoints require an authenticated instance administrator. Review operations
also belong to the administrator who created them. Session middleware supplies the actor;
request bodies cannot choose an actor, database login, source address or signing key.

| Endpoint                                    | Request            | Response                                                                                               |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /api/modules/catalog`                  | None               | `sources` with signed names and health, and `modules` retaining their source IDs, versions and digests |
| `POST /api/modules/review`                  | `module`, `source` | Persisted operation with its immutable review and initial `reviewed` stage                             |
| `GET /api/modules/operations/{id}`          | None               | Persisted review, stage and optional terminal result                                                   |
| `POST /api/modules/operations/{id}/execute` | `approve: true`    | Same operation ID, HTTP 202; repeat calls return that operation                                        |

The review names the source, module, version, exact digest, previous installed digest, full
capabilities and migration paths, and the permission changes the administrator is approving.
Approval cannot be transferred to another digest or another installed predecessor.

## Execution and recovery

Execution rechecks administrator authorization after waiting for the server's install gate.
The installer child checks the recorded actor against the database again. The child holds an
instance-wide file lock across recovery, registry refresh, validation and activation, including
legacy installer calls. Changes to trusted source configuration invalidate an earlier review.

Operation stages describe work actually reached: `reviewed`, `queued`, `checking`, `installing`,
then `succeeded` or `failed`. There are no progress percentages or simulated timers. The child
persists each stage and terminal result. The server can read them while it works or after restart.

An interrupted operation may be explicitly executed again. The child first opens the existing
host (which performs lifecycle recovery), then checks the installed digest. If the reviewed
package is already active, it records success without activating it a second time. A terminal
operation returns its saved result; a failed operation needs a new review before a new attempt.
This avoids automatically repeating a potentially completed change.

Package verification, registry replay protection, publisher binding, migrations and rollback
remain owned by the existing module host. The new service does not create another installer.

## Configuration and compatibility

The private `registry.json` instance file accepts the previous single registry object, or an
object with a `registries` array. Each entry has `id`, exactly one of `folder` or `url`,
`rootKey`, and `firstPartyKey`. Source IDs are unique. Source addresses and keys stay in host
configuration; catalog replies contain the source's signed ID and name instead.

Existing `/api/modules`, `/api/modules/plan` and `/api/modules/install` calls keep their
request and response shapes. With multiple sources, an omitted source selects the first configured
source. The new review endpoint requires an explicit source. Legacy approved installs still
require the reviewed version; new callers use the digest-bound operation contract.

## Verification

The focused runner is `test:rust-phase6-catalog-and-review`. Use the repository's `verify-gate`
skill and `scripts/run-gate.sh`; do not run database tests against the development database.
Set `RUSTUP_HOME`, `CARGO_HOME`, and an isolated `CARGO_TARGET_DIR`. On memory-constrained
machines set `CARGO_BUILD_JOBS=2` and `CARGO_PROFILE_DEV_DEBUG=0`, and coordinate builds.

The executable fixture launches the real HTTPS shell with signed registry folders and isolated
PostgreSQL. It exercises catalog identity, legacy calls, review contents, wrong-role and
signed-out access, concurrent execution, saved results after restart, and changed package bytes
refused while the previous installed digest remains intact. UI, remote registry delivery,
three-OS operation and process termination during SQL are outside this fixture's proof.
