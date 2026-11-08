# Linked Notes host adapter

This is trusted host infrastructure for the Notes and People continuations. It is not
an installed Notes package or the Notes module's public collaboration API.

`moss_module_host::linked_notes` exports `LinkedNotesPorts`, `FolderProvider`,
`LinkedFolder`, `PreferenceFolders` and `PreferenceFolder`.

The application composes `LinkedNotesPorts::new(provider, next)` through the shared
`Application::open_extended_with` extension seam. It sits inside the transactional
database wrapper, which finalizes files after database commit or rollback.

## Trusted configuration

`PreferenceFolders::new(database, resources, roots)` takes:

- A runtime `Database` for the app or worker role.
- A map from `(module ID, resource alias)` to `PreferenceFolder { preference,
relative_to }`. The database lookup uses the invocation's authenticated account
  and the existing preference RLS. Missing settings fail closed.
- A map from account UUID to `AllowedRoots`, prepared by trusted host code.

A relative folder setting joins the same account's `relative_to` preference, which
must be absolute. Parent traversal is refused. An absolute folder setting is used
directly and still passes the allowed-roots guard. No folder is created by opening it.

A custom trusted `FolderProvider::resolve(access, module, resource)` may instead
return `LinkedFolder::open(access, selected, allowed_roots)`. The adapter independently
checks that the returned folder was opened for the current account. Guests cannot
construct folders, choose an account or supply an absolute root through parameters.

## Port contract

Declare the `vault` port, each operation used and the exact resource aliases in the
guest manifest. `resource` is the trusted alias; file names belong in `parameters`.

| Operation             | Parameters                                 | Result                                                                 |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `notes.read`          | `{path}`                                   | `{path, destinationId, content}`; content is text or null when missing |
| `notes.list`          | `{path}`; empty for the root               | `{entries: [{name, kind}]}`; kind is `directory` or `file`             |
| `notes.compare-write` | `{path, destinationId, expected, content}` | `{path, destinationId, saved: true}`                                   |
| `notes.remove`        | `{path, destinationId, expected}`          | `{path, destinationId, saved: true}`                                   |

Files must have relative `.md` names. Listings show immediate Markdown files and
directories, omit links and other file types, and refuse folders over the entry
limit. `expected` is the exact current text, or null when creating an absent file.
The opaque `destinationId` comes from a read, including a read of a missing file.
It uses the legacy canonical-path digest. A relink invalidates the old destination,
even when file names and text match. A stale expectation refuses overwrite and deletion. Only UTF-8 files are supported.

Limits: a file is at most 256 KiB; an invocation changes at most 32 files, holds at
most eight folders and retains at most 4 MiB of original/current text. At most 128
invocations may retain folder locks. Contending cooperating writers are refused
immediately. A call can retry after reading current text.

## Finalization and limits

Folder locks last until `Ports::finish_call`. Successful finalization retains the
published changes. Failed calls restore each original only if the current bytes
still match the adapter's last publication. An external edit is retained and the
rollback reports a conflict. Multiple mutations of one file retain its first original.

This is compensation, not distributed database/filesystem atomicity. It does not
recover from a killed process. Arbitrary editors do not participate in folder locks.
The Vault ancestor-check/open race and final comparison/rename race remain. Empty
parent folders created before a failed write may remain. Do not use this adapter to
claim crash-safe managed contribution receipts until the continuation implements
and verifies durable reconciliation.
