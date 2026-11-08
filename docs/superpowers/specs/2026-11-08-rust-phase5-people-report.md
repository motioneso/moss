# Rust Phase 5: People & Context

Task JS-45, Card 523. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

Status: implementation in progress. This is a checkpoint report, not a parity or completion
claim. People is not yet installable or reachable through the Rust UI.

## Scope and dependencies

Port People as it behaves today. Keep its existing SQL, row privacy, note-backed writes,
Settings pane, tools, job kinds and public contracts. Workshop and Food are excluded.

The branch began at Phase 0a and was advanced to merged Phase 4b main `80aa42123` before
implementation. The package specification, data/install rules, earlier reports and current
People implementation are the design inputs. The Phase 4b report explicitly does not claim
whole-app integration.

The coordinator authorized additive host changes in small commits. Responsibilities were
agreed with JS-46:

| Owner | Responsibility                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS-46 | Shared module SDK, filtered/composite-key queries, transactions spanning a guest invocation, parameterized route dispatch, module frame and shared Leptos bridge |
| JS-45 | People package and behavior, public People contracts, chosen-folder account note access and its tests                                                            |
| JS-44 | Host sign-in, sessions, origin/Host checks and HTTPS                                                                                                             |

Consume the shared checkpoint from main when integrated. Do not copy the SDK or host
implementation into People. The shared SDK contract was first committed as `d549d8d5a` on
the sibling branch; it is not yet a dependency of this checkpoint.

## Compatibility inventory

- **Data:** seven `app.person_context_*` tables, owned by People. Package SQL must read the
  unchanged `packages/people/sql/0128_person_context.sql`, declare `core-legacy`, and retain
  the inventory checksum and ledger identity. The current file hash matches the compiled
  Phase 4b inventory. No new table or migration is needed for the port itself.
- **Privacy:** each table enables and forces RLS with owner-only policies for both runtime
  roles. The Rust port still needs failing-first read/insert/update/delete controls for another
  account and an administrator. Static policy inspection is not that proof.
- **Screen:** People has no separate page today. Its pane is in Settings, Memory & context,
  People. Keep folder browsing, refreshing from notes, match review, rename/archive, add-person
  and the default-on Suggest note updates behavior.
- **Notes:** the canonical source is the chosen People folder inside allowed notes roots,
  not module-local storage. Keep the `people-notes-folder` preference and legacy-relative
  resolution, canonical-ID rules, duplicate/missing-note review, unused-filename selection,
  coordinated note edits, managed-section boundaries and ingest nudges.
- **Queries:** name-prefix search and ordering, identity lookup, aliases, recent links and
  composite indexing keys must work beyond the old host's capped table scan. Merges, splits,
  projections and indexing writes must retain their single-transaction behavior.
- **Tools:** retain `people.resolve`, `people.getContext`, `people.listRecent`,
  `people.acceptMatch`, `people.rejectMatch`, `people.merge` and `people.splitIdentity`.
  Preserve the current route/app-action blocks and approval behavior; listing a tool does not
  authorize bypassing those restrictions.
- **Jobs:** retain `person-index` and `sync-person-memory`, metadata-only envelopes,
  idempotency keys, batch cap of fifty and the fifteen-minute index cooldown. The current
  memory-sync worker is a stub; parity does not mean inventing a memory write.
- **Public module boundary:** expose People lookups through declared versioned APIs, including
  the existing `findPeopleByNames` semantics: at most thirty requested names, exact active
  name/alias matches ignoring case, first-created person order, one result per person and
  first nonempty summary lines capped at two hundred characters. Consumers must not query
  People tables or import its private source.

## Host/core split

Section 7 of the package specification keeps these areas in the host:

| Core area                         | Why it stays in the host                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| Sign-in, accounts, settings frame | Authenticate the actor and control install/account configuration |
| Chat and agents                   | Carry turns, approvals and account agent execution               |
| Memory and embeddings             | Supply shared retrieval and indexing services                    |
| Vault                             | Confine file access and coordinate account note writes           |
| AI router                         | Select configured capabilities without module-held credentials   |
| Connectors framework              | Broker account connections without exposing tokens               |
| Notifications                     | Deliver account-scoped messages                                  |
| Job queue                         | Enforce actor envelopes, scheduling and retries                  |
| App map                           | Combine truthful core and package declarations                   |
| Workflows and structured state    | Own shared orchestration and preferences                         |
| Today shell                       | Compose module contributions in the app frame                    |

People owns its contact projection, matching and canonical-note behavior; it consumes those
host services through SDK ports. Other feature modules remain packages under the approved
module spec.

## Checkpoint verification and remaining work

The pure crate ports identity normalization, candidate signatures, signal grouping, note
frontmatter parsing/formatting and managed-section replacement. Its differential fixtures
come from the current TypeScript functions, including Unicode whitespace and UTF-16 sorting.

The additive vault constructor now binds allowed notes roots to an authenticated account and
opens only an existing selected folder through the confined root API. It does not create a
folder or turn module storage into canonical notes storage. Seven tests cover owner access,
cross-account reads and writes, containment, missing folders, protected canonical vaults and
symlink selection. With the guards removed, the cross-account read/write and containment/link
tests failed; restoring them passed all fourteen vault tests and strict Clippy. This tests the
new constructor only: the notes host adapter and database RLS remain unproven. The existing
vault component-check/open race described in its crate documentation is unchanged.

Before ready, complete and record all of the following:

1. Consume the integrated shared SDK/host checkpoint and build the package natively and as
   a WebAssembly component. Preserve original migration bytes and verify package installation.
2. Implement persistence, canonical notes, public APIs, tools and both job handlers through
   SDK ports. Add the chosen-folder host adapter with account/privacy removal controls.
3. Port the existing Settings pane using the shared kit/frame and put navigation, settings,
   features, errors and remediations in the package manifest.
4. Extend and run the parity harness through verify-gate; run privacy assertions with their
   protections removed and then restored. Compare persisted rows as well as responses.
5. Exercise the installed package through real signed-in Rust screens, including a second
   device; record what was actually checked and remove disposable data.
6. Run project checks, get independent review, publish the proof artifact, update the card
   and call ready. No completion, UI, RLS or remote-device proof is claimed by this checkpoint.
