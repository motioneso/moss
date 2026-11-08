# Linked-notes availability

The optional `vault/notes.status` operation complements the existing
[linked-notes contract](../../modules/notes/HOST_ADAPTER.md). Its resource is the same
trusted account-folder alias as the read/list/write operations; its parameters are `{}`.
Declare it explicitly in the module's capabilities.

It returns `{available: false}` only when the provider reports the typed
`LinkedFolderUnavailable` error. The built-in preference provider uses that error for
an unset/invalid folder preference, an invalid relative base, or a selected folder that
cannot be opened within the account's allowed roots. A successful resolution returns
`{available: true}` after checking the resolved folder's actor.

Database lookup failures, provider configuration failures and wrong-actor results remain
errors. No host diagnostic or folder path is returned to the guest. Trusted custom
providers must reserve `LinkedFolderUnavailable` for confirmed folder unavailability;
they must propagate backend failures as ordinary errors.

Status neither locks the folder nor reads its contents. A subsequent list/read can still
fail because another writer holds the lock, a file is oversized or not UTF-8, an entry
limit is exceeded, or the folder changed. Those errors must abort an edit rather than
authorize a database-only fallback. The status check is deliberately conservative when
a folder disappears between resolution and a later file operation.

People uses this operation before its route-only rename/archive fallback and refresh.
Canonical-note absence discovered by a successful scan remains a separate fallback case.
Publication/projection failures never permit fallback. The generic native tests cover
available/missing folders, wrong-actor resolution, a real held folder lock and provider
failure. The People database regression adds an actual oversized note and asserts refusal
without changing the existing person or canonical file.
