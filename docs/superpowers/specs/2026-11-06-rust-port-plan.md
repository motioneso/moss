# Plan: rewrite Moss as one Rust application for Windows, macOS and Linux

- **Status:** plan for review. No code, no app changes.
- **Route:** full rewrite of server and UI in Rust. Ben ruled this on 2026-11-06.
- **Companion doc:** `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`
  (task JS-32) sets the detailed rules for data, keys, install and cutover. Where the two overlap,
  that doc owns the rule and this plan points to it. It lands in its own pull request, which should
  merge before or with this one.
- **Grounded on:** `main` at `1cb86c8b2`. Every count below comes from that tree.

## 1. Summary

Ben has chosen to rebuild Moss from scratch in Rust, both the server and the screens, so it can be
installed as a normal program on Windows, Mac and Linux. Today Moss runs as a set of Docker
containers on a Linux server. After the rewrite it would be one program people download and
double-click, and it could still run on a home server.

What it will take:

- **Size.** Moss today is about half a million lines of code plus more than that again in tests.
  All of it gets rewritten. This is the largest piece of work the project has taken on. The deferred
  desktop-install plan, which kept the TypeScript code, was already sized XL.
- **Tests.** Almost all of today's tests call the TypeScript code directly, so they cannot judge the
  Rust code. A new test harness must send the same requests to the old and new programs and compare
  the answers. Building that harness is part of the work, not a side job.
- **What carries over.** The database design and its privacy rules, the stored data, the look and
  feel (colours, type, spacing), and the way the app talks to its phone and Mac companions all
  stay. The program code does not.
- **Privacy on a desktop.** A desktop install serves one account until Moss can stop one person's
  chat agent reading another person's files on the same computer. Households share Moss through a
  server install until then.
- **What is and is not encrypted.** Connection passwords and AI keys stay encrypted, with the key
  held by the operating system's keychain on desktop. The main database and the notes folder are not
  encrypted by Moss today, and the rewrite does not change that unless the disk itself is encrypted.
- **What breaks.** Add-on modules written for today's Moss stop working and must be rebuilt in a
  new, safer format. Moss's own module builder must learn that format too.
- **Risk.** The danger is not that Rust can't do the job. The danger is that a rewrite this big
  takes so long that the old app keeps moving and the new one never catches up. The plan fights
  that with a stop-or-go check at every phase and a freeze on big new features once core work
  starts.
- **Biggest unknown.** Nobody knows yet how fast Moss can be rebuilt, or whether the existing
  tests can be rebuilt cheaply enough to prove the new program behaves the same. The first step is
  an experiment that rebuilds one real feature end to end and measures both. If that experiment
  goes badly, the plan stops there, before any large spend.

## 2. What a Rust application on three systems means

### 2.1 The chosen shape

| Part            | Today                                                    | After the rewrite                                                                       |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Server          | Fastify API, pg-boss worker, CLI-runner sidecar, scripts | One Rust program with internal services: web server, job runner, agent runner, migrator |
| Screens         | React 19 app built by Vite, served as static files       | Rust UI compiled to WebAssembly, served by the same program to any browser              |
| Desktop         | None (browser only)                                      | Rust desktop shell (tray, window, start at login) that opens the same UI                |
| Database        | Postgres with pgvector in Docker                         | Same Postgres and pgvector, bundled and managed by Moss on desktop (see 3.2)            |
| Add-on modules  | Node processes over JSON-RPC, React bundles in the host  | WebAssembly components with the same host ports, UI in a sandboxed frame (see 3.4)      |
| Server installs | Docker Compose                                           | Same program as a Linux service or a Docker image                                       |

The UI stays a browser UI on purpose. Phones and other household devices reach Moss through a
browser today, and a native-only toolkit would remove that. Compiling a Rust UI to WebAssembly keeps
"Rust everywhere" and keeps phone access.

The other routes (a Rust server keeping the React UI, or replacing pieces one at a time behind the
live app) were set aside by Ben's ruling and are not planned here.

### 2.2 What exists today

| Thing                        | Count                                                          | Source                                                          |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Workspace packages           | 46 in `packages/`, 5 in `apps/`, 3 in `external-modules/`      | `ls packages apps external-modules`                             |
| Module manifests (in repo)   | 28                                                             | `packages/*/src/manifest*.ts`                                   |
| TypeScript, non-test         | about 519,000 lines                                            | `git ls-files '*.ts' '*.tsx'`                                   |
| TypeScript tests             | about 625,000 lines in 2,581 files                             | same, `*.test.ts`, `*.spec.ts`                                  |
| Web app source               | about 59,000 lines; about 400 non-test `.tsx` files repo-wide  | `apps/web/src`; `git ls-files '*.tsx'` minus tests              |
| CSS outside docs and mockups | about 38,000 lines                                             | `*.css`                                                         |
| Core screens and settings    | 28 distinct paths in 77 path entries                           | `packages/shared/src/app-map-core.ts`                           |
| SQL files                    | 35 core, 381 module-owned, about 19,400 lines                  | `infra/postgres/`, `packages/*/sql/`, `external-modules/*/sql/` |
| Row-level security           | 121 files enable it, 633 policies                              | `CREATE POLICY` across all SQL                                  |
| Database functions           | 84 PL/pgSQL, 93 security-definer, 51 triggers                  | same                                                            |
| JavaScript data backfills    | 2, part of the migration hash                                  | `packages/meetings/sql/0280_*.backfill.mjs`, `0292_*`           |
| API paths                    | 430 to 570 `/api/...` strings, by counting method              | distinct strings vs all declarations in `apps/api`, `packages/` |
| Job queues                   | 70 to 75 named queues, 17 to 44 schedules, by counting method  | queue and cron constants in `packages/jobs/src`, worker file    |
| Integration tests            | 538 `.ts` files; 500 import repo packages; 178 call in-process | `tests/integration`; imports and `.inject(` calls               |
| Browser tests                | 55 specs, tied to today's React page structure                 | `tests/e2e`                                                     |
| Prod containers              | Postgres, migrate, module install, app, sports renderer, Caddy | `infra/docker-compose.prod.yml`                                 |

### 2.3 Kept, rewritten, thrown away

| Kept as is                                               | Rewritten in Rust                                        | Thrown away                                                    |
| -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Every applied SQL file, byte for byte                    | API, worker, CLI runner, migrator, module host           | The Node runtime, pnpm workspace, Vite build                   |
| Database roles, RLS policies, database functions         | All repositories and services in `packages/*`            | React components (about 400 files), TanStack Query, the router |
| Stored data, vault files, encrypted credentials and keys | Auth (better-auth has no Rust equivalent)                | Nearly all of the 625,000 lines of TypeScript tests            |
| The HTTP API contract companions and agents depend on    | Every screen                                             | Node module SDK and the web module SDK                         |
| Park Press design tokens and CSS                         | The two JavaScript backfills, as tested Rust equivalents | tmux and setpriv as required parts of chat                     |
| The SQL-level RLS checks, as test cases to re-drive      | Workshop's module builder output; a new parity harness   |                                                                |

Keeping the HTTP API contract is a choice inside the rewrite, not a half-step. The Mac Trail
Marker app (`apps/trail-marker`), the Android companion and the agents' tool calls all speak it.
Keeping it means they keep working at cutover, and it gives a fixed target to test against.

Very few of today's tests can judge the Rust server as they stand. Of 538 integration test files,
500 import TypeScript packages and 178 call the Fastify server in-process; only a handful send real
network requests. The RLS tests call TypeScript repositories. The 55 browser tests depend on React
page structure. Parity therefore needs a new, language-neutral harness:

- **Differential runs.** The same request sequence goes to the TypeScript and Rust servers on
  identical seeded databases, and the harness compares responses and resulting rows.
- **Converted tests.** In-process tests are rewritten to send network requests, so one suite runs
  against both servers.
- **SQL-level privacy checks.** RLS cases are re-expressed as SQL run under each runtime role, which
  judges both servers equally.

Phase 0 measures what that harness costs and how many existing cases convert.

### 2.4 What the rewrite does to modules

- **In-repo modules** (calendar, email, tasks, notes, meetings, sports and the rest) become Rust
  crates compiled into the program. They keep their SQL folders and their manifests' meaning.
- **Installed modules** (`external-modules/finance`, `meals`, archived `job-search`) run today as
  separate Node processes started by `packages/module-registry/src/external/worker-runtime.ts:284`,
  with web code bound to the host's React (`docs/module-developer-guide.md` §13.4). Both halves
  stop working. They must be rebuilt in the new module format (3.4).
- **Workshop** builds TypeScript modules today. It must produce the new format before it is useful
  again.
- **Third-party authors.** No outside modules are known to exist. If any do, they break without
  a compatibility path.

## 3. The hard problems

### 3.1 Every hard invariant, enforced in Rust

| Invariant (`CLAUDE.md`)                 | Enforced today by                                                                                       | Enforced in Rust by                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No admin bypass of private data         | `NOBYPASSRLS` runtime roles in `infra/postgres/bootstrap/0000_roles.sql`; RLS reads `app.actor_user_id` | Same roles and policies, unchanged. The Rust app never connects as the migration owner or a superuser at runtime. A startup check refuses to run if the runtime role can bypass RLS.                                                                                                                                |
| Private by default                      | Owner-only RLS policies; module tables get generated policies (`packages/db/src/module-rls-emitter.ts`) | Same SQL. The Rust module installer emits the same policy text, compared against the TypeScript output in a test.                                                                                                                                                                                                   |
| Data access only through a data context | `DataContextDb` brand set inside a transaction (`packages/db/src/data-context.ts:64`)                   | A `DataContext` type whose only constructor opens a transaction and sets the actor GUC. Repositories take `&DataContext`. The raw pool type is private to the db crate, so other crates cannot name it.                                                                                                             |
| Vault only through `VaultContext`       | `packages/vault/src/vault-context.ts`; no compile-time guard on the filesystem half                     | `VaultContext` holds the only directory handle (capability-style API). A lint denies `std::fs` and `tokio::fs` outside the vault crate. This adds a guard today lacks, though a dependency could still bypass a lint.                                                                                               |
| Secrets never escape                    | AES-256-GCM in `packages/db/src/secret-cipher.ts`; log redaction; review                                | Secret values live in a type with no `Debug`, `Display` or `Serialize`. Same cipher and on-disk format so existing ciphertext decrypts. Keys per the companion doc (OS keychain on desktop, no plaintext fallback). Sentinel tests plant a marker secret and check logs, errors, job payloads, exports and prompts. |
| Metadata-only job payloads              | `assertModuleJobPayload` in `packages/jobs/src/module-jobs.ts:53`; review                               | Each queue has a typed payload built only from an allowlist of field kinds (IDs, job kind, idempotency key, enums, small numbers). Free text is not an allowed kind, because a short secret fits in any string. Sentinel leak tests cover enqueue, logs and error paths for every queue.                            |
| `AccessContext` stays two fields        | Type definition and review                                                                              | A struct with private fields and exactly `actor_user_id` and `request_id`. Adding a field changes a type every crate sees, which review catches.                                                                                                                                                                    |
| Provider-agnostic AI                    | Capability router in `packages/ai/src/capability-route-map.ts`                                          | Features call a capability trait. A lint rejects provider and model name strings outside the adapters crate.                                                                                                                                                                                                        |
| Module isolation                        | Two boundary gates (`docs/module-developer-guide.md` §10)                                               | Each module is a crate that may depend only on other modules' public API crates. A workspace check fails the build on any other edge. Table access stays guarded by RLS and per-module roles (`module-role-broker.ts`). Module SQL from add-ons passes a parsed-statement check (3.4).                              |
| Never edit an applied migration         | Hash check in `packages/db/src/migrations/sql-runner.ts:220-235`; applied-check in `pending.ts:54`      | Rust must reproduce the same hashes, including the backfill hash domain (proved in Phase 0a). Unknown or changed files block startup. See 3.2.                                                                                                                                                                      |
| pgvector image                          | Compose image choice                                                                                    | The bundled Postgres always includes pgvector. Startup checks `CREATE EXTENSION vector` succeeded.                                                                                                                                                                                                                  |
| A PR must never break prod              | Process rule                                                                                            | Unchanged. The Rust app reads the same setting names, and any new required setting gets a way to set it in the app.                                                                                                                                                                                                 |

One honest gap exists today and stays visible. Module SQL checksums are recorded but not compared
on later runs, because `packages/db/src/migrations/module-sql-runner.ts:164-176` reads applied
versions only. The Rust runner adds that comparison as new behaviour.

A second gap is about what Moss encrypts. Credentials and AI keys are AES-256-GCM. The main
database and the vault folder are plain files on disk today. The keys that matter are
`BETTER_AUTH_SECRET`, `JARVIS_AI_SECRET_KEY`, `JARVIS_CONNECTOR_SECRET_KEY` and
`JARVIS_CLI_RUNNER_RPC_SECRET`, plus any OAuth client secrets (`infra/env.production.example`). The
plan claims protection at rest for the database or vault only where the OS disk encryption is
verified on, or after a tested encrypted-storage design, before general release.

On a Linux server, an owner who picks the server profile at setup may keep keys in a `0600` file
readable only by the service account, outside the data and export folders. That file is never an
automatic fallback when a desktop keychain fails. Details are in the companion doc.

### 3.2 Database

Postgres with pgvector and RLS is the security model. 633 policies, 93 security-definer functions
and four locked-down roles carry the privacy guarantees. The desktop question is how to get that
database onto a Windows or Mac machine.

| Option                               | Keeps RLS and roles                    | Keeps migrations and data          | Desktop cost                                                     | Verdict                        |
| ------------------------------------ | -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| Bundled Postgres plus pgvector       | Yes, unchanged                         | Yes, same files, same dump format  | Ship and manage a Postgres per OS, sign its files                | **Recommended**                |
| Embedded Postgres-compatible engine  | Partly; RLS and extension support vary | Unproven for 84 PL/pgSQL functions | Smaller, but every policy needs re-proof                         | Reject                         |
| SQLite with a new isolation model    | No; SQLite has no RLS or roles         | No; every SQL file rewritten       | Smallest, but the privacy model must be redesigned and re-proven | Reject                         |
| Desktop as a thin client to a server | Yes                                    | Yes                                | No local database                                                | Fallback only if Phase 1 fails |

Recommendation: bundle Postgres and pgvector on every OS. The deferred desktop plan reached the
same answer (`docs/superpowers/plans/2026-09-05-moss-desktop-install.md`, "Postgres stays"), and so
does the companion doc. SQLite is not a shortcut. It throws away the one part of Moss that is
already portable, and it needs a new privacy proof before it could ship.

How it runs on desktop:

- Loopback only, random free port, generated passwords, the same four roles.
- Data lives under the Moss data folder (3.10). Moss starts and stops Postgres itself.
- Upgrades of Postgres itself use dump and restore under Moss's control, after a snapshot.

Migrations:

- Every applied file stays byte for byte. No checksum reset, ever.
- A frozen manifest lists every legacy file and its hash. The Rust runner computes the same
  hashes, including the `moss:sql-migration+backfill:v1` domain over SQL plus backfill bytes.
  Module files are hashed differently today. The module runner hashes the text after decoding it
  as UTF-8 (`packages/db/src/migrations/module-sql-runner.ts:151-159`), while the core runner hashes
  raw bytes. Rust reproduces each rule for its own ledger.
- The two JavaScript backfills get Rust replacements, tested against the JavaScript on copies of
  real data. The hash of the legacy pair stays recorded; the Rust replacement only runs where the
  legacy pair has not run.
- An unknown or changed file blocks startup with a clear message.
- New Rust-era SQL is added as new files with new numbers.

Existing installs keep their database. The Rust program connects to the same schema. Section 4
covers the move.

### 3.3 Job queue

pg-boss is a Node library. Its tables live in the Moss database, but its locking and retry logic
lives in JavaScript.

| Option                                      | Pros                          | Cons                                                |
| ------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| Write a Rust client for pg-boss's tables    | No data move for queued jobs  | Ties Moss to another project's internal schema      |
| A Moss-owned Postgres queue (`SKIP LOCKED`) | Owned, simple, typed payloads | Queued jobs must be drained or re-queued at cutover |
| An in-process queue with no database        | Simplest                      | Loses jobs on crash; breaks retries and schedules   |

Recommendation: a Moss-owned queue in Postgres, in new SQL files. Workers set the actor GUC per job
exactly as today (spike `docs/architecture/spikes/0002-pg-boss-worker-rls.md`). The old and new
workers never run at once. Every schedule is re-declared in Rust and compared against the old list
in a test.

Cutover handles jobs in this order, because a queue cannot drain after its worker stops:

1. Fence producers. The API and schedules stop creating jobs.
2. Let the old worker finish only job kinds on an approved safe-to-finish list.
3. Stop the old worker and verify no worker process holds a job.
4. Archive what is left, pending and in-flight, and map each to a Rust job kind or a recorded drop.
   Nothing is retried blindly, because an in-flight job may already have had its effect.

### 3.4 Running third-party modules safely

Today a module worker is a separate Node process with a stripped environment and no database or
vault credentials (`worker-runtime.ts:279-287`). Every capability goes through host RPC ports
(`packages/module-registry/src/external/worker-rpc-host.ts`). The process boundary is real, but
the spawn call adds no OS sandbox, so a module can still use Node's own file and network access.

| Option                         | Isolation                                      | Cost                                                     |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| WebAssembly components         | Strong; only the ports the host links exist    | Authors rebuild modules; the port interface needs design |
| Native plugin processes per OS | Depends on per-OS sandboxes, uneven on Windows | Three sandboxes to maintain                              |
| Keep Node module processes     | Same as today                                  | Ships Node with Moss; undercuts the rewrite              |

Recommendation: WebAssembly components. The interface starts from today's ports (`ctx.kv`,
`ctx.fetch` with declared hosts, `ctx.db.query` under the module role, `ctx.ai`, `ctx.embed`,
`ctx.notify`, `ctx.jobs.enqueue`). A module gets only those imports, so file and network access
exist only through the host. This is a security gain over today.

Credentials change shape. Today `ctx.auth.getCredential` hands the module the plaintext secret.
Because every module is rebuilt anyway, the new interface defaults to brokered requests instead.
The module asks the host to make a request with a named credential attached, and never sees the
secret. A plaintext port exists only if a real module proves it needs one (decision 7.12).

The database port is the one a module could abuse. A module that can send `SET ROLE` or set
`app.actor_user_id` could act as another user. Today a lexer allowlist blocks that
(`packages/db/src/module-statement-classify.ts`). The Rust host parses each statement and admits
only a single plain read or write on the module's own tables. Tests try role switches, actor
changes, multiple statements and quoting tricks, and each must be refused.

Module screens run in a sandboxed frame with a small message bridge to host actions, and use the
Park Press CSS. Today's React host binding cannot survive a Rust UI.

### 3.5 The CLI-agent chat path

Chat drives the user's own Claude, Codex or OpenCode through the CLI runner
(`packages/cli-runner/src`). Today that path uses tmux or herdr panes, `node-pty`, and two Node
adapter packages for the Agent Client Protocol (`packages/cli-runner/package.json`). The runner
sits in its own container with a secret handshake over a `0600` Unix socket (ADR
`docs/architecture/decisions/0010-chat-engine-in-container-cli-runner-sidecar.md`).

- **The agents themselves are not part of Moss.** The rewrite still launches outside programs.
  Rust removes Moss's own Node, not the agents' runtimes.
- **The Node protocol adapters are the open question.** If each agent can be driven directly from
  Rust (an Agent Client Protocol client in Rust, or an agent's own streaming mode), Moss ships no
  Node. If not, Moss downloads a pinned Node runtime for that agent only, outside the Moss process.
  Phase 3 opens with that check.
- **Terminals.** tmux does not exist on Windows. A cross-platform terminal layer (ConPTY on
  Windows, a pty elsewhere) replaces it. herdr stays optional where installed.
- **Isolation.** The sidecar boundary becomes a separate runner process with the same rules: no
  database URLs, no auth secret, no vault, a secret hello on every connection. Named pipes replace
  the Unix socket on Windows.
- **Desktop is one account until containment is proven.** Production runs each account's agent
  as its own OS user by default (`JARVIS_CLI_PER_USER_UID=1`, `infra/env.production.example:142-146`,
  `infra/docker-compose.prod.yml:166`). That needs Linux and the right to switch users, so it stays
  on Linux servers. On a desktop, every agent would run as the same OS user. An agent can then read
  a sibling account's folders and the key store, whatever RLS says, because RLS guards the database
  only. So a desktop install serves one account. A second account on desktop needs a proven
  per-OS containment of the agent, and Phase 3's gate fails rather than ship that downgrade. The
  deferred desktop plan called shared-user isolation "matching the production default"
  (`docs/superpowers/plans/2026-09-05-moss-desktop-install.md:1042-1043`), which is no longer true.
- **Agent sandboxes vary.** Codex's own sandbox differs per OS (`docs/native-command-sandbox.md`
  covers Linux only). The plan records what each agent gives on each OS rather than claiming one.

### 3.6 Connectors and OAuth

- **Google** uses each user's own "Desktop app" OAuth client and a copy-paste loopback redirect
  (ADR `docs/architecture/decisions/0006-google-connector-per-user-oauth.md`). That works the same
  on every OS. On desktop, Moss can also catch the loopback redirect itself, which removes the
  copy-paste step.
- **IMAP and the rest** (`packages/connectors/src`, 58 files) are plain network clients and port
  directly.
- **Tokens** stay AES-256-GCM in the database, same format, so existing connections survive.
- **Sign-in and sessions.** better-auth (`packages/auth/src/index.ts`) has no Rust equivalent. Moss
  rewrites sign-in, sessions, companion pairing and trusted origins. It must verify existing
  password hashes. Keeping existing sessions is a goal, but one fresh sign-in at cutover is an
  acceptable fallback (decision 7.8). If a hash format cannot be verified, that person resets their own password through a
  pre-approved, verified account-recovery flow. The original hashes are kept. No admin sees, sets or
  signs in as the account, and cutover never leaves an owner locked out.

### 3.7 The UI

| Option                                      | Phones and other devices | Reuses Park Press CSS | Maturity                 |
| ------------------------------------------- | ------------------------ | --------------------- | ------------------------ |
| Rust compiled to WebAssembly in the browser | Yes                      | Yes                   | Good, younger than React |
| Native Rust toolkit (no browser)            | No                       | No                    | Varies                   |

Recommendation: a Rust web framework compiled to WebAssembly (Leptos or Dioxus, picked in Phase 0),
served by Moss, opened in a Rust desktop shell on desktop. Reasons:

- Phone chat, LAN access and the companions depend on a browser UI today.
- About 38,000 lines of CSS and the design tokens carry over, so Park Press does not get re-drawn.
- Every core screen and every module screen is still rebuilt. The CSS saves styling,
  not components.

The design-system audit (`docs/design-system.md`) must be re-implemented against the new component
code, so invented classes stay caught.

### 3.8 Installers and auto-update

| System        | Package                                             | Updates                           | Runs as                              |
| ------------- | --------------------------------------------------- | --------------------------------- | ------------------------------------ |
| Windows       | Per-user installer, no admin needed for Postgres    | Signed in-app updater             | Tray app; optional login item        |
| macOS         | Signed, notarized app in a disk image               | Signed in-app updater             | Tray app; optional login item        |
| Linux desktop | AppImage, plus .deb and .rpm                        | In-app updater or package manager | Tray app; optional systemd user unit |
| Linux server  | Single binary plus systemd unit, and a Docker image | Package or image tag              | System service or container          |

Every update takes a snapshot first (database dump, vault, keys) and migrates a staged copy. The
staged copy runs under its own Postgres cluster, started after the old app stops, so migrations
never touch the live files. Moss switches to the staged copy only when it passes its checks, and
keeps the old cluster stopped for rollback. The update channel is signed, and the app refuses
unsigned updates.

Linux desktop users never need a terminal. AppImage needs an executable flag and often a FUSE
library, so the .deb and .rpm packages are the default download and AppImage is the fallback. The
Phase 7 fresh-machine gate picks whichever packages install with clicks only.

### 3.9 Code signing and OS permissions

- **macOS.** Needs an Apple Developer account. Every binary, including Postgres and the pgvector
  library, must be signed under the hardened runtime and notarized. Whether pgvector loads under
  notarization is unproven (`docs/superpowers/plans/2026-09-05-moss-desktop-install.md:143-144`).
  Phase 1 tests it first.
- **Windows.** Needs a code-signing certificate or a signing service, or SmartScreen warns every
  user. Postgres's first-time setup must run without admin rights.
- **Linux.** No signing gate. Package signatures for .deb and .rpm repositories only.
- **Permissions.** macOS asks for microphone (meetings), and for folder access when the vault is in
  Documents or Desktop. Windows asks for a firewall rule once if LAN sharing is turned on. Each
  prompt is declared in the app map and explained where it appears.
- **Money and ownership.** Both signing accounts cost money every year and belong to a named
  person or company. That is decision 7.6.

### 3.10 Windows, Mac and Linux differences

| Area               | Windows                                      | macOS                                 | Linux                                                       |
| ------------------ | -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Data folder        | `%LOCALAPPDATA%\Moss` (not roaming)          | `~/Library/Application Support/Moss`  | `$XDG_DATA_HOME/moss`                                       |
| Local IPC          | Named pipes                                  | Unix socket                           | Unix socket                                                 |
| Background service | Login item or Windows service                | LaunchAgent                           | systemd user unit                                           |
| Terminals for chat | ConPTY                                       | pty                                   | pty, tmux optional                                          |
| File names         | Case-insensitive, reserved names, long paths | Usually case-insensitive              | Case-sensitive                                              |
| Open-file rules    | Open files cannot be deleted or replaced     | Normal                                | Normal                                                      |
| Process sandbox    | Job objects; AppContainer is limited         | App sandbox off for a server-like app | bubblewrap, Landlock                                        |
| Keys               | DPAPI-wrapped store                          | Keychain                              | Secret Service, with a server-mode file (see companion doc) |

Two of these change behaviour, not just paths:

- **Vault names.** On a case-insensitive disk, "Note.md" and "note.md" are the same file. A vault
  moved from Linux can hold both. The importer must find clashes and ask before merging.
- **Antivirus and file locks.** Windows Defender scanning the Postgres data folder can slow or
  block it. Moss detects the slowdown and explains it. An exclusion is the owner's explicit choice,
  never set by the installer and never needed to install.

### 3.11 Other parts that need their own answer

- **Local embeddings.** Today `nomic-embed-text-v1.5` (768 dimensions) runs through transformers.js
  (`packages/memory/src/local-embedding-provider.ts`). A Rust ONNX runtime must give the same
  vectors. If they differ, Moss reports it and keeps the stored vectors. Re-computing them is an
  owner choice that keeps the old vectors until the new ones are complete, never an automatic
  overwrite.
- **Sports renderer.** Uses a headless Chromium launched by Playwright (`Dockerfile`). Rust drives
  Chromium over its debugging protocol, downloaded on demand.
- **Moss Computer.** The persistent desktop work assumes a Linux server. It stays Linux-server
  only until a separate spec says otherwise.
- **Meetings capture and transcription.** The companion apps keep the same API. Desktop recording
  needs microphone permission (3.9).

## 4. Moving existing installs

The detailed rules live in the companion doc. This section fixes the shape.

### 4.1 People who do nothing

- Their Docker install keeps running the last TypeScript release. Nothing changes under them.
- That release gets security fixes only, for at least two supported Rust releases and 90 days
  after the Rust release ships, whichever is later (decision 7.9). The app shows a notice when the
  move is available.
- The Rust release never upgrades a TypeScript install by itself. Moving is a step the owner starts.

### 4.2 How data moves

Every move, server installs and Ben's prod included, works on a copy. The original stays put.

1. Fence and stop jobs in the 3.3 order. Stop the TypeScript app.
2. Take the frozen snapshot: database dump, vault folder and settings, with a manifest of hashes,
   in one encrypted archive. Keys go in a separately wrapped recovery bundle. The source database
   stays fenced and read-only for the dump, then stops. The original database and vault are never
   changed.
3. Restore the snapshot into a new Postgres cluster that the Rust program owns.
4. The Rust program checks the legacy migration manifest against that copy, then applies its own
   new SQL files. Any unknown file or key blocks the move.
5. Run the parity checks (sign-in, chat, one read per module, one job per queue kind).

Moving from Docker to a desktop install uses the same snapshot, restored into the bundled Postgres
by an import screen. Keys move in their own wrapped recovery package, never inside the plain
snapshot. They are never re-generated, because a new key cannot read the old ciphertext.

A source with more than one account cannot import into a desktop install until desktop containment
is proven (3.5). The import screen offers a server install, or a desktop that connects to the
existing server, and never drops the other accounts.

### 4.3 Rolling back

- **Default rollback.** Stop Rust and restart the original TypeScript install on its untouched
  database and vault. Every write made in Rust is lost from that install. The Rust copy is kept
  separately, so nothing is destroyed.
- **Keeping writes made in Rust.** Only through a reverse converter that has its own tests, and
  that prints a report of everything it cannot carry back. Additive schema alone does not make the
  live database safe for TypeScript, because values, queue ownership, ciphertext and vault formats
  can still differ. Moss never advertises an automatic, lossless downgrade.
- **Snapshot lifetime.** The frozen snapshot and the original install stay until the owner
  approves deleting them, and never before the 4.1 support window ends.
- **Old runner and new rows.** Both TypeScript runners loop over files on disk and ignore applied
  rows they do not know (`packages/db/src/migrations/sql-runner.ts:59`,
  `packages/db/src/migrations/pending.ts:46`). Phase 8 checks this on a real copy rather than
  relying on reading the code.
- Rollback is rehearsed on a copy of real data before Ben's prod moves. The old and new workers
  never run at the same time, in either direction.

## 5. Phases

Sizes are complexity, not time. S is a small lane, M a few lanes, L many lanes, XL a program of
its own.

| Phase | What                                 | Size | Depends on |
| ----- | ------------------------------------ | ---- | ---------- |
| 0     | Spike: one feature end to end        | L    | none       |
| 1     | Platform floor on three systems      | M    | 0          |
| 2     | Core platform                        | L    | 0          |
| 3     | Chat and agents                      | L    | 2          |
| 4     | UI shell and design system           | L    | 2          |
| 5     | In-repo modules and connectors       | XL   | 2, 3, 4    |
| 6     | New module format and Workshop       | L    | 2, 4       |
| 7     | Installers, signing, updates, backup | L    | 1, 2       |
| 8     | Cutover of existing installs         | M    | 5, 6, 7    |
| 9     | Retire the TypeScript code           | S    | 8          |

### Phase 0: spike (L)

Answers the biggest unknown, which is the rate of porting and the cost of proving parity. It runs
as two parts, so a cheap failure stops the expensive part.

**0a. Portability facts.**

- Rust verifies an existing password hash.
- Rust decrypts an existing credential with the existing key.
- Rust reproduces every legacy migration hash, backfill domain included.
- A normal user can unlock and recover keys with no terminal on each OS, including Linux with no
  keychain (companion doc).

**0b. One feature end to end.**

- Rebuild the Tasks module in Rust: its API routes, data context under RLS, one job, one screen.
- Run it against a scratch copy of the real schema, built by the existing migrations.
- Build the first piece of the parity harness (2.3) and run differential checks of Tasks against
  the TypeScript server.
- Convert the Tasks integration tests and RLS cases to the harness, and count how many convert
  cleanly.
- Pick the UI framework by building the one screen in it.

**Kill gate.** Stop after 0a if any portability fact fails. Stop or re-plan after 0b if the
differential checks cannot cover Tasks, or if the measured cost of porting plus the harness, scaled
to the whole codebase, is more than Ben accepts. The gate report names the measured count of
converted tests.

### Phase 1: platform floor (M)

- Bundled Postgres and pgvector start, migrate and stop on Windows, macOS and Linux.
- macOS signed and notarized build runs `CREATE EXTENSION vector`.
- Windows first-time setup runs without admin rights. Named pipes carry the runner handshake.
- Keys unlock and recover for a normal user on each OS, using the 0a proof in a real install.
- The installer reports whether disk encryption is verified on, off or unknown, and claims
  protection at rest only when verified (companion doc).

**Kill gate.** If pgvector cannot load under macOS notarization, or Postgres cannot run as a normal
Windows user, desktop installs become a thin client to a server, and the plan is re-cut before
Phase 7.

### Phase 2: core platform (L)

- Web server, sign-in and sessions, data context, roles, migration runner, secret cipher, vault
  context, job queue, module registry and app map, capability router with the HTTP adapters, log
  redaction.
- The build checks from 3.1 (module dependency edges, file access, provider names, payload shapes).

**Kill gate.** The RLS, secrets-never-escape and admin-no-bypass cases, converted to the parity
harness, pass against both servers. The sentinel leak tests and module SQL refusal tests pass, and
each is first seen failing with its protection removed. Any one failing stops Phase 5 from
starting.

### Phase 3: chat and agents (L)

- Runner process, terminal layer, agent protocol client, the Moss tool gateway, approvals and the
  classifier.

**Kill gate.** First check whether Claude, Codex and OpenCode can each be driven from Rust without
Moss shipping Node. Then live chat with tools runs on all three systems. If an agent needs Node,
Ben decides whether Moss downloads it (decision 7.5). A desktop second account stays off unless a
test shows one account's agent cannot read another account's folders or keys on that OS.

### Phase 4: UI shell and design system (L)

- App frame, navigation, chat drawer, Today, Settings frame, desktop shell, design-system audit.

**Kill gate.** Today and the chat drawer pass Ben's look check on a phone and a desktop, using the
carried-over CSS. If the CSS cannot be reused cleanly, re-size Phase 5 before it starts.

### Phase 5: in-repo modules and connectors (XL)

- Port modules in dependency order: people, tasks, notes, calendar, email and connectors, memory
  with embeddings, meetings, briefings, news, sports, weather, wellness, and the rest.
- Each module ships with its parity-harness checks passing and a live check through the UI.

**Kill gate.** At the halfway point, compare the real rate with the Phase 0 estimate. If it is
worse by half or more, stop and re-plan with Ben before porting further.

### Phase 6: new module format and Workshop (L)

- WebAssembly host with the 3.4 ports, sandboxed module screens, install and upgrade flow.
- Rebuild finance and meals in the new format. Workshop produces the new format.

**Kill gate.** Finance runs in the new format and passes its own tests. If the port interface cannot
express what finance needs, redesign it before rebuilding meals.

### Phase 7: installers, signing, updates, backup (L)

- Per-OS packages, signing, signed updates, start at login, LAN sharing prompt, backup and restore,
  the Docker-to-desktop import screen.

**Kill gate.** A clean install on a fresh machine on each OS, using clicks only, starts, signs in,
opens Today, and backs up and restores. A failed update on each OS falls back to the old cluster.
The full parity checklist runs in Phase 8, once modules exist.

### Phase 8: cutover (M)

- Rehearse the 4.2 move and both 4.3 rollbacks on a copy of real data, then move Ben's prod.

**Kill gate.** The rehearsal passes both rollbacks. If it does not, prod does not move.

### Phase 9: retire TypeScript (S)

- Remove the Node code once the 4.1 support window is over.

**Kill gate.** No supported install still runs TypeScript, every frozen snapshot either remains or
its owner approved deletion, and a restore from the last TypeScript snapshot into Rust still
passes.

## 6. Risks

| Risk                                               | Why it matters                                               | Mitigation                                             |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| The old app keeps moving                           | Parity is a moving target; the rewrite never catches up      | Feature freeze from Phase 2 (decision 7.1)             |
| Tests do not carry over                            | 500 of 538 integration files call TypeScript code directly   | New parity harness; Phase 0 measures its cost          |
| Security drift during rewrite                      | A missed RLS context or a leaked secret is a privacy failure | 3.1 build checks; Phase 2 kill gate; same SQL policies |
| Module ecosystem breaks                            | Installed modules and Workshop output stop working           | Phase 6; no outside modules known                      |
| Signing and notarization fail for bundled Postgres | No Mac desktop install                                       | Phase 1 tests it first                                 |
| Agents need Node anyway                            | "No Node" is not fully true                                  | Phase 3 check; download per agent, outside Moss        |
| Embedding vectors differ                           | Search quality drops until re-computed                       | Compare vectors; keep old ones; owner-started re-embed |
| Desktop privacy between accounts                   | Agents share one OS user and can read sibling files          | One account per desktop until containment passes       |
| UI framework maturity                              | Fewer ready-made parts than React                            | Pick in Phase 0 by building a real screen              |
| Two codebases at once                              | Fixes must land twice until cutover                          | Freeze; keep the gap short by not shipping Rust early  |

This would be a bad idea if:

- Phase 0 shows the porting rate is too slow for Ben to accept.
- The parity harness costs as much as the port, so parity would rest on manual checks.
- The main goal is only a double-click install. A rewrite is a very costly way to get that alone.
- Ben needs new features through the rewrite and will not freeze.

### Stopping partway

| Stop after  | What is left                                                                         | Cost                                       |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| Phase 0     | A measured rate, a harness cost and a go or no-go                                    | Medium, and far below any later stop       |
| Phase 1     | Bundled Postgres and signing know-how, reusable by today's app for a desktop install | Medium; most of it reusable                |
| Phases 2-4  | A core with no features; nothing shipped                                             | Large and mostly lost                      |
| Mid Phase 5 | Two half-codebases and a feature freeze already paid                                 | The worst stop; avoid by gating at halfway |

Rust is never shipped to users before Phase 8, so a stop never leaves people on a half-built app.

## 7. Open decisions for Ben

| #    | Fork                                                       | Recommended                                              | Why                                                                                                                   |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 7.1  | Keep adding features to today's app during the rewrite?    | Freeze big features from Phase 2; fixes only             | Otherwise parity never arrives                                                                                        |
| 7.2  | Keep today's HTTP API contract?                            | Yes                                                      | Companions and agent tools keep working, and the parity harness has a fixed target                                    |
| 7.3  | Database on desktop: bundled Postgres or SQLite?           | Bundled Postgres everywhere                              | Keeps every privacy rule and every migration; SQLite needs a new proof                                                |
| 7.4  | Add-on module format?                                      | WebAssembly components                                   | Real sandbox, one format on three systems                                                                             |
| 7.5  | If an agent needs Node, download it for that agent?        | Yes, pinned, outside the Moss process                    | Keeps chat working without Moss itself depending on Node                                                              |
| 7.6  | Who buys and holds the Apple and Windows signing accounts? | Ben, or a company he names, before Phase 1's Mac check   | Notarization cannot be tested without one                                                                             |
| 7.7  | Platform order                                             | Linux server, then macOS, then Windows                   | Ben's prod is Linux; Windows has the most unknowns                                                                    |
| 7.8  | Accept one fresh sign-in for everyone at cutover?          | Yes, as fallback; try to keep sessions                   | Session tokens are tied to better-auth; passwords and data carry over; an unreadable hash uses verified self-recovery |
| 7.9  | How long does the old app get security fixes?              | Two supported Rust releases and 90 days, whichever later | Gives people who do nothing a safe, countable window                                                                  |
| 7.10 | Desktop installs with several accounts?                    | No; one account per desktop until containment is proven  | On one OS user, agents can read each other's files despite RLS; households use a server install                       |
| 7.11 | UI framework                                               | Decide in Phase 0 between Leptos and Dioxus              | Choose by building a real screen, not by reading                                                                      |
| 7.12 | Do modules ever get a plaintext credential?                | No by default; brokered requests only                    | Modules are rebuilt anyway; a plaintext port only if a real module proves it needs one                                |
