# Moss desktop install build plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Phase A is detailed to step level. Phases B, C and D
> are contracts only, to be expanded after the Phase A go/no-go (repository plan-build rule).

Date: 2026-09-05. Source baseline: `041864c8e` in `~/Jarv1s`.
Parent: [#2316](https://github.com/motioneso/moss/issues/2316) (epic, deferred, Size XL on
project 2; opened 2026-09-05). Supersedes [#1827](https://github.com/motioneso/moss/issues/1827),
closed "not planned" on 2026-08-27 with the activation trigger "we decide to distribute Moss to
people who aren't running it from source".
Spec: `docs/superpowers/specs/2026-09-05-moss-desktop-install.md` (does not exist yet; Phase 0
writes it from this plan and the design conversation of 2026-09-05).
Design conversation: Ben and a Codex session proposed the "Invisible Postgres + Plex model";
Fable's critique of 2026-09-05 is folded into the seams check and decisions below.

**Goal:** Ship Moss as a double-click install for Linux, macOS and Windows that runs the same
process tree and the same database as the Docker production stack, with no Docker and no
terminal, and with full feature parity to the current production install.

**Architecture:** A launcher supervises the existing process tree (migrate, module reconcile,
CLI runner, worker, API) exactly as the Docker supervisor does today, but reads every path from
one data directory, starts a bundled PostgreSQL 17 + pgvector cluster on loopback, and generates
every secret on first run. A minimal tray shell spawns that launcher as a sidecar and shows the
LAN address. The web UI stays in the browser. Docker remains the server distribution and calls
the same supervisor code; the desktop build is a second packaging, not a fork.

**Tech Stack:** Node 24 (bundled as a sidecar binary), PostgreSQL 17 + pgvector (bundled per
platform), Electron tray shell with electron-builder (DMG, NSIS, AppImage) and electron-updater,
node-pty, playwright-core (Chromium downloaded on demand), @huggingface/transformers (ONNX
runtime prebuilds), bonjour-service (mDNS), qrcode.

## Global constraints

- Every hard invariant in `CLAUDE.md` holds unchanged: no admin RLS bypass, private by default,
  secrets never escape, metadata-only job payloads, vault I/O through `VaultContext`, no new
  `AccessContext` fields, provider-agnostic AI, module isolation, never edit an applied migration,
  pgvector image, a PR must never break prod.
- Ruling 2026-09-01: no new feature may require a hand-edited settings file. Every value the
  desktop install needs is generated or set in the app or tray.
- Ruling 2026-08-16: if a change makes a setting required, the same PR adds it to every deployment
  config (dev and prod compose and env examples).
- The app map stays truthful in the same PR: new host settings, tray-visible screens and
  remediation text go into `packages/shared/src/app-map-core.ts`.
- Design gate: any new screen or settings pane needs agreed mockups before build (design-system
  skill, `jds-*` primitives). The tray menu counts as a screen.
- Live-path gate: every user-facing lane records installed, real-UI proof on its PR.
- PostgreSQL major version is pinned at 17 for the life of this plan. Bundle version and cluster
  version are compared at every boot.
- Parity baseline is the shipped production default, `infra/docker-compose.prod.yml` at the
  baseline commit, including its opt-in profiles (TLS) and its defaults (per-user UID isolation
  off).

---

## Working rules for every lane (copy into every brief and handoff)

- **Plain English in every status, brief, handoff and PR body.** Ben reads status to know whether
  the work is going well, not to review code. Name things by what they do, not by what the repo
  calls them. Keep exact names only where he must act on them: a command to run, a file to open,
  an error string to search for. If a sentence has more than one backtick, say it again without
  them. No coined shorthand. Plain ASCII punctuation. Code, commit messages and specs stay
  precise. **Pass this on** to every agent you spawn.
- One session per unit of work. Each lane below is sized for one context window. If a lane will
  compact more than once, re-slice it, do not relay.
- State lives outside the transcript: each lane keeps a short live-state note in its PR body.
- Shared checkout: use the `shared-checkout` skill before any commit. Never `git add -A`.
- Gate: use the `verify-gate` skill for any DB-touching test run. A green local gate still
  excludes CI's e2e step.
- Cross-model review (ruling 2026-09-04): Codex-built lanes are reviewed by Fable 5.1;
  Claude-built lanes by gpt-6-astra medium. Codex builders run Luna high.
- Merging is the agent's job. A green PR parked for Ben is a stall.
- Blocked on a Ben decision: add it to `docs/coordination/AWAITING-BEN.md` and run
  `needs-ben <lane> "<one-line question>"`. Never idle silently.
- Prove blockers through the product, not a table query, and confirm the checkout is at
  origin/main first.

## Delivery contract

Parity means: a person who installs the desktop build can do everything a person on the Docker
production install can do, through the same screens, with the same privacy guarantees. The table
is the contract. A capability is "delivered" only when its live proof is recorded.

| Capability today (Docker prod)                                  | Desktop mechanism                                                                                             | Lane   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| PostgreSQL 17 + pgvector, four locked-down roles, RLS           | Bundled cluster on 127.0.0.1 at a free port, scram auth, generated passwords, same bootstrap and grants SQL   | A4     |
| Migrate, then reconcile, then boot (ordering enforced)          | Same supervisor code extracted from the Docker launcher                                                       | A5     |
| API serves the web build, worker runs jobs                      | Same `dist/` bundles, same env names, produced from one data directory                                        | A1, A5 |
| Secrets generated once by the setup container                   | Generated once into an owner-only file in the data directory, same key names                                  | A2     |
| Vault, modules, CLI home, model cache, control dir on volumes   | Subfolders of the data directory                                                                              | A1     |
| CLI runner over a 0600 Unix socket with a secret handshake      | Unix socket on Linux/macOS, named pipe on Windows, same handshake                                             | A3     |
| tmux multiplexer for provider CLIs                              | node-pty multiplexer backend (tmux stays the Docker default)                                                  | A6     |
| Provider CLIs installed into a tools prefix at image build      | Installed on demand into the data directory with the bundled Node, from the existing onboarding probe         | A7     |
| Sports renderer: Playwright Chromium sidecar over a Unix socket | Same sidecar, Chromium downloaded on demand into the data directory, endpoint from A3                         | A8     |
| Local embeddings with an on-disk model cache                    | Same library, cache in the data directory, ONNX prebuild per platform                                         | A1, C  |
| Host restart button (sentinel file + host cron script)          | Launcher watches the same sentinel and restarts the tree                                                      | A5     |
| Module install: drop files in the modules dir, run reconcile    | Admin-gated in-app upload writes to the modules dir and runs reconcile in-process; folder watch is dev opt-in | B2     |
| Reconcile's owner-email confirmation from the env file          | Auto-populated by the launcher after first-admin onboarding                                                   | A5     |
| Access from another device via trusted origins in the env file  | Origins computed at boot from the bound port, LAN addresses and `moss.local`; recomputed on network change    | B3     |
| Opt-in HTTPS via Caddy                                          | Opt-in HTTPS served by the launcher with a locally generated CA; CA export by QR                              | B4     |
| Updates by pulling a new image tag                              | In-app update check; update stops the cluster before swapping files; refuses a Postgres major mismatch        | B5     |
| Backups by snapshotting volumes (documented procedure)          | `moss backup` command and an admin button producing one archive (dump + vault + modules + secrets)            | B6     |
| Start on boot (Docker restart policy)                           | Tray "Start at login" using the platform's login-item mechanism                                               | B1     |
| Linux x86_64 image                                              | AppImage x86_64 and arm64                                                                                     | C3     |
| (none)                                                          | macOS DMG, arm64 and x86_64, signed and notarized                                                             | C1     |
| (none)                                                          | Windows NSIS installer, x64, signed, firewall rule at install                                                 | C2     |

Not parity, stated openly: per-user Unix UID isolation for CLI subprocesses is off in the desktop
build, exactly as it is off by default in production. Cross-account isolation on desktop is RLS in
the database plus per-account folders under one OS user. The spec records this as a deliberate
downgrade with the threat model written out.

## Seams check

Source capabilities at the baseline, not live-test claims.

| Capability                      | Current evidence                                                                                                   | Decision                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Process tree and ordering       | `scripts/start-jarv1s.ts:139-154`: migrate, reconcile, then cli-runner, worker, api; `:181` spawns with uid/gid    | Extract into `packages/supervisor`; uid/gid drop only when running as root on POSIX. Docker launcher becomes a thin caller.                 |
| Env shaping per child           | `scripts/start-jarv1s.ts:40-60` strips CLI-runner keys from api/worker; `:86,111` MCP URL                          | Keep the same allow/deny lists; the launcher feeds the same env names from the data layout.                                                 |
| Role bootstrap                  | `infra/postgres/bootstrap/0000_roles.sql`; `packages/db/src/role-bootstrap.ts:43` derives role passwords from URLs | Unchanged. The launcher generates four role passwords and builds the five connection URLs the migrate step already expects.                 |
| Migration and DDL serialization | `scripts/migrate.ts:26`; `packages/db/src/cluster-ddl-lock.ts`; reconcile advisory lock `module-reconcile.ts:232`  | Unchanged. In-process reconcile from the UI reuses the same lock.                                                                           |
| Reconcile owner confirmation    | `scripts/module-reconcile.ts:151-155` throws unless env email equals the first owner                               | Keep the guard. The API writes `owner-email` into the control dir on first-admin creation; the launcher passes it as the confirm env.       |
| CLI runner socket               | `packages/cli-runner/src/server.ts:66-89` mkdir 0700, unlink stale, listen on path, chmod 0600                     | Path becomes an IPC endpoint from A3. On win32 the endpoint is a named pipe and the chmod steps are skipped.                                |
| RPC client                      | `packages/chat/src/live/chat-engine-rpc-client.ts:580,615` opens the socket path and realpaths it                  | Accept an endpoint string; skip realpath for pipe endpoints.                                                                                |
| Sports sidecar sockets          | `packages/sports/src/source/browser-protocol.ts:19-21` hard-codes `/run/moss-sports-browser/*.sock`                | Constants become defaults; runtime reads endpoints from env populated by the layout.                                                        |
| Chromium                        | `Dockerfile:62,78` installs Playwright Chromium at build; `browser-sidecar.ts:246` launches it                     | Desktop downloads Chromium on demand with Playwright's own installer into the data directory.                                               |
| Multiplexer                     | `packages/ai/src/adapters/multiplexer.ts:31-59` contract; `multiplexer-resolve.ts:20` kinds `tmux`, `herdr`        | Add kind `pty`. Contract tests run against all backends.                                                                                    |
| Provider CLI install            | `Dockerfile:67-87`, `JARVIS_CLI_TOOLS_PREFIX`                                                                      | Launcher installs into `layout.cliToolsPrefix` with bundled Node and npm.                                                                   |
| Vault root                      | `packages/vault/src/vault-config.ts:6` reads `JARVIS_VAULT_ROOT`                                                   | Fed from the layout. No code change.                                                                                                        |
| Web build serving               | `apps/api/src/static-web.ts:51` reads `JARVIS_WEB_DIST_DIR`                                                        | Fed from the bundle path. No code change.                                                                                                   |
| Embedding cache                 | `packages/memory/src/transformers-cache-dir.ts:9-19` honours `HF_HOME`                                             | Fed from the layout. No code change.                                                                                                        |
| Host restart                    | `packages/settings/src/host-restart-routes.ts:34,44,103` sentinel and alive files in the control dir               | Launcher owns the watcher: touches alive, consumes the sentinel, restarts residents.                                                        |
| Trusted origins                 | `packages/auth/src/runtime-config.ts:12` reads a fixed list; `docs/operations/deploy.md:40-50`                     | B3 verifies whether better-auth 1.6 accepts a resolver function; if not, the launcher rewrites the list and restarts api on network change. |
| Secrets generation              | `scripts/setup-prod.ts:10-28` writes `env.production.local` non-interactively                                      | Extract the generator into `packages/data-dir` and reuse it for both Docker setup and desktop.                                              |
| Secret key names                | `infra/env.production.example`                                                                                     | Desktop writes the same names. Rotation docs (`docs/operations/secret-key-rotation.md`) apply unchanged.                                    |
| Host settings screen            | `packages/shared/src/app-map-core.ts:227-230` "Advanced host setup"                                                | New desktop rows (cluster status, LAN address, Chromium install, backup) are declared here in the same PR that adds them.                   |
| Prior estimate                  | #1827 body: "bundled-Postgres launcher for Mac + Linux: a few weeks; Windows roughly doubles it"                   | Consistent with this plan. Signing and notarization need paperwork and money from Ben (see rulings).                                        |

### Unproven capabilities and accountable decisions

- **Postgres hardened-runtime loading of pgvector on macOS.** Unproven until C1 signs a bundle and
  runs `CREATE EXTENSION vector` under notarization. C1 opens with that proof.
- **Named pipes with the existing handshake on Windows.** Unproven until A3's win32 test runs in CI
  on a Windows runner. A3 adds that job.
- **better-auth dynamic trusted origins.** B3 checks the installed version before choosing between
  a resolver function and a restart-on-change.
- **Codex sandbox on desktop.** `codex-exec-session.ts:156` passes `--sandbox read-only`; Codex
  supplies its own sandbox on macOS and Linux and a reduced one on Windows. A7 records what each
  platform gives and the spec states it.

## Determinism boundary

Locked by this plan (change only with a spec revision):

1. **Postgres stays.** No SQLite. The four roles, RLS and pg-boss are the security architecture.
2. **The app runs in a bundled Node sidecar, not inside Electron's process.** Native modules are
   built once against plain Node; the tray shell never needs an Electron ABI rebuild. Swapping the
   shell (Tauri later) costs nothing in the app.
3. **One data directory feeds every path**, and the app reads only the env names it reads today.
4. **Docker calls the same supervisor.** A change to boot ordering lands in both distributions.
5. **Loopback only for Postgres**, random free port, scram auth, generated passwords. Never trust
   auth, never port 5432.
6. **Default network bind is asked at first run** ("Share Moss on this network?"), stored in the
   launcher settings, changeable from the tray. Until answered, bind is loopback.

Awaiting Ben (each is in the rulings checklist at the end): Electron versus Tauri for the tray;
Chromium bundled versus downloaded on demand; platform order; certificates and the Apple developer
account; when #2316 leaves deferred.

---

## Phase 0 — spec, epic, mockups (S0)

One lane, Claude builder, Astra review. Output is documents and issues, no code.

**Owned paths:** `docs/superpowers/specs/2026-09-05-moss-desktop-install.md`,
`docs/architecture/decisions/0011-desktop-packaging-embedded-postgres.md`,
`docs/superpowers/specs/assets/2026-09-05-moss-desktop-install/`.

- [ ] Write the spec from this plan: goals, non-goals, the parity table, the threat model
      section (what changes when everything runs as one OS user), the data-directory layout, the
      first-run flow, the update and backup flows, and the platform matrix.
- [ ] Write ADR 0011 recording decisions 1 to 6 above and the isolation downgrade.
- [ ] Produce mockups (design-system skill) for: the tray menu, the first-run "share on this
      network" prompt, the Host settings additions (database status row, LAN address row with QR,
      "Install browser renderer" row with progress, "Back up now" row), and the "module upload"
      control in module settings. Put them under the assets folder.
- [ ] Reactivate #2316 (remove the deferred label); create a milestone "Desktop install"; create one
      `task` issue per lane below with "Part of #<epic>", owned paths, dependencies and checks.
- [ ] Ben approves spec and mockups. Record the approval comment link in the spec header.

**Acceptance:** spec and ADR merged; mockups approved by Ben; task issues exist on project 2.

---

## Phase A — headless no-Docker runtime on Linux

Goal of the phase: `moss serve` on a Linux box with no Docker installed boots a fresh data
directory to a working Moss with every production capability, proven through the real UI. This
is most of the engineering work and is fully testable on the dev box today.

Lanes A1 to A4 are independent and can run in parallel. A5 depends on A1, A2 and A4. A6, A7 and
A8 depend on A3 and A5. A9 depends on all of them.

Builder assignment (cross-model ruling): A1, A3, A5, A9 Claude (Astra review). A2, A4, A6, A7, A8
Codex Luna high (Fable review).

### A1 — data directory layout (`packages/data-dir`)

**Files:**

- Create: `packages/data-dir/package.json` (name `@moss/data-dir`, ESM, `main` `src/index.ts`)
- Create: `packages/data-dir/src/index.ts`
- Create: `packages/data-dir/src/layout.ts`
- Create: `packages/data-dir/src/ipc.ts`
- Create: `packages/data-dir/src/env.ts`
- Test: `tests/unit/data-dir-layout.test.ts`, `tests/unit/data-dir-ipc.test.ts`,
  `tests/unit/data-dir-env.test.ts`
- Modify: `pnpm-workspace.yaml` only if `packages/*` is not already globbed (it is; verify, do
  not edit).

**Interfaces:**

- Produces:

```ts
// packages/data-dir/src/layout.ts
export interface DataLayout {
  readonly root: string;
  readonly postgres: {
    readonly dataDir: string; // <root>/postgres/data
    readonly portFile: string; // <root>/postgres/port
    readonly passwordFile: string; // <root>/postgres/superuser-password
    readonly logFile: string; // <root>/logs/postgres.log
  };
  readonly vaultRoot: string; // <root>/vaults
  readonly modulesDir: string; // <root>/modules
  readonly moduleBuildsDir: string; // <root>/module-builds
  readonly cliHomeBase: string; // <root>/cli-auth
  readonly cliToolsPrefix: string; // <root>/cli-tools
  readonly hfHome: string; // <root>/model-cache
  readonly browsersDir: string; // <root>/browsers
  readonly ipcDir: string; // <root>/run
  readonly controlDir: string; // <root>/control
  readonly logsDir: string; // <root>/logs
  readonly secretsFile: string; // <root>/secrets.env
  readonly settingsFile: string; // <root>/moss.json
}
export function defaultDataRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string;
// linux: $XDG_DATA_HOME/moss or ~/.local/share/moss
// darwin: ~/Library/Application Support/Moss
// win32: %LOCALAPPDATA%\Moss
export function dataLayout(root: string): DataLayout;
export async function ensureLayoutDirs(layout: DataLayout): Promise<void>; // mkdir -p, mode 0o700 on posix

// packages/data-dir/src/ipc.ts
export type IpcName = "cli-runner" | "sports-broker" | "sports-renderer";
export function ipcEndpoint(name: IpcName, layout: DataLayout, platform: NodeJS.Platform): string;
// posix: <ipcDir>/<name>.sock
// win32: \\.\pipe\moss-<name>-<sha1(root).slice(0,12)>
export function isPipeEndpoint(endpoint: string): boolean; // starts with \\.\pipe\

// packages/data-dir/src/env.ts
export function layoutToEnv(layout: DataLayout, platform: NodeJS.Platform): Record<string, string>;
// JARVIS_VAULT_ROOT, JARVIS_MODULES_DIR, JARVIS_MODULE_BUILDS_DIR, JARVIS_CLI_HOME,
// JARVIS_CLI_HOME_BASE, JARVIS_CLI_NEUTRAL_BASE (=<cliHomeBase>/chat), JARVIS_CLI_TOOLS_PREFIX,
// HF_HOME, PLAYWRIGHT_BROWSERS_PATH, JARVIS_CLI_RUNNER_SOCKET, MOSS_SPORTS_BROKER_SOCKET,
// MOSS_SPORTS_RENDERER_SOCKET, JARVIS_HOST_CONTROL_DIR
```

- [ ] **Step 1: Write the failing layout tests**

```ts
// tests/unit/data-dir-layout.test.ts
import { describe, expect, it } from "vitest";
import { dataLayout, defaultDataRoot } from "@moss/data-dir";

describe("defaultDataRoot", () => {
  it("uses XDG_DATA_HOME on linux when set", () => {
    expect(defaultDataRoot("linux", { XDG_DATA_HOME: "/x", HOME: "/h" })).toBe("/x/moss");
  });
  it("falls back to ~/.local/share/moss on linux", () => {
    expect(defaultDataRoot("linux", { HOME: "/h" })).toBe("/h/.local/share/moss");
  });
  it("uses Application Support on darwin", () => {
    expect(defaultDataRoot("darwin", { HOME: "/h" })).toBe("/h/Library/Application Support/Moss");
  });
  it("uses LOCALAPPDATA on win32", () => {
    expect(defaultDataRoot("win32", { LOCALAPPDATA: "C:\\U\\AppData\\Local" })).toBe(
      "C:\\U\\AppData\\Local\\Moss"
    );
  });
});

describe("dataLayout", () => {
  it("derives every path under root", () => {
    const l = dataLayout("/r");
    expect(l.postgres.dataDir).toBe("/r/postgres/data");
    expect(l.postgres.portFile).toBe("/r/postgres/port");
    expect(l.vaultRoot).toBe("/r/vaults");
    expect(l.modulesDir).toBe("/r/modules");
    expect(l.cliHomeBase).toBe("/r/cli-auth");
    expect(l.controlDir).toBe("/r/control");
    expect(l.secretsFile).toBe("/r/secrets.env");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/data-dir-layout.test.ts`
Expected: FAIL, cannot resolve `@moss/data-dir`.

- [ ] **Step 3: Create the package and implement `layout.ts`** with the exact paths in the
      interface block. `defaultDataRoot` throws `Error("HOME is not set")` on posix without HOME and
      `Error("LOCALAPPDATA is not set")` on win32 without it. Use `node:path.posix` for linux and
      darwin, `node:path.win32` for win32, so tests are deterministic on any host.

- [ ] **Step 4: Run tests to verify pass.** Same command. Expected: PASS.

- [ ] **Step 5: Write the failing IPC tests**

```ts
// tests/unit/data-dir-ipc.test.ts
import { describe, expect, it } from "vitest";
import { dataLayout, ipcEndpoint, isPipeEndpoint } from "@moss/data-dir";

describe("ipcEndpoint", () => {
  const layout = dataLayout("/r");
  it("is a socket file under run/ on linux and darwin", () => {
    expect(ipcEndpoint("cli-runner", layout, "linux")).toBe("/r/run/cli-runner.sock");
    expect(ipcEndpoint("sports-renderer", layout, "darwin")).toBe("/r/run/sports-renderer.sock");
  });
  it("is a named pipe on win32, unique per data root", () => {
    const a = ipcEndpoint("cli-runner", dataLayout("C:\\a"), "win32");
    const b = ipcEndpoint("cli-runner", dataLayout("C:\\b"), "win32");
    expect(a.startsWith("\\\\.\\pipe\\moss-cli-runner-")).toBe(true);
    expect(a).not.toBe(b);
    expect(isPipeEndpoint(a)).toBe(true);
    expect(isPipeEndpoint("/r/run/x.sock")).toBe(false);
  });
});
```

- [ ] **Step 6: Run, expect FAIL. Implement `ipc.ts`. Run, expect PASS.**

- [ ] **Step 7: Write the failing env tests**

```ts
// tests/unit/data-dir-env.test.ts
import { describe, expect, it } from "vitest";
import { dataLayout, layoutToEnv } from "@moss/data-dir";

describe("layoutToEnv", () => {
  it("emits every env name the app already reads", () => {
    const env = layoutToEnv(dataLayout("/r"), "linux");
    expect(env).toMatchObject({
      JARVIS_VAULT_ROOT: "/r/vaults",
      JARVIS_MODULES_DIR: "/r/modules",
      JARVIS_MODULE_BUILDS_DIR: "/r/module-builds",
      JARVIS_CLI_HOME: "/r/cli-auth",
      JARVIS_CLI_HOME_BASE: "/r/cli-auth",
      JARVIS_CLI_NEUTRAL_BASE: "/r/cli-auth/chat",
      JARVIS_CLI_TOOLS_PREFIX: "/r/cli-tools",
      HF_HOME: "/r/model-cache",
      PLAYWRIGHT_BROWSERS_PATH: "/r/browsers",
      JARVIS_CLI_RUNNER_SOCKET: "/r/run/cli-runner.sock",
      MOSS_SPORTS_BROKER_SOCKET: "/r/run/sports-broker.sock",
      MOSS_SPORTS_RENDERER_SOCKET: "/r/run/sports-renderer.sock",
      JARVIS_HOST_CONTROL_DIR: "/r/control"
    });
  });
  it("never emits a secret or a database URL", () => {
    const keys = Object.keys(layoutToEnv(dataLayout("/r"), "linux"));
    expect(keys.some((k) => /SECRET|PASSWORD|DATABASE_URL/.test(k))).toBe(false);
  });
});
```

- [ ] **Step 8: Run, expect FAIL. Implement `env.ts`. Run, expect PASS.**

- [ ] **Step 9: Lint, typecheck, commit** (shared-checkout skill).

Run: `pnpm lint && pnpm typecheck`
Commit: `feat(data-dir): one data directory feeds every runtime path (Part of #<epic>)`

**Acceptance:** three unit files green; package has no runtime dependency beyond `node:`.

### A2 — first-run secrets and launcher settings (`packages/data-dir`)

**Files:**

- Create: `packages/data-dir/src/secrets.ts`, `packages/data-dir/src/settings.ts`
- Modify: `scripts/setup-prod.ts` to call `generateSecretValues()` instead of its inline
  generator (behaviour-preserving; same key names, same output file).
- Test: `tests/unit/data-dir-secrets.test.ts`, `tests/unit/data-dir-settings.test.ts`

**Interfaces:**

```ts
// packages/data-dir/src/secrets.ts
export const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "JARVIS_AI_SECRET_KEY",
  "JARVIS_CONNECTOR_SECRET_KEY",
  "JARVIS_INTEGRATIONS_SECRET_KEY",
  "JARVIS_MODULE_CREDENTIAL_SECRET_KEY",
  "JARVIS_NEWS_CREDENTIAL_SECRET_KEY",
  "JARVIS_CLI_RUNNER_RPC_SECRET"
] as const;
export const ROLE_PASSWORD_KEYS = [
  "MOSS_PG_PASSWORD_MIGRATION_OWNER",
  "MOSS_PG_PASSWORD_APP_RUNTIME",
  "MOSS_PG_PASSWORD_WORKER_RUNTIME",
  "MOSS_PG_PASSWORD_AUTH_RUNTIME"
] as const;
export function generateSecretValues(random?: (bytes: number) => Buffer): Record<string, string>;
export async function ensureSecrets(secretsFile: string): Promise<Record<string, string>>;
// creates with mode 0o600 if missing; if present, loads and fills only missing keys; never
// overwrites an existing value (rotation is a documented manual step, unchanged).

// packages/data-dir/src/settings.ts
export interface LauncherSettings {
  readonly schemaVersion: 1;
  readonly bind: "loopback" | "lan" | "unset";
  readonly webPort: number; // default 1533
  readonly notesRoots: readonly string[];
  readonly tls: { readonly enabled: boolean };
  readonly startAtLogin: boolean;
  readonly ownerEmail: string | null;
}
export function defaultSettings(): LauncherSettings;
export async function readSettings(file: string): Promise<LauncherSettings>; // defaults if missing
export async function writeSettings(file: string, next: LauncherSettings): Promise<void>; // atomic rename
```

- [ ] **Step 1: Failing secrets tests**: `generateSecretValues` returns every key in both lists,
      each value 64 hex chars from a 32-byte buffer; `ensureSecrets` on a temp dir creates the file
      with mode 0o600, a second call returns identical values, and a file missing one key gets only
      that key added. Use `node:fs/promises` and `os.tmpdir()`.
- [ ] **Step 2: Run, expect FAIL. Implement. Run, expect PASS.**
- [ ] **Step 3: Failing settings tests**: missing file yields defaults with `bind: "unset"`;
      write then read round-trips; a file with an unknown `schemaVersion` throws
      `Error("unsupported launcher settings version")`.
- [ ] **Step 4: Run, expect FAIL. Implement. Run, expect PASS.**
- [ ] **Step 5: Refactor `scripts/setup-prod.ts`** to use `generateSecretValues()`. Run
      `pnpm exec vitest run tests/unit` filtered to any existing setup-prod test, and run the
      script against a temp dir: `pnpm exec tsx scripts/setup-prod.ts /tmp/setup-out`; diff the key
      set against `infra/env.production.example`.
- [ ] **Step 6: Lint, typecheck, commit.**

**Acceptance:** Docker setup output unchanged in key set; desktop and Docker share one generator.

### A3 — IPC endpoints that work on named pipes

**Files:**

- Modify: `packages/cli-runner/src/server.ts:60-89` (skip mkdir/chmod/unlink/realpath when
  `isPipeEndpoint(socketPath)`)
- Modify: `packages/chat/src/live/chat-engine-rpc-client.ts:580,615` (skip realpath for pipes)
- Modify: `packages/sports/src/source/browser-protocol.ts:19-21` (constants become defaults;
  export `resolveSportsSockets(env)` reading `MOSS_SPORTS_BROKER_SOCKET` and
  `MOSS_SPORTS_RENDERER_SOCKET`)
- Modify: every reader of `SPORTS_BROWSER_SOCKETS` to call `resolveSportsSockets(process.env)`
  (grep `SPORTS_BROWSER_SOCKETS` across `packages/sports` and `apps`)
- Modify: `infra/docker-compose.prod.yml` and `infra/docker-compose.yml`: the renderer socket
  is already set explicitly (`docker-compose.prod.yml:182`); add
  `MOSS_SPORTS_BROKER_SOCKET=/run/moss-sports-browser/broker.sock` beside it in both files, and
  add both keys to `infra/env.production.example`. Values equal today's constants, so prod
  behaviour is unchanged and the new key is never silently required (ruling 2026-08-16).
- Modify: `tests/unit/sports-renderer-compose.test.ts` to assert both keys are present.
- Create: `.github/workflows/ipc-win32.yml` running `tests/unit/ipc-named-pipe.test.ts` on
  `windows-latest`
- Test: `tests/unit/ipc-named-pipe.test.ts` (creates a `net.Server` on a pipe endpoint from
  `ipcEndpoint(..., "win32")`, connects, exchanges one line; skipped unless `process.platform ===
"win32"`), plus existing cli-runner server tests extended with a pipe case that asserts no
  `chmod` call is made (inject the fs deps the server already takes).

- [ ] **Step 1: Failing test for `resolveSportsSockets`** (defaults equal today's constants; env
      overrides win).
- [ ] **Step 2: Run, FAIL. Implement. Run, PASS.**
- [ ] **Step 3: Failing cli-runner server test** for the pipe case.
- [ ] **Step 4: Run, FAIL. Implement the `isPipeEndpoint` branches. Run, PASS.**
- [ ] **Step 5: Add the Windows workflow and the pipe round-trip test.** Push; confirm the job is
      green on the PR.
- [ ] **Step 6: Run the cli-runner and chat live suites locally** (verify-gate skill) to prove
      the Linux path is unchanged.
- [ ] **Step 7: Lint, typecheck, commit.**

**Acceptance:** Windows CI job green; Linux gate green; prod compose diff is value-preserving.

### A4 — embedded Postgres cluster (`packages/embedded-postgres`) and the Linux bundle

**Files:**

- Create: `packages/embedded-postgres/package.json` (`@moss/embedded-postgres`)
- Create: `packages/embedded-postgres/src/index.ts`, `cluster.ts`, `lockfile.ts`, `port.ts`,
  `urls.ts`
- Create: `infra/postgres-bundle/manifest.json` (per-platform archive URL, sha256, `pgVersion`
  `17.x`, `pgvectorVersion`)
- Create: `infra/postgres-bundle/build-linux.sh` (Debian bookworm container: build PostgreSQL
  17.x from the official tarball with `--prefix=/opt/moss-pg`, build pgvector against it, strip,
  tar the prefix; output `postgres-17.x-pgvector-<ver>-linux-x64.tar.zst` and arm64 via
  `docker buildx --platform`)
- Create: `.github/workflows/postgres-bundle.yml` (manual dispatch; uploads archives as a release
  asset on a `postgres-bundle-<pgVersion>-<pgvectorVersion>` tag; prints sha256 to paste into the
  manifest)
- Create: `scripts/fetch-postgres-bundle.ts` (downloads the manifest entry for the host platform
  into `<repo>/.bundles/postgres/<platform>`, verifies sha256, refuses on mismatch)
- Test: `tests/integration/embedded-postgres.test.ts` (real cluster in a temp dir; requires the
  Linux bundle fetched; CI job caches it)

**Interfaces:**

```ts
// packages/embedded-postgres/src/cluster.ts
export interface ClusterPaths {
  readonly binDir: string; // <bundle>/bin
  readonly dataDir: string;
  readonly portFile: string;
  readonly passwordFile: string;
  readonly logFile: string;
}
export interface ClusterInfo {
  readonly port: number;
  readonly superuserPassword: string;
  readonly pid: number;
  readonly version: string; // contents of PG_VERSION, e.g. "17"
}
export type ClusterState = "running" | "stopped" | "stale-lock" | "uninitialised";

export async function ensureCluster(paths: ClusterPaths): Promise<"created" | "existing">;
// initdb --auth=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 --username=postgres
//        --pwfile=<generated>; writes postgresql.auto.conf: listen_addresses='127.0.0.1',
//        unix_socket_directories=<dataDir> on posix (Postgres requires one; keep it inside dataDir),
//        shared_preload_libraries unchanged, log_destination=stderr, logging_collector=off.
// Refuses with Error("cluster version 16 does not match bundled 17") on mismatch.

export async function clusterState(paths: ClusterPaths): Promise<ClusterState>;
// reads postmaster.pid; pid alive AND its cwd/cmdline names our dataDir => running;
// pid dead or foreign => stale-lock.

export async function startCluster(paths: ClusterPaths): Promise<ClusterInfo>;
// running => adopt (return info from port file). stale-lock => remove postmaster.pid, then start.
// picks a free loopback port (port.ts) unless portFile holds one that is still free; pg_ctl start
// -w -o "-p <port>" -l logFile; waits for pg_isready; writes portFile atomically.

export async function stopCluster(paths: ClusterPaths): Promise<void>; // pg_ctl stop -m fast -w
export async function assertVectorExtension(info: ClusterInfo): Promise<void>;
// CREATE EXTENSION IF NOT EXISTS vector in a scratch database, then drop it.

// packages/embedded-postgres/src/urls.ts
export interface RolePasswords {
  migrationOwner: string;
  appRuntime: string;
  workerRuntime: string;
  authRuntime: string;
}
export function connectionUrls(
  info: ClusterInfo,
  db: string,
  roles: RolePasswords
): {
  JARVIS_BOOTSTRAP_DATABASE_URL: string; // postgres superuser
  JARVIS_MIGRATION_DATABASE_URL: string;
  JARVIS_APP_DATABASE_URL: string;
  JARVIS_WORKER_DATABASE_URL: string;
  JARVIS_AUTH_DATABASE_URL: string;
};
```

- [ ] **Step 1: Build the Linux bundle once** by running `infra/postgres-bundle/build-linux.sh`
      locally in Docker (this box has Docker); publish via the workflow; write the sha256 and the
      release URL into the manifest.
- [ ] **Step 2: Failing integration test**

```ts
// tests/integration/embedded-postgres.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clusterState,
  ensureCluster,
  startCluster,
  stopCluster,
  assertVectorExtension
} from "@moss/embedded-postgres";

const binDir = process.env.MOSS_PG_BUNDLE_BIN!; // set by the fetch script's output
let root: string;
const paths = () => ({
  binDir,
  dataDir: join(root, "data"),
  portFile: join(root, "port"),
  passwordFile: join(root, "pw"),
  logFile: join(root, "pg.log")
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-pg-"));
});
afterAll(async () => {
  await stopCluster(paths()).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("embedded postgres", () => {
  it("initialises, starts on loopback at a free port, and has pgvector", async () => {
    expect(await ensureCluster(paths())).toBe("created");
    const info = await startCluster(paths());
    expect(info.port).toBeGreaterThan(1024);
    expect(await clusterState(paths())).toBe("running");
    await assertVectorExtension(info);
  });
  it("adopts an already running cluster instead of starting a second one", async () => {
    const a = await startCluster(paths());
    const b = await startCluster(paths());
    expect(b.pid).toBe(a.pid);
  });
  it("cleans a stale lock after the postmaster is killed", async () => {
    const info = await startCluster(paths());
    process.kill(info.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    expect(await clusterState(paths())).toBe("stale-lock");
    const again = await startCluster(paths());
    expect(again.pid).not.toBe(info.pid);
  });
  it("refuses a cluster from another major version", async () => {
    await stopCluster(paths());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(paths().dataDir, "PG_VERSION"), "16\n");
    await expect(startCluster(paths())).rejects.toThrow(/does not match bundled 17/);
  });
});
```

- [ ] **Step 3: Run, expect FAIL (module missing).** Implement `port.ts` (bind port 0 on
      127.0.0.1, read the assigned port, close), `lockfile.ts` (parse `postmaster.pid`, check
      `/proc/<pid>` on linux or `process.kill(pid, 0)` elsewhere), `cluster.ts`, `urls.ts`.
- [ ] **Step 4: Run, expect PASS.** Run the same file three times back to back to prove no port
      or lock leakage.
- [ ] **Step 5: Add the CI job**: in `ci.yml`, a job that runs `scripts/fetch-postgres-bundle.ts`
      (cached by manifest sha) and this test file. Do not touch the existing jobs.
- [ ] **Step 6: Lint, typecheck, commit.**

**Acceptance:** integration file green locally and in CI; bundle sha pinned; no port 5432 anywhere
in the package.

### A5 — the supervisor package and the `moss` launcher

**Files:**

- Create: `packages/supervisor/package.json` (`@moss/supervisor`), `src/index.ts`,
  `src/plan.ts`, `src/run.ts`, `src/restart-watcher.ts`
- Modify: `scripts/start-jarv1s.ts` so that it only builds a `SupervisorPlan` from the container
  env and calls `runSupervisor`. Every existing exported helper (`runtimeUidGid`, child env
  builders) moves into `packages/supervisor/src/plan.ts` with the same names, and the script
  re-exports them so existing tests keep passing.
- Create: `apps/launcher/package.json` (`@moss/launcher`, bin `moss`), `src/main.ts`,
  `src/commands/serve.ts`, `src/commands/stop.ts`, `src/commands/status.ts`,
  `src/commands/reconcile.ts`, `src/boot.ts`
- Modify: `packages/settings/src/host-restart-routes.ts` no change; the launcher implements the
  watcher side.
- Modify: the first-admin creation path in `packages/auth` (find it with
  `grep -rn "first admin\|isFirstUser\|bootstrapAdmin" packages/auth/src`) to write
  `<controlDir>/owner-email` (0600) when `JARVIS_HOST_CONTROL_DIR` is set. This is additive and
  inert in Docker until the launcher consumes it.
- Modify: `scripts/build-app.ts` to also build `launcher` and `supervisor` (check its arg
  handling first; it currently builds `api` and `worker`).
- Test: `tests/unit/supervisor-plan.test.ts` (moved and extended from the existing
  start-jarv1s tests, if any; else new), `tests/unit/supervisor-restart-watcher.test.ts`,
  `tests/integration/launcher-serve.test.ts`

**Interfaces:**

```ts
// packages/supervisor/src/plan.ts
export type ChildRole = "api" | "worker" | "cli-runner" | "sports-renderer";
export interface ProcessSpec {
  readonly role: ChildRole;
  readonly command: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}
export interface SupervisorPlan {
  readonly oneShots: readonly ProcessSpec[]; // migrate, then reconcile, in order
  readonly residents: readonly ProcessSpec[];
  readonly dropTo?: { readonly uid: number; readonly gid: number }; // only when geteuid()===0 on posix
  readonly controlDir: string;
}
export function buildDockerPlan(env: NodeJS.ProcessEnv): SupervisorPlan; // today's behaviour
export function buildDesktopPlan(input: {
  appDir: string; // where dist/server.js, dist/worker.js, dist/cli-runner.js, web dist live
  nodeBin: string; // bundled node
  env: NodeJS.ProcessEnv; // layoutToEnv + connectionUrls + secrets + HOST/PORT + confirm email
  sportsRenderer: boolean; // true when Chromium is installed
}): SupervisorPlan;

// packages/supervisor/src/run.ts
export interface Supervised {
  shutdown(signal: NodeJS.Signals): Promise<void>;
  readonly exited: Promise<number>;
}
export async function runOneShots(plan: SupervisorPlan): Promise<void>;
export function startResidents(
  plan: SupervisorPlan,
  onExit: (role: ChildRole, code: number | null) => void
): Supervised;
export async function runSupervisor(plan: SupervisorPlan): Promise<number>; // one-shots then residents, SIGTERM/SIGINT handling as today

// packages/supervisor/src/restart-watcher.ts
export function startRestartWatcher(
  controlDir: string,
  onRequest: () => Promise<void>,
  intervalMs?: number
): { stop(): void };
// touches <controlDir>/watcher-alive every interval; when <controlDir>/restart-requested exists,
// unlinks it and calls onRequest.

// apps/launcher/src/boot.ts
export interface BootResult {
  readonly layout: DataLayout;
  readonly cluster: ClusterInfo;
  readonly settings: LauncherSettings;
  readonly env: NodeJS.ProcessEnv;
}
export async function bootDataDir(
  root: string,
  bundle: { pgBinDir: string; appDir: string; nodeBin: string }
): Promise<BootResult>;
// ensureLayoutDirs -> ensureSecrets -> ensureCluster/startCluster -> assertVectorExtension ->
// read settings -> env = { ...layoutToEnv, ...connectionUrls, ...secrets, HOST, PORT,
//   JARVIS_WEB_PORT, JARVIS_WEB_DIST_DIR, JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL (from
//   <controlDir>/owner-email if present, else settings.ownerEmail, else unset),
//   JARVIS_MULTIPLEXER: "pty", JARVIS_CLI_PER_USER_UID: "0", NODE_ENV: "production" }
```

CLI surface (`moss --help` must print exactly these):

```
moss serve [--data-dir <path>] [--bind loopback|lan] [--port <n>] [--open]
moss stop [--data-dir <path>]
moss status [--data-dir <path>]          # cluster state, port, resident pids, LAN URLs
moss reconcile [--data-dir <path>]       # runs module reconcile in-process under the lock
moss config set notes-roots <path>[,<path>] [--data-dir <path>]   # writes moss.json, restarts api
```

- [ ] **Step 1: Move the plan builders** out of `scripts/start-jarv1s.ts` behaviour-preserving;
      run the existing unit tests that import from the script; they must stay green.
- [ ] **Step 2: Failing tests for `buildDesktopPlan`**: no `dropTo` when not root; residents
      include `sports-renderer` only when `sportsRenderer: true`; api and worker env never contain
      `JARVIS_CLI_RUNNER_RPC_SECRET`; cli-runner env never contains any `*_DATABASE_URL` or
      `BETTER_AUTH_SECRET` (mirror the existing deny list at `start-jarv1s.ts:40-60`).
- [ ] **Step 3: Run, FAIL. Implement. Run, PASS.**
- [ ] **Step 4: Failing restart-watcher test** with a temp dir: alive file appears within one
      interval; creating `restart-requested` triggers `onRequest` once and removes the file.
- [ ] **Step 5: Run, FAIL. Implement. Run, PASS.**
- [ ] **Step 6: Failing integration test `launcher-serve.test.ts`**: with the fetched bundle and
      a built app, run `moss serve --data-dir <tmp> --bind loopback --port 0` as a child, wait for
      `GET /health` 200 (`apps/api/src/server.ts:318`), assert the
      secrets file is 0600, assert `moss status` reports running, run `moss stop`, assert the
      cluster is stopped and no child pids remain.
- [ ] **Step 7: Run, FAIL. Implement `serve`, `stop`, `status`, `reconcile`. Run, PASS.**
      `serve` writes `<root>/launcher.pid`; `stop` signals it and waits for the exited promise.
- [ ] **Step 8: Owner-email hook.** Failing unit test on the first-admin path: when the control
      dir env is set, creating the first admin writes `owner-email` with that email; when unset,
      writes nothing. Implement. Run the auth unit tests.
- [ ] **Step 9: Docker parity check.** `pnpm exec tsx scripts/smoke-compose.ts` with the prod
      compose file (verify-gate skill) must pass unchanged, proving the Docker launcher still boots
      through the extracted supervisor.
- [ ] **Step 10: Lint, typecheck, commit.**

**Acceptance:** Docker smoke green; `launcher-serve` green; `moss --help` matches the surface above.

### A6 — node-pty multiplexer backend

**Files:**

- Create: `packages/ai/src/adapters/pty-multiplexer.ts`
- Modify: `packages/ai/src/adapters/multiplexer-resolve.ts:20` add `"pty"` to `MultiplexerKind`;
  env override `JARVIS_MULTIPLEXER=pty` selects it; the admin setting enum gains `pty`; auto
  detection never picks `pty` (it is explicit only).
- Modify: `packages/settings` schema for `chat.multiplexer` and the settings UI enum (find with
  `grep -rn "chat.multiplexer"`); app map entry for the setting updated in the same PR.
- Modify: `packages/cli-runner` so the runner process hosts the pty sessions (node-pty is already
  its dependency) and the multiplexer talks to them in-process. Sessions live as long as the
  runner process, which outlives api restarts exactly as the tmux server does.
- Test: `tests/unit/pty-multiplexer.test.ts` running the existing multiplexer contract tests
  (find them with `grep -rln "TmuxMultiplexer" tests`) parameterised over `tmux` and `pty`.

**Interface:** implements `Multiplexer` from `packages/ai/src/adapters/multiplexer.ts:31-59`
exactly. `attachCommand(handle)` returns `moss attach <handle>` (the launcher gains a hidden
`attach` command that streams the pty; document it as developer-only).

- [ ] **Step 1: Parameterise the contract tests** over both kinds; run; `pty` cases FAIL.
- [ ] **Step 2: Implement `PtyMultiplexer`**: `open` spawns via node-pty with the CLI env,
      keeps a scrollback ring buffer of 200 KB per handle for `capturePane`, `submit` = paste +
      Enter with the same debounce the tmux backend uses, `interrupt` writes `\x03`, `kill` sends
      SIGTERM then SIGKILL after 5 s, `isAlive` checks the pty exit event.
- [ ] **Step 3: Run, PASS for both kinds.**
- [ ] **Step 4: Live proof on Linux**: `moss serve` with `JARVIS_MULTIPLEXER=pty`, log in, run a
      chat turn through a real provider CLI, restart api via the Host settings button, confirm the
      session survives. Record on the PR.
- [ ] **Step 5: Lint, typecheck, commit.**

**Acceptance:** contract tests green for both backends; Docker default remains `tmux`.

### A7 — provider CLI install on desktop

**Files:**

- Create: `apps/launcher/src/commands/tools.ts` (`moss tools install <claude|codex|all>`,
  `moss tools status`)
- Modify: the provider validation response and its UI copy (`packages/ai/src/provider-validation-routes.ts`; find the screen with `grep -rn "provider-validation"
apps/web/src`) so that a missing CLI on a desktop install says "Install from Host settings"
  and links to the new row; app map remediation entry added in the same PR.
- Modify: `packages/settings` host routes: a `POST /api/host/tools/install` that writes
  `<controlDir>/tools-install-requested` with the tool name; the launcher's restart watcher gains a
  second sentinel handler for it and runs the install with the bundled Node and npm into
  `layout.cliToolsPrefix`, mirroring `Dockerfile:67-87`. Progress and result go to
  `<controlDir>/tools-install-status.json` which the route reads.
- Test: unit tests for the sentinel round-trip and the status file schema; live proof.

- [ ] **Step 1: Failing tests, implement, pass** as in A5 step 4 pattern for the new sentinel.
- [ ] **Step 2: Live proof**: fresh data dir, Host settings, install Claude CLI, run the
      onboarding probe, complete a chat turn. Record which sandbox Codex reports on Linux.
- [ ] **Step 3: Lint, typecheck, commit.**

**Acceptance:** a fresh install reaches a working chat with no terminal.

### A8 — sports renderer with on-demand Chromium

**Files:**

- Create: `apps/launcher/src/commands/browser.ts` (`moss browser install`, `moss browser status`)
  using `playwright-core`'s installer entry (`pnpm exec playwright install chromium` equivalent
  invoked programmatically or via the bundled Node) with `PLAYWRIGHT_BROWSERS_PATH` from the layout.
- Modify: `buildDesktopPlan` gets `sportsRenderer: true` only when the browser status is
  installed; the launcher restarts residents after an install completes.
- Modify: sports settings UI and app map: when the renderer is unavailable, the sports source
  screen shows "Install browser renderer in Host settings" (mockup from Phase 0).
- Modify: Host settings row "Install browser renderer" via the same sentinel pattern as A7.
- Test: unit for the sentinel; live proof on Linux with a real sports source render.

- [ ] Steps as A7. Live proof: enable a sports source, see a rendered result.

**Acceptance:** sports parity on Linux without Docker.

### A9 — Linux headless live-path proof and gate

**Files:**

- Create: `tests/live/desktop-serve-uat.spec.ts` following `tests/live/*-uat.spec.ts`
  conventions, pointed at a `moss serve` instance instead of the compose stack.
- Create: `docs/operations/deploy.md` section "Install without Docker (Linux, command line)".
- Create: `docs/evidence/2026-09-xx-desktop-linux-headless.md` with the recorded run.

- [ ] Fresh data directory on the dev box. Run `moss serve --open`. Complete onboarding.
- [ ] Walk the parity table rows A1 to A8 through the real UI: chat turn, module upload is not
      yet available (B2) so use `moss reconcile` after placing a module zip, sports render, host
      restart button, notes root set with `moss config set notes-roots`, embeddings search in memory.
- [ ] Run the full gate with the verify-gate skill against the served instance's database.
- [ ] Record evidence; open the go/no-go entry in `docs/coordination/AWAITING-BEN.md`.

## Phase A go/no-go

Go requires: A9 evidence recorded; Docker smoke unchanged; every A-lane merged; the isolation
downgrade written into the spec and acknowledged by Ben. No-go outcomes: a capability that cannot
run without Docker on Linux is named, and the plan is revised before any tray work starts.

---

## Phase B — tray shell and desktop behaviours (contracts)

Expand each into step-level tasks after the go/no-go. Builder split as Phase A: shell and UI lanes
Claude, network and update lanes Codex.

### B1 — tray shell (`apps/desktop`)

Electron with no renderer window. Bundles Node (official binary for the platform) and the built
app under `resources/app`, the Postgres bundle under `resources/postgres`. On launch: spawn
`moss serve --data-dir <defaultDataRoot>` with the bundled Node; tray menu from the Phase 0
mockup: Open Moss, LAN address with QR, Share on this network (toggle), Start at login, Check for
updates, Back up now, Quit. Quit runs `moss stop` and waits. Crash of the sidecar shows a tray
notification and offers restart. `electron-builder` targets: AppImage, DMG, NSIS.
**Acceptance:** Linux AppImage boots to onboarding from a fresh data dir; Quit leaves no
postgres process (`pgrep -f <dataDir>` empty).

### B2 — module upload in the app

Admin-gated `POST /api/modules/upload` (zip, size cap from the existing distribution port) writing
into `layout.modulesDir` and requesting reconcile via a control-dir sentinel the launcher services
under the existing advisory lock. Folder watching is a developer flag in `moss.json`
(`devWatchModules: true`), never default. App map and mockup from Phase 0.
**Acceptance:** upload a built external module zip, see it active without a terminal.

### B3 — LAN discovery and dynamic trusted origins

`bonjour-service` advertises `moss.local` when bind is `lan`; launcher computes origins
`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://moss.local:<port>` and one per
current private IPv4/IPv6 address; either better-auth accepts a resolver (verify version 1.6.14
first) or the launcher rewrites the env and restarts api on address change (poll
`os.networkInterfaces()` every 15 s, diff). Firewall: Linux none; macOS prompt is native; Windows
rule added by the installer (C2).
**Acceptance:** phone on the same Wi-Fi opens the QR link and logs in; changing the laptop's
network keeps login working within 30 s.

### B4 — opt-in HTTPS from the launcher

Local CA generated once into the data dir (`node-forge` or `@peculiar/x509`), leaf cert for
`moss.local`, `localhost` and current addresses (reissued on change), served by a small TLS
terminator inside the launcher on `<port>` with plain HTTP moved to `<port>+1` for loopback only.
CA export via QR in the tray and a "Download certificate" row in Host settings. Parity target is
`docs/operations/self-hosted-tls.md`.
**Acceptance:** microphone works from a phone after installing the CA.

### B5 — updates

`electron-updater` against GitHub releases. Update flow: download, then `moss stop`, then swap,
then relaunch. Before swap, compare bundled `PG_VERSION` with the cluster; a mismatch aborts the
update with a message naming the required backup. Version and build id feed the existing Host
settings fields (see #1936, currently blank).
**Acceptance:** AppImage 1.0.0 updates to 1.0.1 with data intact on Linux.

### B6 — backup and restore

`moss backup <out.zip>`: `pg_dump --format=custom` of the app database plus vaults, modules,
`moss.json` and `secrets.env`; `moss restore <zip>` into an empty data dir. "Back up now" in the
tray and Host settings. Docs: replace the volume-snapshot section in `docs/operations/backup.md`
with two subsections, Docker and desktop.
**Acceptance:** backup on one machine, restore on another, log in and see the same data.

---

## Phase C — platform ports (contracts)

### C1 — macOS

Universal or dual builds (arm64, x86_64) of the Postgres bundle via `build-macos.sh` on a macOS
runner; codesign every Mach-O with hardened runtime; entitlements: `allow-jit` off,
`disable-library-validation` only if same-team signing of `vector.dylib` fails the
`CREATE EXTENSION` proof; notarize and staple; data dir in Application Support; refuse to run
translocated (detect `/AppTranslocation/` in the bundle path and tell the user to drag to
Applications); login item via `app.setLoginItemSettings`. Opens with the pgvector-under-notarization
proof before anything else.
**Acceptance:** notarized DMG passes the full parity table on a clean macOS user account.

### C2 — Windows

Postgres from the official EDB binaries zip plus pgvector built with MSVC on a Windows runner;
`initdb` must run non-elevated (installer runs per-user, NSIS `perMachine: false`); firewall rule
via `netsh advfirewall` in the NSIS installer with one elevation prompt; updates stop the cluster
before replacing files (B5 already orders this; prove file locks are released); node-pty
prebuilds for win32-x64; `asar` off for native modules; long path handling verified by installing
under a 60-character user path. Named pipe transport from A3.
**Acceptance:** signed installer passes the full parity table on a clean Windows 11 user.

### C3 — Linux

AppImage x86_64 and arm64; glibc floor Debian bookworm; optional systemd user unit written by
"Start at login"; AppImage is read-only so every write goes to the data dir (already true by A1).
**Acceptance:** AppImage passes the full parity table on Ubuntu 22.04 and Fedora current.

---

## Phase D — parity verification, docs, release (contracts)

### D1 — parity run on all three platforms

The `tests/live/desktop-serve-uat.spec.ts` suite from A9 plus the existing UAT e2e suites pointed
at each installed instance. Evidence per platform in `docs/evidence/`.

### D2 — docs and app map

`docs/operations/deploy.md` gains "Desktop install" at the top; `backup.md`, `self-hosted-tls.md`,
`admin-password-recovery.md` gain desktop subsections; `docs/WHATS_NEW.md` entry via the release
note section of the final PR; app map entries checked against every new screen.

### D3 — release pipeline

`.github/workflows/release-desktop.yml` builds the three installers from the same tag as
`release-image.yml`, uploads to the GitHub release, and publishes the update manifest. One tag,
two distributions.

---

## Downstream dependency map

```
S0 ─┬─ A1 ─┐
    ├─ A2 ─┼─ A5 ─┬─ A6 ─┐
    ├─ A3 ─┤      ├─ A7 ─┼─ A9 ─ go/no-go ─┬─ B1 ─┬─ B2
    └─ A4 ─┘      └─ A8 ─┘                 │      ├─ B3 ─ B4
                                           │      ├─ B5
                                           │      └─ B6
                                           └─ C3 (needs B1) ─┐
                                              C1 (needs B1) ─┼─ D1 ─ D2 ─ D3
                                              C2 (needs B1, A3 win job) ─┘
```

Parallelism: four lanes in Phase A wave one (A1 to A4), three in wave two (A6 to A8), then one
proof lane. Phase B runs B1 first, then up to five lanes. Phase C runs three lanes in parallel
once B1 is merged. Recommended platform order for first release: Linux, macOS, Windows, because
macOS notarization has the longest external lead time and should start as soon as B1 lands.

## Verification and evidence

- Unit and integration files named per lane above run in CI on every PR.
- The Windows named-pipe job (A3) and the embedded Postgres job (A4) are new CI jobs added beside
  existing ones, never replacing them.
- Each user-facing lane records live proof on its PR per the live-path gate: the URL used, the
  account, the screens exercised, and a screenshot cropped to the relevant region saved under
  `tests/screenshots/` or `docs/evidence/`.
- Phase A ends with a recorded walkthrough of the parity table on Linux without Docker.
- Phase D ends with the same walkthrough on each platform, from the installer, on a clean user
  account.
- Docker parity is checked at every phase boundary with the prod compose smoke.

## Rollout and rollback

- Docker remains the production distribution throughout. Prod on port 1533 is not touched by
  this plan except through the shared supervisor refactor (A5), which is proven by the compose
  smoke before merge.
- Desktop releases start as pre-releases on GitHub until D1 is green on all three platforms.
- Data directory carries `schemaVersion` in `moss.json`; a newer app refuses an unknown version
  with a message naming the backup command.
- Rollback of a desktop update is reinstalling the previous installer; the database stays on
  Postgres 17 for the plan's life, so no downgrade path is needed.

## Rulings needed from Ben (add to AWAITING-BEN when a lane blocks on one)

1. Activate #2316 as the epic (it is deferred until Ben says so). (S0)
2. Electron tray shell now, with Tauri as a possible later swap, as this plan assumes? (B1)
3. Chromium downloaded on demand (this plan) or bundled at roughly 150 MB per platform? (A8)
4. First-run default: ask "Share on this network?" (this plan), or default to sharing on? (B1)
5. Apple Developer account and Windows code-signing certificate: who buys and holds them? (C1, C2)
6. Platform order: Linux, macOS, Windows as recommended? (Phase C)
7. Isolation downgrade accepted: cross-account isolation on desktop is RLS plus per-account
   folders under one OS user, matching the production default. (S0)

## Plan acceptance checklist

- [ ] Spec and ADR 0011 approved (S0)
- [ ] Mockups approved for tray, first-run prompt, Host settings rows, module upload (S0)
- [ ] Epic, milestone and task issues on project 2 (S0)
- [ ] Phase A merged, Linux headless evidence recorded, go/no-go answered
- [ ] Phase B expanded to step level and merged
- [ ] Phase C expanded and merged with signed artifacts
- [ ] Phase D parity evidence on three platforms; release pipeline live
