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
