# Delayed, idempotent module enqueue

This is an opt-in extension. Existing `jobs/enqueue` requests and their immediate, independent
enqueue behavior remain unchanged.

Declare `enqueue-options` in the `jobs` capability's operations and the owned queue in its
resources. The queue still declares its typed metadata fields in `jobs`. Call the same port
and queue resource with this envelope:

```json
{
  "operation": "enqueue-options",
  "resource": "person-index",
  "parameters": {
    "params": { "command-id": "00000000-0000-4000-8000-000000000001" },
    "idempotencyKey": "00000000-0000-4000-8000-000000000002",
    "availableAt": "2026-11-08T12:15:00.123Z"
  }
}
```

- `params` must match the queue's existing metadata schema. A private-content field, actor,
  module, role or connection is never a caller-supplied envelope field.
- `idempotencyKey` is a UUID for this logical command. Retries reuse it. Phase 2b deduplicates
  by authenticated actor, namespaced queue and this key, including completed records. A new
  logical command must have a new key; this is not a sliding singleton cooldown.
- `availableAt` is a timestamp with a timezone, normalized to UTC. It becomes the real queue
  row's `run_at`; workers cannot claim it early. A timestamp in the past is immediately due.
- The host supplies the actor, module key, manifest hash and job kind. The options never
  become job content. The result remains `{ "id": "<job UUID>" }`, or `{ "id": null }` when
  the same command is already recorded.

Modules whose commands need source hashes or versions can keep that metadata in account-scoped
storage and enqueue only a typed command UUID. They must re-read private content under the
worker's authenticated context. This extension does not make a queue enqueue and a separate
module database transaction atomic.

Native authorization and parser tests are in `tests/enqueue_options.rs` and the helper module.
The database test drives the actual Wasm import and JobPorts, inspects persisted queue rows,
and uses the real worker claim path. Run it only through verify-gate:

```sh
scripts/run-gate.sh start --gate test:module-enqueue-options
scripts/run-gate.sh wait --follow
```
