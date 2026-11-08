# People public interface

This is the compatibility contract for the Phase 5 port. The package handlers are still
being implemented; this document does not claim that they are installed or available.

People owns contact IDs and projections. Tasks, notes and calendar keep their existing
contact IDs. They call the host's public API port rather than reading People tables or
importing the module's private source. The host supplies the authenticated account; callers
must never send an actor, database connection or runtime role.

Consumers declare `"requires": { "people": ">=0.1.0, <1.0.0" }` plus the `api/call/people`
capability. The request uses the SDK's existing `{name, parameters}` envelope:

```rust,ignore
Client(host).api("people", "findPeopleByNames", json!({"names": ["Alice", "Al"]}))
```

The package will declare these names in `provides`, each at version `0.1.0`:

| Name                      | Parameters           | Result                                             |
| ------------------------- | -------------------- | -------------------------------------------------- |
| `findPeopleByNames`       | `{names: string[]}`  | `PersonByNameMatch[]`                              |
| `resolve`                 | `{query: string}`    | `{person: Person \| null}`                         |
| `getPerson`               | `{personId: string}` | `PersonDetail`                                     |
| `listEmailIdentityValues` | `{}`                 | normalized stored email identity values as strings |

`findPeopleByNames` preserves the existing helper's behavior:

- Consider only the first thirty raw names, trim them, discard empty names and deduplicate
  ignoring case. The cap applies before discarding or deduplicating.
- Match exact active display names or active `alias`/`display_name` identities, ignoring
  case. Prefix and fuzzy matches are not part of this operation.
- Return one result per active person, ordered by creation time. The direct-name match
  precedes an alias match when both refer to the same person at the same creation time.
- Each result is `{name, role, note, matchedName}`. `matchedName` is the first trimmed request
  spelling that matched. `role` and `note` are the first nonempty trimmed summary lines, or
  null. Each line is capped at two hundred JavaScript string units, including its ellipsis.
- Return an empty array when nothing matches. Results contain only the calling account's data.

`resolve` trims and lowercases a query, tries stored identities first and then the earliest
created exact display-name match. It retains the current service's status behavior rather
than silently applying the active-only rule from `findPeopleByNames`.

`Person` retains these response fields: `id`, `ownerUserId`, `displayName`,
`relationshipSummary`, `contextSummary`, `status`, `confidence`, `memoryEntityId`,
`mergedIntoPersonId`, `archivedAt`, `mergedAt`, `createdAt`, `updatedAt`.
`PersonDetail` adds `identities` and the twenty most recent `recentLinks`. Dates are ISO
timestamps and optional values are null. The current wire value of confidence is a
decimal string (for example `"0.75"`): node-postgres returns `NUMERIC(4,2)` as text,
and the legacy TypeScript type assertion does not convert it. The native persistence
differential check verifies that behavior; changing it to a JSON number would change
the interface. Internal normalized identity values and raw source references are not added
to the ordinary identity/link response.

The current `repository` module is an internal persistence checkpoint. The compiled guest
implements the `findPeopleByNames`, `resolve`, `getPerson` and
`listEmailIdentityValues` API envelopes above, but
no installed package registers them yet. It also covers person projections and composite
indexing state internally. Indexing-state
rows currently retain database field names internally; the eventual service must preserve
the legacy external response shape. Do not use this internal module as a consumer interface.

`listEmailIdentityValues` retains the current helper's behavior: all email-address identities
for the account, without adding a new active-only filter. It is for owner-scoped source
filtering, not a way to read another account's contacts.

## Chat and UI compatibility

Retain all seven exact tool names: `people.resolve`, `people.getContext`, `people.listRecent`,
`people.acceptMatch`, `people.rejectMatch`, `people.merge`, `people.splitIdentity`.
`getContext` includes link citation tokens of the form `sourceKind:sourceRefHash:id` and its
existing column order. `listRecent` defaults to twenty and keeps display-name ordering.
Match review keeps the existing approval rules. Note-backed writes, merges and identity
splits remain blocked on the chat app-action path; a declared API does not remove a block.

People remains in Settings → Memory & context → People, with no separate People page.
The notes folder preference stays at the existing `people-notes-folder` key in shared account
preferences. Legacy relative folders resolve against `notes-source-path`, then pass the same
host allowed-root checks as absolute folders. Module-local storage is not canonical note storage.

The job kinds remain `person-index` and `sync-person-memory`. Job envelopes are account-scoped
and metadata-only. Indexing retains the batch cap, delayed start and stable idempotency behavior;
memory sync remains the existing stub until its composition layer supplies a memory provider.

## Internal job dispatch checkpoint

The compiled guest now implements both job kinds and these additive API names. They are
not installed public package APIs yet; the four consumer lookups above remain unchanged.

| Name                | Parameters                   | Result                                 |
| ------------------- | ---------------------------- | -------------------------------------- |
| `enqueueIndex`      | `IndexCommand`               | `{enqueued: true}`                     |
| `enqueueIndexBatch` | `{commands: IndexCommand[]}` | `{enqueued: number}`; first fifty only |
| `enqueueMemorySync` | `MemoryCommand`              | `{enqueued: true}`                     |

`IndexCommand` is `{commandId, source, sourceRefHash, sourceVersion?, reason}`.
`MemoryCommand` is `{commandId, personId, personUpdatedAt, reason}`. Command IDs are UUIDs;
all other fields retain their existing string values, including opaque hashes and versions.
The host supplies the actor. Strict envelopes reject extra fields, including caller-selected
actors. A new logical cycle needs a fresh command UUID. Retry the same command unchanged;
reusing its ID for different content fails. Queue deduplication includes completed work,
so a permanent source/person ID would incorrectly suppress future cycles.

The guest stores an immutable record in the account-scoped `people-commands` collection
through `kv/records.get` and `kv/records.put`. Only `{"command-id": "<uuid>"}` reaches the
queue. The command retains its original availability time across retries: fifteen minutes
after the first index enqueue, immediate for memory sync. Records survive completion until
module data purge; aggregate quotas and automatic cleanup are not implemented.

Trusted composition supplies the account KV resource `person-providers`, mapping each
source kind to its declared provider module. It must declare the corresponding `api/call`
resources and versioned dependencies; a guest cannot use this map to widen its grant.
The provider implements `collectPersonSignals` with parameters
`{sourceRefHash, sourceVersion?}` and result `{signals: PersonContextSignal[]}`. The same
authenticated account reaches that API; no actor is taken from the command. Missing providers
are a no-op, matching the existing worker. Provider I/O precedes the first People query.
The provider adapter in the differential test is a fixture; real installed provider dispatch
remains a package-composition qualification step.

The `job` export accepts `{queue, parameters: {"command-id": "<uuid>"}}` for the two exact
job names. Indexing uses the invocation's database transaction for projections, identities,
links, events and indexing state. Its memory follow-ups require both
`jobs/enqueue-after-commit` and `jobs/enqueue-options`; assemble the generic adapter as
specified in [the host contract](../../rust-spike/module-host/COMMAND_RECORDS.md).
Publication happens after commit, with deterministic child command IDs for retries. This is
an at-least-once seam, not an atomic database/queue outbox. A publication failure returns an
error for queue retry; another indexing pass can append another legacy event.

The installed package must still declare both queue schemas, retries and capability grants.
This checkpoint does not connect ingest nudges, HTTP routes, installed chat or Settings.
