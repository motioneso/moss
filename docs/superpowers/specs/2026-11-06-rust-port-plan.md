# Plan: rewrite Moss as one Rust application for Windows, macOS and Linux

- **Status:** plan for review. No code, no app changes.
- **Route:** full rewrite of server and UI in Rust. Ben ruled this on 2026-11-06.
- **Companion doc:** `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`
  (task JS-32) sets the detailed rules for data, keys, install and cutover. Where the two overlap,
  that doc owns the rule and this plan points to it.
- **Grounded on:** `main` at `1cb86c8b2`. Every count below comes from that tree.

## 1. Summary

Ben has chosen to rebuild Moss from scratch in Rust, both the server and the screens, so it can be
installed as a normal program on Windows, Mac and Linux. Today Moss runs as a set of Docker
containers on a Linux server. After the rewrite it would be one program people download and
double-click, and it could still run on a home server.

What it will take:

- **Size.** Moss today is about half a million lines of code plus more than that again in tests.
  All of it gets rewritten. This is the largest piece of work the project has taken on, several
  times larger than the deferred desktop-install plan, which was already judged "very large".
- **What carries over.** The database design and its privacy rules, the stored data, the look and
  feel (colours, type, spacing), and the way the app talks to its phone and Mac companions all
  stay. The program code does not.
- **What breaks.** Add-on modules written for today's Moss stop working and must be rebuilt in a
  new, safer format. Moss's own module builder must learn that format too.
- **Risk.** The danger is not that Rust can't do the job. The danger is that a rewrite this big
  takes so long that the old app keeps moving and the new one never catches up. The plan fights
  that with a stop-or-go check at every phase and a freeze on big new features once core work
  starts.
- **Biggest unknown.** Nobody knows yet how fast Moss can be rebuilt, or whether the existing
  tests can be pointed at the new program to prove it behaves the same. The first step is a small
  experiment that rebuilds one real feature end to end and measures both. If that experiment goes
  badly, the plan stops there at small cost.

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
| Workspace packages           | 46 in `packages/`, 5 in `apps/`, 3 in `external-modules/`      | `pnpm-workspace.yaml`                                           |
| Module manifests (in repo)   | 28                                                             | `packages/*/src/manifest*.ts`                                   |
| TypeScript, non-test         | about 519,000 lines                                            | `git ls-files '*.ts' '*.tsx'`                                   |
| TypeScript tests             | about 625,000 lines in 2,581 files                             | same, `*.test.ts`, `*.spec.ts`                                  |
| Web app source               | about 59,000 lines, 401 component files repo-wide              | `apps/web/src`, `*.tsx`                                         |
| CSS outside docs and mockups | about 38,000 lines                                             | `*.css`                                                         |
| Core screens and settings    | 75 declared paths                                              | `packages/shared/src/app-map-core.ts`                           |
| SQL files                    | 35 core, 381 module-owned, about 19,400 lines                  | `infra/postgres/`, `packages/*/sql/`, `external-modules/*/sql/` |
| Row-level security           | 121 files enable it, 633 policies                              | `CREATE POLICY` across all SQL                                  |
| Database functions           | 84 PL/pgSQL, 93 security-definer, 51 triggers                  | same                                                            |
| JavaScript data backfills    | 2, part of the migration hash                                  | `packages/meetings/sql/0280_*.backfill.mjs`, `0292_*`           |
| API paths                    | about 570 declared `/api/...` paths                            | route declarations in `apps/api`, `packages/*`                  |
| Job queues                   | about 73 named queues, 36 handlers, 44 schedules               | `packages/jobs/src`, `apps/worker/src/worker.ts`                |
| Prod containers              | Postgres, migrate, module install, app, sports renderer, Caddy | `infra/docker-compose.prod.yml`                                 |

### 2.3 Kept, rewritten, thrown away

| Kept as is                                               | Rewritten in Rust                                        | Thrown away                                                    |
| -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Every applied SQL file, byte for byte                    | API, worker, CLI runner, migrator, module host           | The Node runtime, pnpm workspace, Vite build                   |
| Database roles, RLS policies, database functions         | All repositories and services in `packages/*`            | React components (401 files), TanStack Query, the React router |
| Stored data, vault files, encrypted credentials and keys | Auth (better-auth has no Rust equivalent)                | The 625,000 lines of TypeScript tests, except black-box ones   |
| The HTTP API contract companions and agents depend on    | Every screen                                             | Node module SDK and the web module SDK                         |
| Park Press design tokens and CSS                         | The two JavaScript backfills, as tested Rust equivalents | tmux and setpriv as required parts of chat                     |
| Black-box tests that drive HTTP or the database          | Workshop's module builder output                         |                                                                |

Keeping the HTTP API contract is a choice inside the rewrite, not a half-step. The Mac Trail
Marker app (`apps/trail-marker`), the Android companion and the agents' tool calls all speak it.
Keeping it means they keep working at cutover, and the black-box API tests can judge the new server.

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

| Invariant (`CLAUDE.md`)                 | Enforced today by                                                                                       | Enforced in Rust by                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No admin bypass of private data         | `NOBYPASSRLS` runtime roles in `infra/postgres/bootstrap/0000_roles.sql`; RLS reads `app.actor_user_id` | Same roles and policies, unchanged. The Rust app never connects as the migration owner or a superuser at runtime. A startup check refuses to run if the runtime role can bypass RLS.                                    |
| Private by default                      | Owner-only RLS policies; module tables get generated policies (`packages/db/src/module-rls-emitter.ts`) | Same SQL. The Rust module installer emits the same policy text, compared against the TypeScript output in a test.                                                                                                       |
| Data access only through a data context | `DataContextDb` brand set inside a transaction (`packages/db/src/data-context.ts:64`)                   | A `DataContext` type whose only constructor opens a transaction and sets the actor GUC. Repositories take `&DataContext`. The raw pool type is private to the db crate, so other crates cannot name it.                 |
| Vault only through `VaultContext`       | `packages/vault/src/vault-context.ts`; no compile-time guard on the filesystem half                     | `VaultContext` holds the only directory handle (capability-style API). A lint denies `std::fs` and `tokio::fs` outside the vault crate. This is stronger than today.                                                    |
| Secrets never escape                    | AES-256-GCM in `packages/db/src/secret-cipher.ts`; log redaction; review                                | Secret values live in a type with no `Debug`, `Display` or `Serialize`. Same cipher and on-disk format so existing ciphertext decrypts. Keys per the companion doc (OS keychain on desktop).                            |
| Metadata-only job payloads              | `assertModuleJobPayload` in `packages/jobs/src/module-jobs.ts:53`; review                               | Each queue has a typed payload. A derive rejects free-text fields above a small byte limit and fails the build for unbounded strings. A test enqueues every queue and checks the stored payload.                        |
| `AccessContext` stays two fields        | Type definition and review                                                                              | A struct with private fields and exactly `actor_user_id` and `request_id`. Adding a field changes a type every crate sees, which review catches.                                                                        |
| Provider-agnostic AI                    | Capability router in `packages/ai/src/capability-route-map.ts`                                          | Features call a capability trait. A lint rejects provider and model name strings outside the adapters crate.                                                                                                            |
| Module isolation                        | Two boundary gates (`docs/module-developer-guide.md` §10)                                               | Each module is a crate that may depend only on other modules' public API crates. A workspace check fails the build on any other edge. Table access stays guarded by RLS and per-module roles (`module-role-broker.ts`). |
| Never edit an applied migration         | Hash check in `packages/db/src/migrations/sql-runner.ts:220-235`; applied-check in `pending.ts:54`      | Rust reproduces the same hashes, including the backfill hash domain. Unknown or changed files block startup. See 3.2.                                                                                                   |
| pgvector image                          | Compose image choice                                                                                    | The bundled Postgres always includes pgvector. Startup checks `CREATE EXTENSION vector` succeeded.                                                                                                                      |
| A PR must never break prod              | Process rule                                                                                            | Unchanged. The Rust app reads the same setting names, and any new required setting gets a way to set it in the app.                                                                                                     |

One honest gap exists today and stays visible. Module SQL checksums are recorded but not compared
on later runs, because `packages/db/src/migrations/module-sql-runner.ts:164-176` reads applied
versions only. The Rust runner adds that comparison as new behaviour.

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
exactly as today (spike `docs/architecture/spikes/0002-pg-boss-worker-rls.md`). At cutover the old
worker is stopped and the pg-boss queues drained. The old and new workers never run at once. The
44 schedules are re-declared in Rust and compared against the old list in a test.

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

Recommendation: WebAssembly components. The interface mirrors today's ports (`ctx.kv`,
`ctx.auth.getCredential`, `ctx.fetch` with declared hosts, `ctx.db.query` under the module role,
`ctx.ai`, `ctx.embed`, `ctx.notify`, `ctx.jobs.enqueue`). A module gets only those imports, so
file and network access exist only through the host. This is a security gain over today.

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
- **Downgrade on desktop.** Production runs each account's agent as its own OS user by default
  (`JARVIS_CLI_PER_USER_UID=1`, `infra/env.production.example:142-146`,
  `infra/docker-compose.prod.yml:166`). That needs Linux and the right to switch users, so it stays
  on Linux servers. On desktop, accounts share one OS user and rely on RLS plus per-account folders.
  This is a real loss against today's prod. Issue #2316 called it "matching the production default",
  which is no longer true.
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
  acceptable fallback (decision 7.8).

### 3.7 The UI

| Option                                      | Phones and other devices | Reuses Park Press CSS | Maturity                 |
| ------------------------------------------- | ------------------------ | --------------------- | ------------------------ |
| Rust compiled to WebAssembly in the browser | Yes                      | Yes                   | Good, younger than React |
| Native Rust toolkit (no browser)            | No                       | No                    | Varies                   |

Recommendation: a Rust web framework compiled to WebAssembly (Leptos or Dioxus, picked in Phase 0),
served by Moss, opened in a Rust desktop shell on desktop. Reasons:

- Phone chat, LAN access and the companions depend on a browser UI today.
- About 38,000 lines of CSS and the design tokens carry over, so Park Press does not get re-drawn.
- Every one of the 75 core screens and every module screen is still rebuilt. The CSS saves styling,
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

Every update takes a snapshot first (database dump, vault, keys), stops Postgres cleanly, applies
migrations, and rolls back on failure. The update channel is signed, and the app refuses unsigned
updates.

### 3.9 Code signing and OS permissions

- **macOS.** Needs an Apple Developer account. Every binary, including Postgres and the pgvector
  library, must be signed under the hardened runtime and notarized. Whether pgvector loads under
  notarization is unproven (issue #2316). Phase 1 tests it first.
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
| Data folder        | `%APPDATA%\Moss`                             | `~/Library/Application Support/Moss`  | `$XDG_DATA_HOME/moss`                                       |
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
  block it. The installer sets the documented exclusion or warns.

### 3.11 Other parts that need their own answer

- **Local embeddings.** Today `nomic-embed-text-v1.5` (768 dimensions) runs through transformers.js
  (`packages/memory/src/local-embedding-provider.ts`). A Rust ONNX runtime must give the same
  vectors, or every stored embedding is re-computed by a background job after cutover.
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
- That release gets security fixes only, for a stated period after the Rust release reaches
  parity (decision 7.9). The app shows a notice when the move is available.
- The Rust release never upgrades a TypeScript install by itself. Moving is a step the owner starts.

### 4.2 How data moves

Server installs, including Ben's prod:

1. Stop the TypeScript app and its worker. Drain the job queues. Nothing runs during the move.
2. Take the frozen snapshot: database dump, vault folder, keys and settings, with a manifest of
   hashes.
3. Start the Rust program against the same database and the same vault. It checks the legacy
   migration manifest, then applies its own new SQL files.
4. Run the parity checks (sign-in, chat, one read per module, one job per queue kind).

Moving from Docker to a desktop install uses the same snapshot, restored into the bundled Postgres
by an import screen. Keys move with the snapshot. They are never re-generated, because a new key
cannot read the old ciphertext.

### 4.3 Rolling back

- **Before any write after cutover.** Stop Rust, start TypeScript on the same database. Rust's
  first release adds only new tables (its queue, its migration records) and changes nothing
  TypeScript reads, so the old app still runs.
- **After writes.** Two options exist, and the owner picks one at rollback time.
  - Keep the live database. TypeScript runs on it and keeps the new writes, as long as the Rust
    release stayed additive. Jobs queued in the Rust queue are lost unless re-queued.
  - Restore the frozen snapshot. Every write after cutover is lost. This is the path if Rust
    damaged data.
- Rollback is rehearsed on a copy of real data before Ben's prod moves. The old and new workers
  never run at the same time, in either direction.

## 5. Phases

Sizes are complexity, not time. S is a small lane, M a few lanes, L many lanes, XL a program of
its own.

| Phase | What                                 | Size | Depends on |
| ----- | ------------------------------------ | ---- | ---------- |
| 0     | Spike: one feature end to end        | M    | none       |
| 1     | Platform floor on three systems      | M    | 0          |
| 2     | Core platform                        | L    | 0          |
| 3     | Chat and agents                      | L    | 2          |
| 4     | UI shell and design system           | L    | 2          |
| 5     | In-repo modules and connectors       | XL   | 2, 3, 4    |
| 6     | New module format and Workshop       | L    | 2, 4       |
| 7     | Installers, signing, updates, backup | L    | 1, 2       |
| 8     | Cutover of existing installs         | M    | 5, 6, 7    |
| 9     | Retire the TypeScript code           | S    | 8          |

### Phase 0: spike (M)

Answers the biggest unknown, which is the rate of porting and whether the old tests can judge the
new code.

- Rebuild the Tasks module in Rust: its API routes, data context under RLS, one job, one screen.
- Run it against a scratch copy of the real schema, built by the existing migrations.
- Point the existing black-box API tests and RLS tests at it unchanged.
- Prove three portability facts at the same time: Rust verifies an existing password hash, decrypts
  an existing credential, and reproduces the migration hashes, backfill domain included.
- Pick the UI framework by building the one screen in it.

**Kill gate.** Stop or re-plan if the slice cannot pass the existing black-box tests without
changing them, or if any of the three portability facts fails, or if the measured effort scaled to
the whole codebase is more than Ben accepts.

### Phase 1: platform floor (M)

- Bundled Postgres and pgvector start, migrate and stop on Windows, macOS and Linux.
- macOS signed and notarized build runs `CREATE EXTENSION vector`.
- Windows first-time setup runs without admin rights. Named pipes carry the runner handshake.
- Keys unlock and recover for a normal user on each OS, including Linux with no keychain (companion
  doc).

**Kill gate.** If pgvector cannot load under macOS notarization, or Postgres cannot run as a normal
Windows user, desktop installs become a thin client to a server, and the plan is re-cut before
Phase 7.

### Phase 2: core platform (L)

- Web server, sign-in and sessions, data context, roles, migration runner, secret cipher, vault
  context, job queue, module registry and app map, capability router with the HTTP adapters, log
  redaction.
- The build checks from 3.1 (module dependency edges, file access, provider names, payload shapes).

**Kill gate.** The existing RLS, secrets-never-escape and admin-no-bypass tests pass against the
Rust server. Any one failing stops Phase 5 from starting.

### Phase 3: chat and agents (L)

- Runner process, terminal layer, agent protocol client, the Moss tool gateway, approvals and the
  classifier.

**Kill gate.** First check whether Claude, Codex and OpenCode can each be driven from Rust without
Moss shipping Node. Then live chat with tools runs on all three systems. If an agent needs Node,
Ben decides whether Moss downloads it (decision 7.5).

### Phase 4: UI shell and design system (L)

- App frame, navigation, chat drawer, Today, Settings frame, desktop shell, design-system audit.

**Kill gate.** Today and the chat drawer pass Ben's look check on a phone and a desktop, using the
carried-over CSS. If the CSS cannot be reused cleanly, re-size Phase 5 before it starts.

### Phase 5: in-repo modules and connectors (XL)

- Port modules in dependency order: people, tasks, notes, calendar, email and connectors, memory
  with embeddings, meetings, briefings, news, sports, weather, wellness, and the rest.
- Each module ships with its black-box tests passing and a live check through the UI.

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

**Kill gate.** A clean install on a fresh user account on each OS passes the parity checklist. A
failed update on each OS restores the snapshot.

### Phase 8: cutover (M)

- Rehearse the 4.2 move and both 4.3 rollbacks on a copy of real data, then move Ben's prod.

**Kill gate.** The rehearsal passes both rollbacks. If it does not, prod does not move.

### Phase 9: retire TypeScript (S)

- Remove the Node code once prod has run on Rust for an agreed period and the security-fix window
  for the old release is over.

## 6. Risks

| Risk                                               | Why it matters                                               | Mitigation                                                              |
| -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| The old app keeps moving                           | Parity is a moving target; the rewrite never catches up      | Feature freeze from Phase 2 (decision 7.1)                              |
| Tests do not carry over                            | Most of the 625,000 test lines are TypeScript unit tests     | Keep the API contract; reuse black-box and SQL tests; Phase 0 proves it |
| Security drift during rewrite                      | A missed RLS context or a leaked secret is a privacy failure | 3.1 build checks; Phase 2 kill gate; same SQL policies                  |
| Module ecosystem breaks                            | Installed modules and Workshop output stop working           | Phase 6; no outside modules known                                       |
| Signing and notarization fail for bundled Postgres | No Mac desktop install                                       | Phase 1 tests it first                                                  |
| Agents need Node anyway                            | "No Node" is not fully true                                  | Phase 3 check; download per agent, outside Moss                         |
| Embedding vectors differ                           | Search quality drops until re-computed                       | Compare vectors; re-embed job                                           |
| UI framework maturity                              | Fewer ready-made parts than React                            | Pick in Phase 0 by building a real screen                               |
| Two codebases at once                              | Fixes must land twice until cutover                          | Freeze; keep the gap short by not shipping Rust early                   |

This would be a bad idea if:

- Phase 0 shows the porting rate is too slow for Ben to accept.
- The existing tests cannot judge the new code, so parity would rest on manual checks.
- The main goal is only a double-click install. A rewrite is a very costly way to get that alone.
- Ben needs new features through the rewrite and will not freeze.

### Stopping partway

| Stop after  | What is left                                                                         | Cost                                       |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| Phase 0     | A measured rate and a go or no-go                                                    | Small                                      |
| Phase 1     | Bundled Postgres and signing know-how, reusable by today's app for a desktop install | Medium; most of it reusable                |
| Phases 2-4  | A core with no features; nothing shipped                                             | Large and mostly lost                      |
| Mid Phase 5 | Two half-codebases and a feature freeze already paid                                 | The worst stop; avoid by gating at halfway |

Rust is never shipped to users before Phase 8, so a stop never leaves people on a half-built app.

## 7. Open decisions for Ben

| #    | Fork                                                       | Recommended                                               | Why                                                                                                             |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 7.1  | Keep adding features to today's app during the rewrite?    | Freeze big features from Phase 2; fixes only              | Otherwise parity never arrives                                                                                  |
| 7.2  | Keep today's HTTP API contract?                            | Yes                                                       | Companions, agent tools and black-box tests keep working                                                        |
| 7.3  | Database on desktop: bundled Postgres or SQLite?           | Bundled Postgres everywhere                               | Keeps every privacy rule and every migration; SQLite needs a new proof                                          |
| 7.4  | Add-on module format?                                      | WebAssembly components                                    | Real sandbox, one format on three systems                                                                       |
| 7.5  | If an agent needs Node, download it for that agent?        | Yes, pinned, outside the Moss process                     | Keeps chat working without Moss itself depending on Node                                                        |
| 7.6  | Who buys and holds the Apple and Windows signing accounts? | Ben, or a company he names, before Phase 1's Mac check    | Notarization cannot be tested without one                                                                       |
| 7.7  | Platform order                                             | Linux server, then macOS, then Windows                    | Ben's prod is Linux; Windows has the most unknowns                                                              |
| 7.8  | Accept one fresh sign-in for everyone at cutover?          | Yes, as fallback; try to keep sessions                    | Session tokens are tied to better-auth; passwords and data carry over either way                                |
| 7.9  | How long does the old app get security fixes?              | Until Rust has run in Ben's prod for a full release cycle | Gives people who do nothing a safe window                                                                       |
| 7.10 | Accept the desktop isolation downgrade (one OS user)?      | Yes, with a notice when a second account is added         | Prod isolates agents per OS user and desktop cannot; households with several people should use a server install |
| 7.11 | UI framework                                               | Decide in Phase 0 between Leptos and Dioxus               | Choose by building a real screen, not by reading                                                                |
