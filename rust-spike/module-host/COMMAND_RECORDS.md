# Immutable queue commands and publication after commit

These opt-in ports support module jobs whose source versions cannot be represented
by the queue's metadata-only UUID/flag/count/choice schema. The queue still accepts
only that schema. Private command fields belong in module storage, never in a payload.

## Immutable records

Declare `kv` operations `records.get` and `records.put`, with a fixed collection resource.
`records.get` accepts `{ "id": "<uuid>" }` and returns the stored JSON value or `null`.
`records.put` accepts `{ "id": "<uuid>", "value": <non-null-json> }` and returns
`{ "created": <boolean>, "value": <stored-json> }`. An existing value is returned unchanged.
Callers must check that it describes the same logical command before retrying it.

The host validates the strict envelope and UUID. Each record is limited to 64 KiB and
uses a separate file through `VaultContext`. LocalPorts holds its process and disk locks
across lookup/publication, including calls from independent LocalPorts instances. Different
commands cannot overwrite a shared collection snapshot. Collection names become digests;
they never become guest-controlled paths. Existing `get`, `set` and `delete` behavior is unchanged.

Records use the account/module scope by default. Never declare a private command collection
in `installWideKv`: that is an explicit, separate grant for install-wide data. The authenticated
scope supplies the account; no request may select one. Records are module-private work data,
not a substitute for canonical notes or shared account preferences. They are retained until
module data is purged; queue completion does not currently garbage-collect them. Each
account/module/resource holds at most 10,000 records; a new id beyond that is refused while
replays of existing ids still succeed. There is no automatic retention or pruning, so
package qualification must account for long-running accumulation. Individual record size is
bounded.

## Deferred queue publication

Declare **both** `jobs/enqueue-after-commit` and `jobs/enqueue-options`, on the owned queue.
The request body is the existing enqueue-options envelope: `params`, UUID `idempotencyKey`,
and RFC 3339 `availableAt`. It returns `{ "deferred": true }`; this acknowledges deferred
intent within the invocation, not a published queue row.

`AfterCommitJobs` must be **inside** `TransactionalDatabasePorts`. It validates both
capabilities before retaining at most one thousand requests per invocation. Failed/trapped
invocations discard them. Successful finalization publishes after the outer adapter's commit.
`Application::open_extended_with` installs this adapter automatically. The older assembly does
not support this operation and refuses it rather than publishing early. Trusted custom
adapters must forward finalization as documented by `open_extended_with`.

Queue publication and the database commit are not one atomic transaction. A queue failure
after commit propagates to the worker; retry the same durable command. Already published
requests use their original keys and deduplicate. A process death between commit and publication
still needs the queue's retry/recovery path. New logical cycles need new UUIDs because queue
deduplication includes completed work. Never reuse a permanent source/person key as a command ID.

The People guest compares the immutable command on enqueue retries and keeps its original
fifteen-minute availability time. Worker providers run before its first People query. Memory
follow-ups are deferred until commit; the legacy memory worker remains a no-write stub.
