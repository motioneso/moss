# Rust Moss: module packages and the download registry

- **Status:** design spec for review. No code, no screens.
- **Task:** JS-41. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
- **Ruling behind it:** Ben, 2026-11-07. Rust Moss is modular like Docker images, and people fetch
  modules from a download registry.
- **Amends:** `docs/superpowers/specs/2026-11-06-rust-port-plan.md` section 2.4, the phase table
  and Phases 5 and 6, which this PR edits to match. Section 3.4 of the plan still holds; section 5
  below fills in its ports. Section 9 below gives the new phase order.
- **Reads with:** `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md` (companion
  rules for SQL, keys and module isolation) and
  `docs/superpowers/specs/2026-11-07-rust-phase2b-report.md` (the Rust manifest reader).
- **Grounded on:** `main` at `07ac1e5db`.

## 1. Summary

Every feature in Rust Moss ships as a module package. A package is one signed file that holds a
WebAssembly component, the module's SQL, its screens, its icons and its manifest. Moss fetches
packages from a registry, which is a signed index plus package files on any static web host. The
same file installs on Windows, macOS and Linux, with no admin rights, into Moss's own data folder.

First-party modules use the same format. The installer carries a set of them inside it, so a fresh
install with no network still has calendar, tasks, notes and the rest. Updates to those modules
then arrive through the registry. A new Moss release is needed only for host changes, and for
new first-party SQL that needs the legacy exception (4.6).

The host stays small and trusted. It owns sign-in, accounts, chat and agents, memory, the vault,
the AI router, the job queue and the app frame. A module reaches anything only through ports the
host links into it. It cannot open files, sockets or database connections by itself.

The plan changes in one important way. Phase 5 no longer compiles in-repo modules straight into
the program. Each ported module follows the package rule in section 7 from its first line of
Rust, so it can ship as a package later without a rewrite. The module host and package format
therefore move ahead of Phase 5, as a new Phase 4b.

## 2. How modules install today

| Step               | Today (TypeScript)                                                                                                         | Source                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Publish            | CI packs `jarvis.module.json`, `dist/` and `sql/` into `<id>-<version>.tgz` on a rolling GitHub release                    | `docs/superpowers/specs/2026-07-12-module-distribution-install.md` §5 |
| Index              | `index.json` with id, version, artifact filename, SHA-256, size, capabilities, previous versions                           | `packages/module-registry/src/distribution/index-schema.ts`           |
| Trust              | One Ed25519 key signs the whole index; per-artifact hashes then cover each tarball                                         | `distribution/catalog-signing.ts`                                     |
| Source             | Index URL and three GitHub hosts are constants; a test-only override is refused in production                              | `distribution/registry-source.ts`                                     |
| Download           | Admin-only, in the API process, size caps, hash check, safe extract, manifest check, atomic rename into the modules folder | `distribution/pipeline.ts`, `extract.ts`, `stage.ts`                  |
| Activate           | Boot supervisor accepts the staged hash, runs owned-table SQL with generated RLS, and auto-enables                         | `scripts/module-reconcile.ts` path, spec §7                           |
| Drift              | A package whose hash changed since enable is disabled automatically                                                        | `external/reconcile.ts`                                               |
| Enable per account | Instance deny-list plus per-user deny-list, where the manifest allows it                                                   | `active-modules-resolver.ts`                                          |
| Run                | Separate Node process, stripped environment, host RPC ports, no OS sandbox                                                 | `external/worker-runtime.ts`, `worker-rpc-host.ts`                    |
| Workshop           | Builds a TypeScript module and installs it as a draft owned by the account that built it                                   | `external/install-draft.ts`                                           |
| Remove             | Remove keeps data; Remove and purge drops tables at the next boot after a typed confirmation                               | spec §9                                                               |

The good parts carry over. The signed index, bare artifact filenames, hash checks, safe extract,
staging, drift detection, keep-data-by-default removal and the per-account deny-list all stay.
What changes is the payload (WebAssembly instead of Node), where it installs (the user's data
folder on every OS), and the trust model. Today one online key signs everything. The new model
adds an offline root key that binds each publisher key to its id prefix (5.3), plus revocation
and rollback protection.

Today's host ports are `kv.*`, `db.query`, `fetch.request`, `ai.generateStructured`, `embed.*`,
`notify.post`, `jobs.enqueue`, `attachments.readText`, `actionPolicy.get` and
`auth.getCredential`/`setCredential`. The new interface starts from that list.

## 3. The module package

### 3.1 What is in one

A package is a file named `<id>-<version>.mosspkg`. It is a tar archive compressed with zstd, with
a fixed layout.

| Path                | Holds                                                                                       | Required             |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| `moss.module.json`  | Manifest, version 2 (3.2)                                                                   | Yes                  |
| `code/module.wasm`  | One WebAssembly component built for the `moss:module` interface (3.3)                       | Yes, unless UI-only  |
| `sql/`              | The module's own migrations, numbered, forward only                                         | Only if it owns data |
| `ui/`               | Static screen files (HTML, CSS, JS or a Leptos wasm bundle) shown in the module frame (3.5) | Only if it has pages |
| `icons/`            | SVG icons named in the manifest, one colour, drawn to the design-system grid                | Yes, at least one    |
| `locales/`          | Optional translated strings                                                                 | No                   |
| `LICENSE`, `NOTICE` | Licence text for the module and anything it bundles                                         | Yes                  |
| `CHANGELOG.md`      | Plain-words change notes, shown on the update screen                                        | Yes                  |

Signatures are not inside the file. They sit next to it as `<file>.sig` and inside the registry
index, so the package bytes and their digest never change after signing. The digest is the
package's identity. The `<id>-<version>` name is for people only and carries no trust; a registry
stores the same bytes as `packages/<digest>.mosspkg`.

Rules for the archive:

- Regular files and folders only. No links, devices, absolute paths or `..` parts.
- Names are lower-case ASCII, so a package unpacks the same on case-insensitive disks.
- Entries are sorted and timestamps zeroed, so the same inputs give the same digest.
- A package with no `code/module.wasm` is UI-only and can still own SQL and screens.

### 3.2 The manifest

Manifest version 2 keeps the meaning of today's `jarvis.module.json` and of the built-in
manifests that the Rust registry reader already loads (Phase 2b). It adds the fields a downloaded
package needs.

| Field                                | Meaning                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                      | `2`                                                                                                      |
| `id`                                 | Bare id for first-party (`tasks`). Third-party ids carry the publisher prefix (`acme.recipes`)           |
| `name`, `description`, `publisher`   | Shown in the registry and Settings                                                                       |
| `version`                            | Semantic version. A version, once published, never changes                                               |
| `requiresMoss`                       | Range of Moss versions it runs on                                                                        |
| `abi`                                | Interface version it targets, for example `moss:module@1` (3.3)                                          |
| `capabilities`                       | Every port it uses and every limit on it (section 5)                                                     |
| `database`                           | Owned tables, migration files, ledger identity (3.6)                                                     |
| `jobs`                               | Queues, schedules and the typed parameter schema for each                                                |
| `routes`                             | HTTP routes the host forwards to it, each with method, path and required sign-in                         |
| `provides`, `requires`               | Public APIs and events it offers, and other modules' APIs it needs with version ranges                   |
| `navigation`, `settings`, `features` | App-map declarations, exactly as today                                                                   |
| `screens`                            | Pages and the `ui/` file each one opens                                                                  |
| `icons`                              | Which icon file is the module icon and which belong to navigation entries                                |
| `accounts`                           | Whether each account may switch it off (today's `supportsUserDisable`), and its default for new accounts |
| `credentials`                        | Named credentials it can ask the host to use, each instance-wide or per account                          |

Unknown fields are refused, not ignored. A downloaded manifest is untrusted input, and silently
dropping a field a newer Moss would enforce is how a limit goes missing.

### 3.3 The code part

The code is one WebAssembly component compiled for `wasm32-wasip2`. One file runs on all three
systems and every CPU, so a package never needs a per-OS build.

- The interface is a WIT world named `moss:module`, versioned. Version 1 is the general ports in
  5.1, built by slices M2 and M2b. The `connectors`, `browser` and `audio` ports are
  built in Phase 5 by the first module that needs each, before that module ports (9.2).
- Each port is its own versioned WIT interface. Adding a port is a minor version (`@1.1`) and
  breaks no package. Changing or removing one is a major version. Version 1 is frozen when the
  first package is published to the Moss registry (M7).
- The host links only the ports a package's manifest declares. At install it reads the
  component's imports and refuses one that imports anything undeclared or anything the host does
  not offer. This runs for every package, whatever registry or file it came from.
- The world imports only Moss ports (section 5). It imports no WASI files, sockets, clocks with
  sub-millisecond resolution, or environment variables.
- It exports handlers for routes, jobs, tool calls, event subscriptions and install hooks.
- The host runs it with wasmtime, with fuel or epoch limits, a memory cap and a per-call deadline.
  Defaults are generous. When a module hits one, Moss shows a warning and the owner can raise it,
  so a limit never silently breaks a feature.
- Compiled machine code is cached per OS and CPU under the cache folder. The cache is rebuilt on
  any doubt and never copied between machines.

Packages carry no native code. Native code would need a sandbox per OS, which plan section 3.4
already rejected. If a first-party module cannot meet its speed budget in WebAssembly, it builds
into the host as a native crate instead, from the same source (section 7). It then ships with Moss
releases rather than through the registry.

### 3.4 Versions

- Package versions are semantic. A new major version may drop public APIs that other modules use.
- `abi` versions are separate. Moss supports the current interface version and the one before it.
  A package for an older one is shown as "needs an update from its publisher".
- `requiresMoss` is checked before download, using today's compatibility-gate idea.

### 3.5 Screens

Module screens open in a sandboxed frame inside the Moss app frame.

- The frame has `sandbox="allow-scripts allow-forms"` and no same-origin permission (forms are allowed so a native submit event reaches the module, while the policy keeps `form-action 'none'` so nothing navigates), so its origin is opaque.
  It cannot read Moss cookies, local storage or the host page.
- Moss serves `ui/` files from a versioned path with a strict content-security policy. The policy
  allows scripts and styles only from that path and the shared Park Press stylesheet, allows
  network requests to that same versioned path only (a Leptos bundle fetches its own `.wasm`
  file), and adds `'wasm-unsafe-eval'` so the bundle can start. Because the frame's origin is
  opaque, these files are served with cross-origin headers that accept the `null` origin. No
  other route accepts it.
- Every `ui/` response also carries `sandbox allow-scripts allow-forms` in that policy header. A person who
  opens the path straight in a tab still gets an opaque origin, so the module's script never runs
  with Moss's own origin, storage or script-readable cookies. The Rust host's session cookie
  must be `HttpOnly`.
- The frame talks to the host through a small typed message bridge. It can call the module's own
  routes, read the theme, ask to navigate, open the chat drawer, and size itself.
- The host injects Park Press tokens and the shared component CSS, so modules look native.
  First-party modules build their screens with a published Leptos component kit that renders the
  same `@moss/ui` markup.
- A screen loads over whatever connection the browser used to reach Moss, so phones and other
  computers see module screens the same way as the host machine (section 6).

### 3.6 SQL owned by the module

- Migration files are numbered and forward only. A published version's files never change. The
  installer refuses a new version that alters a file an older version shipped.
- The host generates RLS for every owned table, as `module-rls-emitter.ts` does today. Owner-only
  is the default. A table that people can share declares `"access": "owner-or-share"` and names
  its share key column in the manifest. The host then generates the owner-or-share rules from the
  host's share model, the same shape Tasks ships today in
  `packages/tasks/sql/0019_tasks_owner_or_share.sql`. New module SQL never writes policies
  itself. Recipient-only tables are not offered in version 1.
- Generated rules force row security on the table owner too, as
  `packages/db/src/module-rls-emitter.ts` does today, so the owner role cannot skip it.
- DDL, generated policies and the ledger row commit in one transaction, through a narrow host
  operation. This closes today's window between DDL and ledger commits (companion doc, rule 9).
- Applied files are hash-checked on every start, not only by version. This is new behaviour the
  companion doc requires.
- New module DDL runs as a per-module owner role that the host creates. That role owns only the
  tables new SQL creates. Its one right on core is `REFERENCES` on `app.users (id)`, for owner
  foreign keys. It has no rights on other modules' tables.
- New SQL passes a parsed-statement check. This covers every third-party file, and every
  first-party file not in the host's compiled inventory (below). Allowed statements are
  `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ... ADD COLUMN`, `ALTER TABLE ... ADD CONSTRAINT`
  and plain data backfills on its own tables. Foreign keys and backfills may reference only the
  module's own tables and a named set of core columns (`app.users.id`). Refused are functions,
  triggers, security-definer anything, grants, roles, extensions, `SET`, references to any other
  table and multiple statements in one string.
- Existing first-party SQL keeps its applied bytes and its current ledger. Two ledgers exist
  today, and the companion doc keeps both:
  - Built-in modules under `packages/<id>/sql` record versions in the core ledger. Their packages
    declare `"ledger": "core-legacy"`.
  - Installed modules (finance, meals) record versions in `app.module_schema_migrations`, which
    hashes the text after a UTF-8 round trip. Their packages declare `"ledger": "module-legacy"`
    and keep that hash rule.
- The legacy exception covers only files listed, by name and hash, in an inventory compiled into
  the host release. Those files may use functions and triggers, because they were reviewed as
  part of Moss. A package signed with the first-party key gets no other exception. Any first-party
  file not in the compiled inventory goes through the parsed-statement check like third-party
  SQL, or waits for a host release that adds it to the inventory.
- Inventory files run exactly as today: as the existing migration role, with the policies,
  runtime-role names, core functions (such as `app.has_share`) and row-security switches they
  already contain. The host generates no rules for tables those files create, so nothing doubles
  up. Generated rules and the restricted owner role apply only to tables made by new SQL. When a
  legacy module later adds a new table, that table is declared in the manifest, created by new
  SQL, and gets generated rules like any other.
- A new version that adds any migration file is treated as asking for more (4.4), so it waits
  for an admin rather than installing on its own.

### 3.7 Installing with no admin rights

Everything lives under Moss's data folder from plan section 3.10. Nothing touches system folders,
the Windows registry, `/usr` or `/Applications`.

| Folder                                    | Holds                                                        |
| ----------------------------------------- | ------------------------------------------------------------ |
| `<data>/modules/blobs/sha256/<digest>`    | Downloaded package files, named by digest, read-only         |
| `<data>/modules/installed/<id>/<version>` | Unpacked package, read-only after unpacking                  |
| `<data>/modules/staging/`                 | Downloads and unpacks in progress, swept at start            |
| `<data>/modules/snapshots/<id>/`          | Per-module snapshots taken before upgrades and data deletion |
| `<data>/modules/files/<id>/`              | Files the module writes through its vault area, per account  |
| `<cache>/modules/compiled/`               | Compiled machine code, safe to delete                        |

The data folder is `%LOCALAPPDATA%\Moss` on Windows, `~/Library/Application Support/Moss` on macOS
and `$XDG_DATA_HOME/moss` on Linux. A server install uses its service account's data folder. The
package needs no write access outside these folders, so a normal user account is enough on every
system.

Which version is current is a database row, not a link on disk, so switching versions is one
transaction and works the same on Windows, where open files cannot be replaced.

### 3.8 Upgrading without losing data

1. Download and verify the new version into staging (4.3).
2. Show the update screen if the new version asks for more than the old one (5.4). Otherwise
   continue, subject to the update setting.
3. Fence the module. New calls wait, running calls finish, its queued jobs pause.
4. Snapshot the module's owned tables, its key-value rows and its files folder.
5. Apply only the new migration files, in one transaction with their policies and ledger rows.
6. Point the current-version row at the new version and start it.
7. Run its health check. On failure, roll back (below) and leave the old version running.

Rolling back:

- If the new version applied no migrations, Moss switches back to the old version with no data
  change.
- If it did, Moss restores the snapshot from step 4 and switches back. Writes made by the new
  version after the upgrade are lost, and the screen says so before the owner confirms.
- The previous version's files stay installed until the next successful upgrade, so rollback
  works offline.

The module never restarts Moss. WebAssembly instances can be swapped in place, which removes
today's "restart to apply" step.

### 3.9 Removing

- **Remove** is the default. It stops the module, deletes its code, and keeps its tables,
  key-value rows, files and credentials. Reinstalling picks up where it left off, because the
  ledger skips migrations already applied.
- **Remove and delete its data** needs the module name typed to confirm. Moss takes a final
  snapshot, then drops the module's tables, roles, ledger rows, key-value rows, credentials and
  files. The snapshot stays for 30 days and can be restored from the same screen. It holds every
  account's data for that module, and the confirm screen says so. Open question 7 asks Ben to rule
  on this.
- An account switching a module off is never a removal. It hides the module for that account and
  stops its jobs for that account. The data stays.

## 4. The download registry

### 4.1 What a registry is

A registry is a folder of static files on any HTTPS host, or on disk.

| File                            | Holds                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `registry.json`                 | Name, id, root key fingerprint, index signing keys, publisher keys with prefixes |
| `registry.json.sig`             | Root-key signature over `registry.json`                                          |
| `index.json`                    | Every module, every published version, digests, sizes, capabilities, revocations |
| `index.json.sig`                | Signing-key signature over `index.json`                                          |
| `packages/<digest>.mosspkg`     | Package files, named by SHA-256 digest                                           |
| `packages/<digest>.mosspkg.sig` | Publisher signature over the digest                                              |
| `media/<digest>.<ext>`          | Optional screenshots, named by digest                                            |

Index entry fields per version are id, version, digest, size, publisher key id, publisher
signature, `requiresMoss`, `abi`, the capability summary, the changelog excerpt, and a channel
(`stable` or `preview`). The index also carries a `serial` number that only goes up, an
`expires` time, and a `revoked` list.

A static layout was chosen over a registry server because anyone can host it. GitHub Releases, a
plain web server, an object store, a shared folder or a USB stick all work, and an offline copy
is just the folder.

### 4.2 Compared with Docker

| Docker                                  | Moss modules                                                             |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Image                                   | Package (`.mosspkg`)                                                     |
| Layers, content-addressed               | One blob per package, content-addressed by SHA-256                       |
| Registry HTTP API with tokens           | Static signed index plus files; no server code, no tokens for public use |
| Tag (mutable) and digest (immutable)    | Version (never reused) and digest; the index maps one to the other       |
| `docker pull name@sha256:...` pin       | Pin by version, and Moss records the digest it installed                 |
| Content trust or cosign signatures      | Publisher Ed25519 signature per package plus a signed index              |
| Daemon running as root                  | Runs as the signed-in user; no admin rights                              |
| Container isolation through the kernel  | WebAssembly component with only Moss ports linked                        |
| Volumes survive a new image             | Module tables, key-value rows and files survive a new version            |
| Compose file lists services             | Module list file lists modules and pins (4.7)                            |
| Pull-through mirror, `docker save/load` | Self-hosted registry copy, package file import                           |

Moss does not use the OCI registry protocol in version 1. It would let packages sit in any
container registry, but it brings token exchange and a heavier client for no gain to a household
install. A later slice can add an OCI source type that reads the same packages.

### 4.3 Fetch and verify

1. Fetch `registry.json` and its signature. Check the root key against the key Moss trusts for
   that registry.
2. Fetch `index.json` and its signature. Check it with a signing key that `registry.json` lists.
3. Refuse the index if its `serial` is lower than the highest one this install has seen for that
   registry. This stops an attacker from replaying an old index that still lists a revoked package.
4. If the index is past `expires`, allow nothing new from that registry and show why. Installed
   modules keep running.
5. Pick the version. Check `requiresMoss`, `abi` and dependencies before any download.
6. Download `packages/<digest>.mosspkg` with a size cap of the index size. Hash while streaming.
   Refuse on a size or digest mismatch.
7. Check the publisher signature over the digest. The key must be one that `registry.json`
   (signed by the root key) binds to this module's id prefix, and, for an update, the same key
   that signed the installed version unless the root key approved a replacement (5.3).
8. Unpack into staging with today's safe-extract rules, plus the archive rules in 3.1.
9. Check the manifest against the index entry. Id, version, capabilities and SQL file list must
   match exactly. Then run the install-time checks, which do not trust the publisher's own
   checks: the component's imports against the manifest (3.3), the SQL against its tier (3.6),
   and the manifest for provider or model names.
10. Move the unpacked folder into `installed/<id>/<version>` and record the digest.

Every check fails closed. A failure names the step in plain words and leaves the installed
modules untouched.

### 4.4 Pins and updates

- Moss records the exact digest of every installed version. A changed file on disk disables the
  module, as drift does today.
- An admin can pin a module to a version. A pinned module never updates by itself.
- Moss checks registries once a day, at start, and when someone opens the module screens.
- Default update setting is "automatic when nothing new is asked". An update that keeps or
  narrows capabilities and adds no migration file installs at a quiet time. One that asks for
  more, or adds a migration file, waits on the update screen for an admin.
- Security updates marked `urgent` in the index install as soon as they are seen, under the same
  rule. An urgent update that asks for more or adds a migration file still waits for an admin,
  and the update screen marks it urgent.

### 4.5 Offline and self-hosted registries

- **Package file import.** An admin can pick a `.mosspkg` and its `.sig` from disk. The
  publisher key must be one that a registry this install already trusts binds to the module's
  id prefix (step 7). The file then goes through step 5, step 8, the install-time checks of
  step 9 without the index comparison, and step 10.
- **Offline registry folder.** Any registry folder can be added by path. Moss verifies it exactly
  like a remote one.
- **Self-hosted registry.** An admin adds a registry by URL. Moss shows the root key fingerprint
  and the registry's name, and the admin confirms it, once. Later key changes must be signed by
  that root key.
- **Mirror.** A `moss registry mirror` command copies a registry folder, signatures included, so a
  household or company can serve it locally. A mirror cannot change anything without breaking the
  signatures.
- Several registries can be active. The same id from two registries is refused unless both point
  at the same publisher key.
- Bare ids belong to the Moss first-party key compiled into the host, in every registry. A
  self-hosted root key cannot bind any key to bare ids, and Moss refuses one that tries.

### 4.6 How first-party modules ship

- The Moss registry (the default, run by the project) carries every first-party module and any
  third-party module that passed review (5.5).
- Each Moss release bundles the current first-party packages inside the installer, with their
  signatures. A fresh install unpacks them into the blob store and installs the default set
  without any network.
- After that, first-party modules update through the registry like any other. A Moss release is
  needed for host changes, and for new first-party SQL that needs the legacy exception (3.6).
- Bundled packages are checked against the publisher signature and a list of bundled digests
  compiled into the release, then run the install-time checks of 4.3 step 9. They skip only the
  index steps (1 to 4), so an offline fresh install works even when the release is older than
  any index expiry. Once Moss reaches the registry, the index's revocation list applies to them
  like any other package.
- Which first-party modules are on by default stays as today's manifests say (`lifecycle`).
  Optional ones, such as finance and meals, are bundled but not installed until someone asks.

### 4.7 Module list file

A module list names modules and optional pins, like today's `JARVIS_MODULES_ENSURE` setting and
like a compose file.

- Settings can export the current list and import one, so a new machine can match an old one.
- A server install may also read one at first start.
- It only adds. Removing a name from the list never removes a module or data.
- It is never required. Every action it can do has a button in the app.

## 5. Trust and safety

### 5.1 What a module may touch

| Port           | What it allows                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `db`           | Typed queries on its own tables only, run by the host inside the caller's data context. The host sets the actor; the module never can.     |
| `kv`           | Its own key-value namespaces, per account or install-wide as declared                                                                      |
| `vault`        | Its own files folder through the vault context. Reading the account's notes needs a declared `vault.notes.read` capability                 |
| `fetch`        | HTTPS to declared hosts only. The host resolves DNS, refuses private addresses unless declared, and follows redirects only within the list |
| `credentials`  | Brokered requests to the hosts bound to each credential. The module never sees the value (see below)                                       |
| `ai`           | Capability requests (summarize, structured output and so on). The router picks the account's model; the module never names a provider      |
| `embed`        | Embeddings through the host's embedding service                                                                                            |
| `jobs`         | Enqueue on its own declared queues, with the declared typed parameters only                                                                |
| `events`       | Publish its declared events; subscribe to other modules' public events                                                                     |
| `api`          | Call public APIs of modules listed in `requires`                                                                                           |
| `notify`       | Post notifications to the account that triggered the call                                                                                  |
| `attachments`  | Read attachments the account handed to it                                                                                                  |
| `tools`        | Offer chat tools with declared risk levels, run under today's approval rules                                                               |
| `actionPolicy` | Read the account's approval policy for its own tools, as today                                                                             |
| `connectors`   | Brokered calls through the host's connectors, so OAuth tokens stay in the host. Built in Phase 5 (`@1.x`)                                  |
| `browser`      | A headless browser render of a declared host, for sports. Built in Phase 5 (`@1.x`)                                                        |
| `audio`        | Audio from the companion apps, for meetings. Built in Phase 5 (`@1.x`)                                                                     |

Brokered credentials follow decision 7.11 of the plan, and work like this:

- Each credential in the manifest names the exact hosts it may go to and how it is attached: a
  named header, a basic-auth pair, or a named body field. The host refuses to attach it to any
  other host or in any other way, so a module cannot send a credential to a host it controls.
- An OAuth-style token exchange runs in the host. The manifest declares the token endpoint and
  grant type. The host sends the client id and secret, stores the tokens it gets back as a new
  credential, refreshes them, and strips them from the response the module sees. This replaces
  today's `auth.setCredential` for minted tokens.
- Finance today reads its client id and secret and stores minted tokens itself
  (`external-modules/finance/src/worker/auth-port.ts`). Its port uses the host exchange above.
  If slice M12 finds an exchange the host cannot express, decision 7.11's exception applies to
  finance only: a `credentials.read` capability, first-party key only, shown on the install
  screen, with the sentinel tests narrowed to the surfaces it does not cover.
- Request signing (for example HMAC over the body) is not offered in version 1. A module that
  needs it gets a named port, reviewed like any other.

A module cannot listen on a network port. Inbound traffic reaches it only through declared routes,
which the host serves under `/api/m/<id>/...` after sign-in and route checks.

A module gets no clock finer than a millisecond, no random device beyond the host's, no threads,
no environment and no file system outside the vault port.

A real need beyond this list becomes a new named port, reviewed and added to the interface. It
never becomes a native escape hatch. The `connectors`, `browser` and `audio` ports above are the
known first-party needs. They are built in Phase 5, likely after version 1 freezes, so they
arrive as minor additions (`@1.x`) that break no package.

### 5.2 How the hard invariants hold for downloaded code

| Invariant                         | How it holds                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No admin private-data bypass      | Modules run under per-module runtime roles with `NOBYPASSRLS`. Admin installs a module; that gives no read of anyone's data                                                                                                |
| Private by default                | Generated owner-only RLS on every owned table. Shared tables are declared and get generated owner-or-share rules from the host's share model, never new module SQL. Legacy inventory files keep their own rules (3.6)      |
| Data only through a data context  | The `db` port opens the caller's data context. A module has no connection, no pool and no way to name another role                                                                                                         |
| Vault only through `VaultContext` | The `vault` port is the only file access. WebAssembly has no other file import linked                                                                                                                                      |
| Secrets never escape              | Brokered credentials bound to hosts, and tokens kept in the host. Values never enter the guest unless decision 7.11's finance exception is used. Sentinel tests plant a marker credential and inspect every module surface |
| Metadata-only job payloads        | The host builds payloads from the declared typed schema, using the Phase 2b contract kinds. Free text is not a kind                                                                                                        |
| `AccessContext` stays two fields  | The host builds the actor. Modules receive an opaque call handle, not the context                                                                                                                                          |
| Provider-agnostic AI              | The `ai` port takes capabilities only. Publish review and the install-time check refuse provider or model names in the manifest                                                                                            |
| Module isolation                  | Only linked ports exist. Cross-module calls go through declared public APIs and events. SQL that references another module's tables is refused at install                                                                  |
| Never edit an applied migration   | Published SQL files are immutable; changed bytes are refused at publish and at install; applied files are hash-checked at every start                                                                                      |
| Secrets in prompts                | AI calls go through the host router, which applies today's prompt rules. Credentials are not reachable from the guest, except under decision 7.11's finance exception                                                      |

### 5.3 Signing keys

| Key               | Signs                                        | Held by                                                           |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Registry root key | `registry.json` (which keys are valid)       | Offline, by the registry owner. For the Moss registry, Ben        |
| Index signing key | `index.json`                                 | The publishing pipeline                                           |
| Publisher key     | Each package digest                          | The publisher. For first-party modules, the Moss release pipeline |
| Install-local key | Local packages, `local.<account>.*` ids only | This install's keychain                                           |

Publisher keys live in `registry.json`, each bound to the id prefix it may sign (the Moss
first-party key to bare ids, `acme` to `acme.*`). Only the offline root key can add, bind or
replace one. A stolen index signing key can sign a fresh index with a higher serial, so it can
hide entries or offer an older signed version. It cannot sign a package for any module, and it
cannot lift a revocation (5.6). Moss also remembers which
publisher key signed each installed module, and refuses an update signed by a different key unless
the root key approved the replacement.

The root key rotates the others without a Moss release. Moss ships with the Moss registry's root
key fingerprint compiled in, as today's catalog keys are. Today's two catalog keys stay trusted
for the TypeScript catalog only.

### 5.4 Permissions people see

- The install screen lists capabilities in plain words, grouped as data, network, AI, files and
  chat tools. Table names and hosts appear as detail, not as the headline.
- Installing approves normal use for the whole install. Destructive tools still ask at use time,
  per today's rules.
- An update that adds a capability waits for an admin. The screen shows only what is new.
- Settings shows, per module, what it touched recently: hosts called, AI calls, jobs run. This is
  the module's own activity log, shown to each account for its own data.

### 5.5 Review

- **Automatic checks at publish,** run by the pipeline for every registry that uses Moss's tools.
  The host repeats the import, SQL and name checks at install (4.3 step 9), so a self-hosted
  registry or a local file cannot skip them.
  The manifest must be valid. The WebAssembly imports must match declared capabilities. SQL must
  pass the third-party subset (or carry the first-party key). The archive must be clean, and no
  provider or model names may appear.
- **Capability diff.** Each new version's capabilities are compared with the last one, and any
  growth is marked in the index.
- **Human review for the Moss registry,** required for a new publisher, a new capability, or a new
  fetch host. Other changes publish after automatic checks.
- Self-hosted registries set their own review. Moss shows which registry a module came from on
  every screen that names it.

### 5.6 Revocation

- The index carries a `revoked` list of package digests and publisher keys, each with a reason
  and a level.
- **Block** disables the module for every account at once and keeps its data. Admins see why.
- **Warn** keeps it running and shows a notice with the reason.
- Moss applies revocations from the cached index at start, so a machine that goes offline after
  seeing a revocation keeps it.
- A revoked publisher key blocks every package it signed, unless a later version is signed by a
  replacement key the root key approved.
- Once seen, a revocation stays in force on this install. A later index that drops it changes
  nothing. Only a statement signed by the registry's root key can lift it.
- Rollback protection (4.3 step 3) also stops an old index from being replayed.

## 6. Several accounts and other devices

- **Installed per machine.** One install holds one copy of each module version. An admin installs
  and removes, because that is configuration power.
- **Enabled per account.** An installed module starts on or off for each account as the
  manifest's `accounts` default says. Each account can switch it for itself unless the manifest
  forbids switching it off, as today's deny-list does. An admin can turn it off install-wide, which wins for everyone.
- **Data per account.** RLS keeps each account's rows separate. Module files sit in a folder per
  account under the module's files folder.
- **Accounts that are not admins** can ask an admin to install a module from the browse screen.
  They can also install packages they built on this machine for themselves only, as Workshop
  drafts work today. Such a package gets a `local.<account>.*` id, runs only for that account,
  and records which account installed it. Open question 8 asks Ben whether this stays now that
  Workshop is not ported.
- **Other devices.** Modules run on the Moss host. A phone or another computer reaches module
  screens through the same Moss address it already uses, over the home network, the tailnet or
  HTTPS. The browser never contacts a registry. Downloads, verification and updates all happen on
  the host.
- **Remote sign-in.** Module routes sit behind the host's sign-in and trusted-origin checks, so
  remote access needs nothing new from a module.
- **Two installs.** A desktop and a home server are separate installs. The module list file (4.7)
  copies a set of modules from one to the other.
- **Shared-install notice.** On a desktop where all accounts share one OS user, module data is as
  protected as other Moss data and no more. The existing notice covers it.

## 7. The rule for Phase 5 builders

Every ported in-repo feature module is built as a package from the start. It may ship bundled
with Moss at first, but its source must be ready to publish with no rewrite.

1. **One folder per module.** `modules/<id>/` holds `moss.module.json`, `ui/`, `icons/`,
   `CHANGELOG.md` and a Rust crate in `src/`. New SQL files go in `modules/<id>/sql/`.
2. **Existing SQL stays where it is, byte for byte.** The TypeScript migration runner reads
   `packages/<id>/sql` and must keep working through cutover and its support window, so these
   files are never moved or edited. The package build reads them from there and checks each one
   against the compiled inventory by hash. Modules from `packages/` declare
   `"ledger": "core-legacy"`; finance and meals declare `"ledger": "module-legacy"` (3.6).
3. **The crate depends on the module SDK only.** Allowed dependencies are `moss-module-sdk`, other
   modules' published API crates, and pure crates that build for `wasm32-wasip2` (serde, chrono
   and the like). No host crates, no async runtime, no `std::fs`, no `std::net`, no threads.
4. **All host access goes through SDK traits.** Those traits mirror the `moss:module` ports. A
   build check fails on any other edge, extending the Phase 2b boundary check.
5. **Build both ways in CI.** The crate builds natively for tests and as a `wasm32-wasip2`
   component. Both builds run the module's tests. The WebAssembly build is the shipped form unless
   the module is on the native list (rule 10).
6. **Screens live in `ui/`.** They render in the module frame and talk through the bridge. They
   use the published Leptos component kit and Park Press classes, never host-internal components.
7. **Other modules only through `requires`.** Calls go to declared public APIs, and data comes
   from declared events. No reading another module's tables, as today.
8. **Jobs use typed parameters.** Each queue declares its parameter schema in the manifest, from
   the Phase 2b contract kinds.
9. **App-map declarations live in the manifest.** Navigation, settings and features are kept in
   the same PR as the screen they describe.
10. **Native only by measurement.** A module may build into the host natively only if its
    WebAssembly build misses the speed budget set in slice M3. The exception is recorded in the
    Phase 5 plan with the measurement, and the source still follows rules 1 to 9.

Core areas are not modules and stay in the host. They are sign-in and accounts, settings frame,
chat and agents, memory and embeddings, vault, AI router, connectors framework, notifications,
job queue, app map, workflows, structured state and the Today shell. The first Phase 5 plan
confirms this split in a table, with a stated reason for each core area. The starting
proposal for Phase 5 packaged modules is backtrack, briefings, calendar, commitments, email,
goals, meetings, news, notes, people, scratchpad, sports, tasks, weather, web research and
wellness. Finance and meals follow the same rule in Phase 6 (slice M12). Finance, meals,
wellness, sports and news port as they are, with no redesign.

Workshop and Food are not ported (Ben, 2026-11-07). Both will be redone later, most likely as
downloadable packages under this spec, so the Phase 5 lists leave them out.

Calendar and email use connectors. They reach them through a brokered `connectors` port, so OAuth
tokens stay in the host.

Tasks was ported in Phase 0b as a plain native crate. Slice M3 moves it onto this rule first and
uses it to set the speed budget.

## 8. Screens

These are the screens the work needs. None get built before Ben agrees mockups. Each one adds its
app-map entries in the same PR.

| #   | Screen                   | Does                                                                                        |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- |
| S1  | Modules (installed)      | Lists installed modules with status, version, update badge, and the per-account switch      |
| S2  | Browse                   | Searches the registries, with filters for first-party, category and source                  |
| S3  | Module detail            | Description, publisher, source registry, version, what it can touch, changelog, screenshots |
| S4  | Install review           | Capabilities in plain words, then Install                                                   |
| S5  | Progress and result      | Downloading, checking, setting up data, done, or a plain failure reason with Retry          |
| S6  | Update review            | What is new, with only the added capabilities, plus Update or Skip                          |
| S7  | Remove                   | Remove keeps data. Remove and delete data needs the name typed                              |
| S8  | Restore                  | Restores a snapshot after a failed update or within 30 days of data deletion                |
| S9  | Registries               | Adds a self-hosted registry with its key fingerprint, imports a file, shows registry health |
| S10 | Blocked or warned notice | Banner and detail when a module is revoked                                                  |
| S11 | Request to install       | Lets an account that is not an admin ask an admin for a module                              |

Open questions for Ben, each with the answer this spec assumes until he rules:

1. **Where browsing lives.** Assumed: Settings → Modules, with the module header cog linking to
   each module's own page. The alternative is a top-level "Modules" place in navigation.
2. **Automatic updates.** Assumed: on by default when nothing new is asked. The alternative is
   asking before every update.
3. **Third-party registries.** Assumed: allowed, added by an admin in S9, with no extra switch to
   turn them on.
4. **Screenshots in the catalog.** Assumed: yes, up to four per version.
5. **Requests from accounts that are not admins.** Assumed: a request goes to the admins as a
   notification. The alternative is no request flow at all.
6. **Module activity log.** Assumed: a short "recently" section on S3 for installed modules. The
   alternative is a separate page.
7. **Snapshot after "Remove and delete its data".** Assumed: kept 30 days, holding every
   account's data for that module, and the confirm screen says so. The alternative is deleting
   at once with no snapshot.
8. **Local packages from accounts that are not admins.** Assumed: kept, private to the account
   that installed them, under `local.<account>.*` ids (slice M11). The alternative is admin-only
   local install, or dropping local packages until Workshop is redone.

## 9. Slices and where they sit in the plan

### 9.1 New phase order

| Phase | What                                                                    | Depends on |
| ----- | ----------------------------------------------------------------------- | ---------- |
| 4b    | Module host and package format: slices M1 to M5, with M2b               | 2, 4       |
| 5     | In-repo modules, each built to the section 7 rule; M6 to M8 alongside   | 2, 3, 4b   |
| 6     | Registry screens, review, revocation, local packages, finance and meals | 4b, 5      |
| 7     | Installers bundle the first-party packages (4.6)                        | 1, 2, M7   |

Phase 4b moves earlier than Phase 6 because Phase 5 builders need the SDK, the interface and the
installer before they write the first module. The registry client and publishing (M6, M7) can run
beside Phase 5, because bundled packages need them only at Phase 7. M7's gate uses a stand-in
installer, a script that lays out a fresh data folder with the bundled packages; the real
installers prove it again in Phase 7.

Three ports are built inside Phase 5, each as its own slice before the first module that needs
it. The `connectors` port comes before calendar and email, `browser` before sports, and `audio`
before meetings. Each gets the same escape-probe gate as M2.

### 9.2 Slices

Sizes are complexity. Every gate is a measurement that ends with a go plan, never a quiet stop.

| Slice | Builds                                                                                                                                                                                               | Size | Kill gate                                                                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | Package format and manifest v2: schema, pack, inspect and verify commands, deterministic digests                                                                                                     | S    | Same inputs give the same digest on all three systems. Links, `..`, absolute paths, upper-case names and unknown fields are each refused, each with a negative control                                                                                                                       |
| M2    | WebAssembly host and interface v1: wasmtime host, `moss:module@1` WIT world, ports `kv`, `db`, `jobs`, `fetch`, `ai`, `notify`, limits                                                               | M    | Escape probes (file open, socket, role switch, actor change, multi-statement, cross-module table, undeclared host, private address) are all refused, each seen passing with its guard removed                                                                                                |
| M2b   | The other general ports: `vault`, `credentials` (host binding and token exchange), `embed`, `events`, `api`, `attachments`, `tools`, `actionPolicy`                                                  | M    | Escape probes for each (other account's vault, credential to an unbound host, token visible in a response, undeclared event or API) are refused, each seen passing with its guard removed                                                                                                    |
| M3    | Module SDK, both builds, and Tasks moved onto the rule. Until M4 lands, Tasks' tables come up through the existing native migration path                                                             | M    | Tasks passes its parity checks as a WebAssembly component. The speed budget is set here, as p95 route time and job time against the native build. If it misses, record the gap and fix the host or mark Tasks native                                                                         |
| M4    | Installer: install, upgrade, rollback, remove, delete data, restore; SQL subset check; compiled inventory; install-time import check; one-transaction DDL and ledger; generated owner-or-share rules | M    | A crash between DDL and ledger leaves nothing half-done. Uninstall then reinstall keeps every row. A failed upgrade restores the snapshot. Each SQL refusal and an undeclared import each have a test. Tasks' legacy SQL runs unchanged and its shared lists still share                     |
| M5    | Module frame and bridge, Leptos component kit, Tasks screen in the frame                                                                                                                             | M    | Ben's look check on a phone and a desktop for Tasks in the frame. The frame, and the screen path opened straight in a tab, cannot read host cookies or storage, proved by tests that fail with the sandbox removed                                                                           |
| M6    | Registry client: index and key checks, serial and expiry, digest and publisher checks, pins, cache, file import, folder and URL registries                                                           | M    | Tampered index, tampered package, wrong publisher, publisher key outside its prefix, changed publisher key on update, replayed old index, expired index and revoked digest each fail closed with a named reason. A new higher-serial index that drops a revocation leaves the module blocked |
| M7    | Publishing: CI builds and signs first-party packages, publishes the static Moss registry, bundles packages for installers                                                                            | S    | A fresh install from the stand-in installer, with no network and a past-expiry index, has the default modules. The same install online picks up a newer published version, and the capability rule holds                                                                                     |
| M8    | Several accounts and remote: per-account switches, install-wide off, module screens from a phone over the home network and tailnet                                                                   | S    | Two accounts on one install see only their own module data. A phone opens a module screen remotely and its routes refuse a request with no session                                                                                                                                           |
| M9    | Screens S1 to S11 after Ben's mockups                                                                                                                                                                | M    | Live-path proof on a dev install: browse, install, update with a new capability, remove, delete data and restore                                                                                                                                                                             |
| M10   | Review and revocation: capability diff, publish checks, revocation handling, activity log                                                                                                            | S    | A revoked module stops for every account at the next index read, and stays stopped after going offline                                                                                                                                                                                       |
| M11   | Local packages: install a package built on this machine, signed with the install-local key, private to its builder                                                                                   | S    | A locally built package installs privately for its builder and passes the same checks as a downloaded package                                                                                                                                                                                |
| M12   | Finance and meals ported as packages, as they are, with no redesign                                                                                                                                  | M    | Finance passes its tests as a package, on its existing `module-legacy` ledger, with its token exchange run by the host. If a port cannot express what finance needs, add the port (or use the 7.11 exception, 5.1) before porting meals                                                      |

### 9.3 If a gate misses

- **M2 escape probe fails.** Fix the port and rerun before any module ports start. No module ships
  on a host with a known escape.
- **M3 speed budget misses for Tasks.** First tune the host (instance reuse, compiled cache,
  batch database calls). If it still misses, Tasks builds native under rule 10, and the budget is
  remeasured on the next two ported modules before deciding the default.
- **M5 look check fails.** Change the frame (sizing, scroll, focus), not the rule. If the frame
  cannot pass, first-party screens render in the host from the same Leptos source, and third-party
  screens stay in the frame.

## 10. Not covered

- A paid marketplace, ratings or reviews by users. Each would need its own spec.
- OCI registry support (4.2), left for a later slice.
- Native code in packages (3.3).
- Moving today's TypeScript installed modules. The companion doc keeps their data disabled and
  archived until the new package of the same module is installed.
