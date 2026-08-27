import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMossEnv } from "@moss/db";

import { deriveTrustedOrigins } from "../../scripts/setup-prod-origins.js";
import { JOB_SEARCH_FIXTURE_CONTAINER_PORT } from "./fixtures/job-search-fixture-server.js";
import { REAL_CHAT_ENV_FILE_RESULT_ENV, writeUatRealChatEnvFile } from "./real-chat-env.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID } from "./seed/admin.js";
import { parseUatSeedLevel } from "./seed/level-validation.js";
import {
  UAT_SUBNET_CANDIDATES,
  findSkippedUatNetworks,
  listLiveDockerSubnets,
  selectUatSubnet
} from "./subnet-selection.js";

export interface UatRunId {
  readonly projectName: string;
  readonly suffix: string;
}

/**
 * #1024/#1000: mirrors scripts/test-integration.ts's `${pid}_${randomHex}` entropy suffix so a
 * local UAT run and a concurrent coordinator UAT run never collide on the same Compose project
 * name (spec §3.2) — Compose project names scope every container/volume/network it creates.
 */
export function generateUatRunId(): UatRunId {
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  return { projectName: `uat-${suffix}`, suffix };
}

/**
 * #1306 Task 22: the `jarv1s` worker container can't reach a fixture server bound on the HOST's
 * 127.0.0.1 — inside the container that address means the container itself.
 *
 * The obvious next move, reaching the host through the Docker bridge network's gateway address,
 * was tried and does not work: the first live run of the board UAT timed out on every crawl fetch
 * because ufw (active on this project's dev box, and the Ubuntu default) drops container traffic
 * arriving at the host's gateway address. Fixing that would mean asking every developer and CI
 * image to add a firewall rule before the suite could pass.
 *
 * So the fixture origin runs as its OWN container on the stack's Compose network, reachable by
 * container name over Docker's embedded DNS. Container-to-container traffic on a user-defined
 * network crosses no host firewall, and the name is derived from the project name — known before
 * the container exists, which is what lets the base URL be written into the stack's env file up
 * front. It is `docker run`, not a Compose service, because the ruling that neither
 * JARVIS_RUNTIME_MODE nor JARVIS_E2E_MODULE_FETCH_BASE may appear in a checked-in compose file
 * applies just as much to the origin they point at.
 */
export function jobSearchFixtureContainerName(projectName: string): string {
  return `${projectName}-jsfixture`;
}

/** The URL the `jarv1s` and `seed` containers use to reach the fixture origin (see above). */
export function jobSearchFixtureBaseUrlFor(projectName: string): string {
  return `http://${jobSearchFixtureContainerName(projectName)}:${JOB_SEARCH_FIXTURE_CONTAINER_PORT}`;
}

/** The line fixture-server-cli.ts prints once its listen() has resolved. */
const FIXTURE_READY_LOG = "[job-search-fixture] listening on";
const FIXTURE_READY_TIMEOUT_MS = 30_000;

/**
 * #1306 Task 22: starts the fixture origin as a detached container on the stack's Compose network
 * and waits until it is genuinely accepting connections.
 *
 * Runs the same image the stack runs, which already carries `tests/uat/fixtures/**` and
 * `node_modules/.bin/tsx` (see .dockerignore's carve-outs) — exactly how the `seed` and
 * `module-install` ops services run repo TypeScript in-network. Nothing is published to the host.
 *
 * The wait polls `docker logs` for the CLI's readiness line rather than sleeping. A fixture that
 * dies at startup surfaces here, as a timeout naming the container, instead of silently much
 * later as "the board has no matches" — which is precisely how the ufw failure this replaced
 * presented, and it cost a 2.7-minute Phase 7 timeout to diagnose.
 */
export async function startJobSearchFixtureContainer(projectName: string): Promise<void> {
  const name = jobSearchFixtureContainerName(projectName);
  await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    `${projectName}_jarv1s`,
    `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
    "node_modules/.bin/tsx",
    "tests/uat/fixtures/fixture-server-cli.ts"
  ]);

  const deadline = Date.now() + FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 2>&1 is not available here (runCapture inherits stderr), and the CLI prints readiness on
    // stdout, so plain `docker logs` is enough.
    const logs = await runCapture("docker", ["logs", name]).catch(() => "");
    if (logs.includes(FIXTURE_READY_LOG)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `job-search fixture container ${name} never reported ready; ` +
      `check \`docker logs ${name}\` before it is removed`
  );
}

/**
 * Removes the fixture container. MUST run before `docker compose down -v`: an outside container
 * still attached to the Compose network blocks the network's removal, which would then trip
 * assertNoLeakedResources on a run that was otherwise clean. Idempotent and never throws — a
 * teardown helper that can fail is a teardown helper that leaks.
 */
export async function removeJobSearchFixtureContainer(projectName: string): Promise<void> {
  await runCommand("docker", ["rm", "--force", jobSearchFixtureContainerName(projectName)]).catch(
    () => {}
  );
}

// #1024/#1000: prod's fixed host port is 1533 (JARVIS_WEB_PORT default). Rather than editing the
// prod-shaped compose file to support a Docker-assigned ephemeral port (spec §3.4 option 2), Phase
// 1 reserves a narrow high port range and bind-probes it (Task 2) — zero compose-file changes,
// same technique already used for JARVIS_DOCKER_SUBNET.
export const UAT_PORT_RANGE_START = 20000;
export const UAT_PORT_RANGE_SIZE = 100;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

/**
 * #1024/#1000: probes UAT_PORT_RANGE candidates in order and returns the first free one. A
 * `probe` override is accepted purely so unit tests can force a deterministic outcome without
 * relying on real OS port state; production callers omit it and get the real bind-probe.
 *
 * #1024 (Coordinator condition 1): this only proves a candidate was free at PROBE time — it
 * cannot close the TOCTOU race against `docker compose up` binding the port moments later in a
 * different process. That race is handled by main() (Task 6): on a real compose bind-conflict
 * exit, main() calls this function again with the remaining untried candidates rather than
 * looping in here. Keep this function a pure single-pass probe; don't add retry logic here.
 */
export async function findAvailablePort(
  candidates: readonly number[],
  probe: (port: number) => Promise<boolean> = isPortFree
): Promise<number> {
  for (const candidate of candidates) {
    if (await probe(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no available port found among candidates: ${candidates.join(", ")}`);
}

export interface UatEnvFile {
  readonly path: string;
  readonly cleanup: () => void;
}

// #1024/#1000: single source of truth for the two dev-only secrets that BOTH get written into the
// env file (container env, via docker-compose.prod.yml's `env_file:`) AND must be exported as real
// process.env vars for compose-file `${...:?}` interpolation (see uatComposeInterpolationEnv below)
// — `env_file:` alone never feeds interpolation, only container env. Same trap as
// scripts/smoke-compose.ts's ensureProdSmokeEnv.
const UAT_POSTGRES_PASSWORD = "postgres";
const UAT_CLI_RUNNER_RPC_SECRET = "uat-only-not-real";

/**
 * #1024/#1000: same shape as scripts/smoke-compose.ts's ensureProdSmokeEnv (throwaway
 * env.production.local + dev-only secrets), but scoped to the UAT subnet/port and pinned to the
 * `stub` embed provider for the `bare` level (no users → nothing to embed → no reason to pull the
 * real embedding model into a per-run, per-project model-cache volume; spec §3.3).
 */
export function writeUatEnvFile(input: {
  readonly webPort: number;
  readonly subnet: string;
  // #1306 Task 22: opt-in, absent by default. When set, activates
  // apps/worker/src/external-module-job-handler.ts's host-side createFetch bypass so the
  // job-search module's crawl hits a fixture origin instead of the real LinkedIn/freehire.me —
  // provisioner-only, per the ruling that neither JARVIS_RUNTIME_MODE nor
  // JARVIS_E2E_MODULE_FETCH_BASE may appear in any checked-in compose file, .env.example, or dev
  // script. See provisionForUat's jobSearchFixture wiring.
  readonly jobSearchFixtureBaseUrl?: string;
  // #1121: the scripted provider (tests/uat/fixtures/scripted-provider/claude-main.ts) reads
  // JARVIS_UAT_SEED_CHAT_SCRIPT from its OWN process env at app runtime, inside the jarv1s
  // container — so it has to be here, not only on composeSeedHook's `docker -e` args. Same
  // runtime-vs-seed-time split as JARVIS_UAT_NEWS_TRANSIENT_INPUT below.
  readonly chatScript?: string;
}): UatEnvFile {
  const dir = mkdtempSync(join(tmpdir(), "jarv1s-uat-"));
  const path = join(dir, "env.production.local");
  try {
    writeFileSync(
      path,
      [
        "NODE_ENV=production",
        `JARVIS_WEB_PORT=${input.webPort}`,
        // #1026: Playwright drives this instance at http://127.0.0.1:<webPort> (see baseURL
        // below), which is a DIFFERENT origin than better-auth's "http://localhost:<port>"
        // default (resolveAuthOriginConfig, packages/auth/src/runtime-config.ts) — 127.0.0.1 and
        // localhost are distinct origins for its exact-string check, so login was rejected with
        // "Invalid origin" until this was added. Reuses the same deriveTrustedOrigins helper
        // scripts/setup-prod.ts uses for real deploys (#379) rather than hand-rolling the list.
        `JARVIS_AUTH_TRUSTED_ORIGINS=${deriveTrustedOrigins({ webPort: String(input.webPort), publicOrigin: "127.0.0.1" })}`,
        `JARVIS_DOCKER_SUBNET=${input.subnet}`,
        `POSTGRES_PASSWORD=${UAT_POSTGRES_PASSWORD}`,
        "JARVIS_BOOTSTRAP_DATABASE_URL=postgres://postgres:postgres@postgres:5432/jarv1s",
        // #1024/#1000: jarvis_migration_owner is NOSUPERUSER/NOBYPASSRLS but schema-owner + a
        // member of jarvis_auth_runtime (infra/postgres/bootstrap/0000_roles.sql) — this is the
        // seam #1025's seed script plugs a privileged connection into. NEVER grant BYPASSRLS to
        // jarvis_app_runtime / jarvis_worker_runtime — that would violate the project's hard "no
        // BYPASSRLS on runtime roles" invariant.
        "JARVIS_MIGRATION_DATABASE_URL=postgres://jarvis_migration_owner:uat-migration-pw@postgres:5432/jarv1s",
        "JARVIS_APP_DATABASE_URL=postgres://jarvis_app_runtime:uat-app-pw@postgres:5432/jarv1s",
        "JARVIS_AUTH_DATABASE_URL=postgres://jarvis_auth_runtime:uat-auth-pw@postgres:5432/jarv1s",
        "JARVIS_WORKER_DATABASE_URL=postgres://jarvis_worker_runtime:uat-worker-pw@postgres:5432/jarv1s",
        "BETTER_AUTH_SECRET=uat-only-not-a-real-secret-00000000000",
        "JARVIS_CONNECTOR_SECRET_KEY=00000000000000000000000000000000",
        "JARVIS_AI_SECRET_KEY=11111111111111111111111111111111",
        // #1024/#1000: required in any non-development/test NODE_ENV since #918 Slice 2
        // (resolveKeyring enforces >=32 bytes) — matches .github/workflows/ci.yml's convention.
        // Caught live by Task 7 (this plan predates #918 landing on main).
        "JARVIS_MODULE_CREDENTIAL_SECRET_KEY=22222222222222222222222222222222",
        // #2005 — same boot-crash class as the line above: resolveKeyring throws at
        // startup when this is missing outside development/test.
        "JARVIS_NEWS_CREDENTIAL_SECRET_KEY=22222222222222222222222222222222",
        `JARVIS_CLI_RUNNER_RPC_SECRET=${UAT_CLI_RUNNER_RPC_SECRET}`,
        // #1883: this one chat script needs a real, local embedding provider so notes.search
        // actually calls out over the network and can hit a real connection failure — every other
        // chat script keeps the stub lines below unchanged (see the #1313 comment on why `bare`
        // depends on staying on stub). Only one of these two provider lines is ever written.
        ...(input.chatScript === "1883-vault-search-dependency-failure"
          ? [
              "JARVIS_EMBED_PROVIDER=local",
              "NODE_OPTIONS=--import=/app/tests/uat/fixtures/embedding-refused.mjs"
            ]
          : [
              "JARVIS_EMBED_PROVIDER=stub",
              // #1313: this instance runs NODE_ENV=production above (not the vitest
              // NODE_ENV=test signal), so without this explicit escape hatch
              // createEmbeddingProvider would now refuse "stub" and silently fall back to
              // "local" -- reintroducing exactly the real-model download into a per-run cache
              // volume this UAT `bare` level exists to avoid.
              "JARVIS_ALLOW_STUB_EMBEDDINGS=1"
            ]),
        `JARVIS_NOTES_ROOTS=/data/vaults/${UAT_ADMIN_ID}`,
        // #1110: module-registry's buildUatNewsPreviewOverride() reads these at app runtime (not
        // seed-time) to deterministically fake a transient News preview error for one sentinel
        // input — hence env_file: here, not the seed container's docker -e args below.
        "JARVIS_UAT_SEED_CONFIRM=1",
        "JARVIS_UAT_NEWS_TRANSIENT_INPUT=uat-transient.invalid",
        // #1121: absent unless a spec declares uatLevel.chatScript. Omitted rather than written
        // empty so a stack with no scripted chat never hands the provider a "" it would reject.
        ...(input.chatScript ? [`JARVIS_UAT_SEED_CHAT_SCRIPT=${input.chatScript}`] : []),
        // #1659 defect 4: a dedicated PATH entry for the scripted provider's own bin/claude,
        // read by Dockerfile:72's profile.d script — deliberately NOT JARVIS_CLI_TOOLS_PREFIX,
        // which is also the production installer's toolsPrefix (install-service.ts's
        // reconcileInstalledProviders clobbers whatever sits at ${toolsPrefix}/bin/claude with
        // the real CLI on every boot). Same absent-unless-set shape as the line above.
        ...(input.chatScript
          ? ["JARVIS_UAT_SCRIPTED_PROVIDER_BIN=/app/tests/uat/fixtures/scripted-provider/bin"]
          : []),
        // #1306 Task 22: absent unless a caller passes jobSearchFixtureBaseUrl — see this
        // function's param doc. JARVIS_RUNTIME_MODE alone (without the base URL) would throw at
        // host boot per resolveE2eFetchOverride's fail-closed guard, so these two are written
        // together or not at all.
        ...(input.jobSearchFixtureBaseUrl
          ? [
              "JARVIS_RUNTIME_MODE=e2e",
              `JARVIS_E2E_MODULE_FETCH_BASE=${input.jobSearchFixtureBaseUrl}`
            ]
          : []),
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
  } catch (error) {
    rmSync(dir, { force: true, recursive: true });
    throw error;
  }
  return { path, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}

/**
 * #1024/#1000: docker-compose.prod.yml interpolates JARVIS_WEB_PORT/JARVIS_DOCKER_SUBNET (with
 * defaults that are the PROD port 1533 and PROD subnet 10.251.0.0/24 — silently wrong, not an
 * error, if left unset) and POSTGRES_PASSWORD/JARVIS_CLI_RUNNER_RPC_SECRET (`:?`-required, hard
 * error if unset) directly in the compose YAML via `${...}`. `env_file:` (writeUatEnvFile above)
 * only injects vars into the CONTAINER's env, never into compose-file interpolation — so every one
 * of these must ALSO be exported as a real process.env var before any `docker compose` invocation,
 * or `config --quiet` fails hard on the two required ones and would silently collide with a real
 * prod instance on the other two. Caught live by Task 7's first run (#1024) — the exact
 * deploy-compose-env-trap this project has hit before.
 *
 * #1468 (B2): MOSS_RECONCILE_CONFIRM_OWNER_EMAIL is the same `${...:-}`-interpolated shape on the
 * `jarv1s` service (empty default, not `:?`-required — a fresh install has no bootstrap owner to
 * confirm). module-install.uat.spec.ts seeds UAT_ADMIN_EMAIL as `isBootstrapOwner: true`
 * (tests/uat/seed/admin.ts), so the boot-time `module-reconcile.ts` one-shot
 * (start-jarv1s.ts -> assertReconcileTargetIdentity) refuses to proceed on `restartUatStack`'s
 * `docker compose restart jarv1s` unless this was already set at the `up -d jarv1s --wait` step
 * below — `restart` reruns the container's existing env, it does not re-interpolate. Belongs here,
 * not in writeUatEnvFile: `restartUatStack` uses `restart`, not `run`, so there is no `-e` flag to
 * lean on the way the `seed` service's JARVIS_UAT_SEED_CONFIRM does.
 */
export function uatComposeInterpolationEnv(input: {
  readonly webPort: number;
  readonly subnet: string;
}): Readonly<Record<string, string>> {
  return {
    JARVIS_WEB_PORT: String(input.webPort),
    JARVIS_DOCKER_SUBNET: input.subnet,
    POSTGRES_PASSWORD: UAT_POSTGRES_PASSWORD,
    JARVIS_CLI_RUNNER_RPC_SECRET: UAT_CLI_RUNNER_RPC_SECRET,
    MOSS_RECONCILE_CONFIRM_OWNER_EMAIL: UAT_ADMIN_EMAIL
  };
}

export type UatSeedLevel = "bare" | "solo-admin" | "admin+data" | "multi-user";

export type SeedHook = (ctx: {
  readonly projectName: string;
  readonly level: UatSeedLevel;
  readonly excludeChunks?: readonly string[];
  readonly withoutNewsJsonBinding?: boolean;
  /** N42/#57: the job-search fixture's docker-reachable base URL — see provisionForUat's
   *  jobSearchFixtureBaseUrl computation. Absent unless withJobSearchFixture is set. */
  readonly jobSearchAiProviderBaseUrl?: string;
  readonly sportsPublicSourceFixtures?: boolean;
  /** #1121 Task 4: an id from UAT_CHAT_SCRIPTS. Consumed by Task 5's seed/cli.ts wiring
   *  (blocked on #1557) — until then this reaches the seed service but nothing reads it. */
  readonly chatScript?: string;
}) => Promise<void>;

// #1024/#1000: Phase 1 ships zero seed data by design (spec §8.1 acceptance = bare level only).
export const bareSeedHook: SeedHook = async () => {};

/**
 * #1025: runs tests/uat/seed/cli.ts as a one-shot `seed` ops-profile compose
 * service (same network-reachability reason `migrate` runs as a compose
 * service, not a host script — postgres publishes no host port).
 *
 * JARVIS_UAT_SEED_CONFIRM=1 is the entrypoint-side half of the Coordinator's
 * binding prod-guard: composeSeedHook is the ONLY caller that sets it, so
 * cli.ts (Task 6) refuses to run for anything else that might invoke the
 * `seed` service against a non-ephemeral stack.
 */
export const composeSeedHook: SeedHook = async ({
  projectName,
  level,
  excludeChunks,
  withoutNewsJsonBinding,
  jobSearchAiProviderBaseUrl,
  sportsPublicSourceFixtures,
  chatScript
}) => {
  await runCommand(
    "docker",
    buildUatComposeArgs(projectName, [
      "--profile",
      "ops",
      "run",
      "--rm",
      "-e",
      `JARVIS_UAT_SEED_LEVEL=${level}`,
      "-e",
      `JARVIS_UAT_SEED_EXCLUDE_CHUNKS=${(excludeChunks ?? []).join(",")}`,
      "-e",
      `JARVIS_UAT_WITHOUT_NEWS_JSON_BINDING=${withoutNewsJsonBinding === true ? "1" : "0"}`,
      "-e",
      // N42/#57: empty string reads as absent in cli.ts (`|| undefined`) — same "always pass,
      // empty means off" shape as the other -e values here, rather than omitting the flag
      // entirely.
      `MOSS_UAT_JOB_SEARCH_AI_BASE_URL=${jobSearchAiProviderBaseUrl ?? ""}`,
      "-e",
      `JARVIS_UAT_SPORTS_PUBLIC_SOURCE_FIXTURES=${sportsPublicSourceFixtures === true ? "1" : "0"}`,
      "-e",
      // #1121 Task 4: same "always pass, empty means off" shape. Nothing reads this yet —
      // Task 5 (blocked on #1557) adds the cli.ts consumer.
      `JARVIS_UAT_SEED_CHAT_SCRIPT=${chatScript ?? ""}`,
      "-e",
      "JARVIS_UAT_SEED_CONFIRM=1",
      "seed"
    ])
  );
};

export interface UatComposeCommand {
  readonly args: readonly string[];
  readonly command: "docker";
  readonly description: string;
}

const UAT_COMPOSE_FILE = "infra/docker-compose.prod.yml";

// #1024/#1000: every docker invocation MUST go through this so project-name scoping (and
// therefore volume/network isolation, spec §3.3) can never be forgotten at a call site.
export function buildUatComposeArgs(
  projectName: string,
  extra: readonly string[]
): readonly string[] {
  return ["compose", "-p", projectName, "-f", UAT_COMPOSE_FILE, ...extra];
}

/**
 * #1024/#1000: spec §3.2's exact invocation shape — config validate, postgres up, migrate (ops
 * profile), seed hook, jarv1s up, teardown. `down -v` is always last so a caller that iterates
 * this array and stops early on failure still knows what MUST run in its `finally` (Task 6 does
 * exactly that rather than iterating this array to completion on error).
 */
export function createUatProvisionPlan(input: {
  readonly projectName: string;
  readonly seedHook: SeedHook;
}): readonly UatComposeCommand[] {
  const { projectName } = input;
  return [
    {
      command: "docker",
      args: buildUatComposeArgs(projectName, ["config", "--quiet"]),
      description: "Validate Docker Compose configuration"
    },
    {
      command: "docker",
      args: buildUatComposeArgs(projectName, ["up", "-d", "postgres", "--wait"]),
      description: "Start Postgres and wait for readiness"
    },
    {
      command: "docker",
      args: buildUatComposeArgs(projectName, ["--profile", "ops", "run", "--rm", "migrate"]),
      description: "Run database migrations"
    },
    {
      command: "docker",
      args: buildUatComposeArgs(projectName, ["up", "-d", "jarv1s", "--wait"]),
      description: "Start Jarv1s and wait for readiness"
    },
    {
      command: "docker",
      args: buildUatComposeArgs(projectName, ["down", "-v"]),
      description: "Tear down the UAT stack and its volumes"
    }
  ];
}

// #1024/#1000: Compose auto-scopes named volumes as `<project>_<volume>` — this list exists so
// assertNoLeakedResources can positively confirm `down -v` actually removed every one of them,
// not just that the command exited 0 (spec §3.3's "clean by construction" claim, verified).
export function expectedUatVolumeNames(projectName: string): readonly string[] {
  return [
    "jarv1s-postgres-data",
    "jarv1s-vault-data",
    "jarv1s-model-cache",
    "jarv1s-cli-tools",
    "jarv1s-cli-auth",
    "jarv1s-cli-socket",
    "jarv1s-modules"
  ].map((volume) => `${projectName}_${volume}`);
}

function runCapture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with status ${code ?? "unknown"}`));
    });
  });
}

/**
 * #1024/#1000: positive proof that `down -v` actually left nothing behind — the Phase 1
 * acceptance criterion is "tears down clean (no leftover containers/volumes/networks)", not just
 * "the down command exited 0". Throws with the leaked names so a failed run is loud, not a silent
 * resource leak discovered later by `docker system df` creeping up.
 */
export async function assertNoLeakedResources(projectName: string): Promise<void> {
  const [containers, volumes, networks] = await Promise.all([
    runCapture("docker", ["ps", "-a", "--filter", `name=${projectName}`, "--format", "{{.Names}}"]),
    runCapture("docker", [
      "volume",
      "ls",
      "--filter",
      `name=${projectName}`,
      "--format",
      "{{.Name}}"
    ]),
    runCapture("docker", [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format",
      "{{.Name}}"
    ])
  ]);
  const leakedContainers = containers.split("\n").filter(Boolean);
  const leakedVolumes = volumes.split("\n").filter(Boolean);
  const leakedNetworks = networks.split("\n").filter(Boolean);
  if (leakedContainers.length > 0 || leakedVolumes.length > 0 || leakedNetworks.length > 0) {
    throw new Error(
      `UAT teardown leaked resources for ${projectName}: containers=${JSON.stringify(
        leakedContainers
      )} volumes=${JSON.stringify(leakedVolumes)} networks=${JSON.stringify(leakedNetworks)}`
    );
  }
}

export async function cleanupUatAttempt(input: {
  readonly teardownCompose: () => Promise<void>;
  readonly assertNoLeaks: () => Promise<void>;
  readonly cleanupEnvFile: () => void;
  readonly cleanupRunScopedState: () => void;
  readonly error?: unknown;
  readonly preserveRunScopedState?: boolean;
}): Promise<void> {
  const errors: unknown[] = Object.hasOwn(input, "error") ? [input.error] : [];
  try {
    for (const cleanup of [input.teardownCompose, input.assertNoLeaks]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    try {
      input.cleanupEnvFile();
    } catch (error) {
      errors.push(error);
    } finally {
      if (!input.preserveRunScopedState || errors.length > 0) {
        try {
          input.cleanupRunScopedState();
        } catch (error) {
          errors.push(error);
        }
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "UAT teardown and cleanup failed");
}

// #1024/#1000: thrown only when a command's failure looks like a lost port-bind race (see
// runCommand below) so main()'s retry loop can distinguish "retry with next port" from every
// other failure mode, which should abort the run instead of masking a real error.
class PortBindConflictError extends Error {}
class SubnetOverlapConflictError extends Error {}

const PORT_BIND_CONFLICT_PATTERN = /port is already allocated|address already in use|bind.*failed/i;
const SUBNET_OVERLAP_CONFLICT_PATTERN = /pool overlaps with other one on this address space/i;

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    // #1024/#1000: stdout stays "inherit" for live operator visibility; stderr is piped so we can
    // inspect it for the port-bind-conflict signature, but every chunk is still forwarded to the
    // real stderr as it arrives so nothing is lost from the operator's view.
    const child = spawn(command, args, { stdio: ["inherit", "inherit", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      if (PORT_BIND_CONFLICT_PATTERN.test(stderr)) {
        reject(
          new PortBindConflictError(`${command} ${args.join(" ")} exited ${code ?? "unknown"}`)
        );
        return;
      }
      if (SUBNET_OVERLAP_CONFLICT_PATTERN.test(stderr)) {
        reject(
          new SubnetOverlapConflictError(`${command} ${args.join(" ")} exited ${code ?? "unknown"}`)
        );
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with status ${code ?? "unknown"}`));
    });
  });
}

async function waitForReady(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as {
          readonly ok?: unknown;
          readonly db?: unknown;
          readonly pgboss?: unknown;
        };
        // #1024/#1000: same readiness contract as scripts/smoke-compose.ts's waitForHealth
        // (#171) — /health/ready, not /health, and assert db+pgboss individually so a payload
        // change can't silently let a DB-down bare instance read as "reachable".
        if (body.ok === true && body.db === "ok" && body.pgboss === "ok") {
          return;
        }
        lastError = new Error(
          `readiness not satisfied: ${JSON.stringify({ db: body.db, pgboss: body.pgboss })}`
        );
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError ?? "health check failed")}`);
}

export interface UatProvisionOptions {
  readonly excludeChunks?: readonly string[];
  readonly withoutNewsJsonBinding?: boolean;
  // #1306 Task 22: opt-in, absent by default — mirrors REAL_CHAT_TOKEN_TRIGGER_ENV's "no-op
  // unless asked" shape. tests/uat/run-uat.ts threads this from job-search-board.uat.spec.ts's
  // exported `uatLevel` object. One flag turns on the whole fixture-backed pipeline: the crawl
  // fetch bypass (jobSearchFixtureBaseUrl -> writeUatEnvFile) AND, per N42/#57, the fake
  // `openai-compatible` AI provider seeded for scoring (same base URL, threaded into
  // composeSeedHook below) — both point at the one fixture origin this starts.
  readonly withJobSearchFixture?: boolean;
  /** #1909: opt-in recovery fixtures used only by its dedicated live-path spec. */
  readonly withSportsPublicSourceFixtures?: boolean;
  /** #1121 Task 4: an id from UAT_CHAT_SCRIPTS (tests/uat/seed/types.ts). Threads to
   *  composeSeedHook's chatScript ctx field, and (when set) writes JARVIS_UAT_SCRIPTED_PROVIDER_BIN
   *  (#1659 defect 4) so the container's profile.d script puts the scripted-provider fixture's
   *  own bin/ ahead of the real tools bin on PATH — never JARVIS_CLI_TOOLS_PREFIX, which the
   *  production installer also owns. */
  readonly chatScript?: string;
}

export function buildSeedHookInput(
  projectName: string,
  level: UatSeedLevel,
  opts?: UatProvisionOptions,
  // N42/#57: NOT part of UatProvisionOptions — provisionForUat computes this itself (the fixture
  // server's docker-reachable base URL) and passes it through explicitly, the same way it already
  // threads jobSearchFixtureBaseUrl into writeUatEnvFile below, rather than asking every caller of
  // UatProvisionOptions to compute a Docker bridge gateway address by hand.
  jobSearchAiProviderBaseUrl?: string
): {
  projectName: string;
  level: UatSeedLevel;
  excludeChunks?: readonly string[];
  withoutNewsJsonBinding?: boolean;
  jobSearchAiProviderBaseUrl?: string;
  sportsPublicSourceFixtures?: boolean;
  chatScript?: string;
} {
  return {
    projectName,
    level,
    excludeChunks: opts?.excludeChunks,
    withoutNewsJsonBinding: opts?.withoutNewsJsonBinding,
    jobSearchAiProviderBaseUrl,
    sportsPublicSourceFixtures: opts?.withSportsPublicSourceFixtures,
    chatScript: opts?.chatScript
  };
}

export async function restartUatStack(projectName: string, baseURL: string): Promise<void> {
  // #1026/#999: found live — `docker compose up -d jarv1s` is a documented Compose no-op when the
  // service's computed config (image digest/env/volumes) is unchanged, which it always is here: a
  // module "Download" only writes into the jarv1s-modules volume + a DB row
  // (packages/module-registry/src/distribution/pipeline.ts's downloadAndStageModule), never the
  // image or compose config `up -d` diffs against. scripts/module-reconcile.ts only runs as a
  // boot-time one-shot (scripts/start-jarv1s.ts), so a no-op `up -d` means it never reruns and the
  // module never leaves "Downloaded — restart to apply". `docker compose restart` kills+restarts
  // the SAME container (unlike `up -d`, it is not gated on a config diff), which reruns
  // start-jarv1s.ts's CMD from scratch — including migrate + module-reconcile — every time. This is
  // a harness fix only: settings-module-registry-section.tsx's operator-facing copy still tells
  // real operators to run `docker compose pull && docker compose up -d`, which hits this exact
  // no-op when no new image tag was pulled — that product-level UX gap is out of scope for #1026
  // and must be flagged as its own issue, not silently routed around here.
  await runCommand("docker", buildUatComposeArgs(projectName, ["restart", "jarv1s"]));
  await waitForReady(`${baseURL}/health/ready`);
}

export async function provisionForUat(
  level: UatSeedLevel,
  opts?: UatProvisionOptions,
  dependencies: {
    readonly listLiveSubnets?: typeof listLiveDockerSubnets;
    readonly writeRealChatEnvFile?: typeof writeUatRealChatEnvFile;
  } = {}
): Promise<{ baseURL: string; projectName: string; teardown: () => Promise<void> }> {
  const overallStart = Date.now();
  // #1024/#1000: bounded by the reserved range itself (100 candidates) — never an unbounded
  // retry. Each failed-on-bind attempt removes its port from the pool; exhausting the pool means
  // the whole reserved range is hostile, which should fail loudly, not spin forever.
  let remainingCandidates = Array.from(
    { length: UAT_PORT_RANGE_SIZE },
    (_, i) => UAT_PORT_RANGE_START + i
  );
  let remainingSubnetCandidates = [...UAT_SUBNET_CANDIDATES];
  let imageBuilt = false; // build once; a port-bind retry shouldn't rebuild the image

  // #1121: opt-in, before the loop so JARVIS_UAT_REAL_CHAT_ENV_FILE is exported once (and inherited
  // by the Playwright child run-uat.ts spawns) before any composeSeedHook interpolates the seed
  // service's second env_file entry. A no-op (returns undefined) unless the operator set
  // JARVIS_UAT_REAL_CHAT_TOKEN_FILE, so default/CI runs are unchanged; a configured-but-malformed
  // token file throws here and aborts the run loudly rather than silently degrading to a
  // credential-free run. Held for the whole function: the success path hands cleanup to the returned
  // teardown; terminal failures clean up below.
  const previousRealChatEnvFile = process.env[REAL_CHAT_ENV_FILE_RESULT_ENV];
  const realChatEnvFile = await (dependencies.writeRealChatEnvFile ?? writeUatRealChatEnvFile)();

  let runStateCleaned = false;
  const cleanupRunScopedState = () => {
    if (runStateCleaned) return;
    try {
      realChatEnvFile?.cleanup();
    } finally {
      if (previousRealChatEnvFile === undefined) {
        delete process.env[REAL_CHAT_ENV_FILE_RESULT_ENV];
      } else {
        process.env[REAL_CHAT_ENV_FILE_RESULT_ENV] = previousRealChatEnvFile;
      }
      runStateCleaned = true;
    }
  };
  const cleanupRunScopedStateAfterError = (error: unknown): never => {
    try {
      cleanupRunScopedState();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "UAT setup and cleanup failed", {
        cause: cleanupError
      });
    }
    throw error;
  };

  while (remainingCandidates.length > 0) {
    const { projectName } = generateUatRunId();
    let webPort: number;
    let liveSubnets: Awaited<ReturnType<typeof listLiveDockerSubnets>>;
    let subnet: ReturnType<typeof selectUatSubnet>;
    try {
      webPort = await findAvailablePort(remainingCandidates);
      liveSubnets = await (dependencies.listLiveSubnets ?? listLiveDockerSubnets)();
      subnet = selectUatSubnet({
        requested: process.env.UAT_DOCKER_SUBNET,
        live: liveSubnets,
        candidates: remainingSubnetCandidates
      });
    } catch (error) {
      return cleanupRunScopedStateAfterError(error);
    }
    if (subnet.source === "auto") {
      for (const network of findSkippedUatNetworks(liveSubnets, remainingSubnetCandidates)) {
        console.warn(
          `[uat] skipping subnet ${network.subnet} held by existing UAT network ${network.networkName}`
        );
      }
    }
    // #1306 Task 22: opt-in (see UatProvisionOptions.withJobSearchFixture). Unlike
    // realChatEnvFile above this is per-attempt, not once before the loop: the fixture is a
    // container on THIS attempt's Compose network, so a port-bind retry gets a fresh one under
    // the new project name. The URL is knowable now — it is just the container's name — which is
    // what lets it be written into the env file the stack starts with, several steps before the
    // container itself exists.
    const jobSearchFixtureBaseUrl = opts?.withJobSearchFixture
      ? jobSearchFixtureBaseUrlFor(projectName)
      : undefined;
    let envFile!: UatEnvFile;
    try {
      envFile = writeUatEnvFile({
        webPort,
        subnet: subnet.subnet,
        jobSearchFixtureBaseUrl,
        chatScript: opts?.chatScript
      });
      process.env.JARVIS_ENV_FILE = envFile.path;
      process.env.JARVIS_IMAGE_TAG ??= "uat-smoke";
      // #1024/#1000: must be exported for every retry iteration, not just the first — a TOCTOU
      // port-bind retry picks a new webPort, and JARVIS_WEB_PORT must track it or compose would
      // interpolate the stale (or default/prod) port. See uatComposeInterpolationEnv's doc comment.
      Object.assign(process.env, uatComposeInterpolationEnv({ webPort, subnet: subnet.subnet }));
    } catch (error) {
      return cleanupRunScopedStateAfterError(error);
    }

    // #1306: the fixture container is removed FIRST — an outside container still attached to the
    // Compose network blocks `down -v` from removing that network, and the leak assertion that
    // follows would then fail on an otherwise clean run.
    const teardownCompose = async () => {
      await removeJobSearchFixtureContainer(projectName);
      await runCommand("docker", buildUatComposeArgs(projectName, ["down", "-v"])).catch(
        (error) => {
          console.error(`teardown failed for ${projectName}:`, error);
        }
      );
      const ownedNetworks = await runCapture("docker", [
        "network",
        "ls",
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
        "--format",
        "{{.ID}}"
      ]).catch(() => "");
      for (const networkId of ownedNetworks.split("\n").filter(Boolean)) {
        await runCommand("docker", ["network", "rm", networkId]).catch(() => {});
      }
    };
    const cleanupAttempt = (
      options: { readonly error?: unknown; readonly preserveRunScopedState?: boolean } = {}
    ) =>
      cleanupUatAttempt({
        teardownCompose,
        assertNoLeaks: () => assertNoLeakedResources(projectName),
        cleanupEnvFile: envFile.cleanup,
        cleanupRunScopedState,
        ...options
      });

    try {
      console.log(
        `[uat] provisioning ${projectName} on port ${webPort} subnet ${subnet.subnet} (${subnet.source})`
      );
      if (resolveMossEnv(process.env, "JARVIS_UAT_BUILD") !== "0" && !imageBuilt) {
        await runCommand("docker", [
          "build",
          "-t",
          `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG}`,
          "-f",
          "Dockerfile",
          "."
        ]);
        imageBuilt = true;
      }
      const plan = createUatProvisionPlan({ projectName, seedHook: bareSeedHook });
      for (const step of plan.slice(0, -1)) {
        // #1024/#1000: the plan's LAST entry is always `down -v` (Task 4) — deliberately excluded
        // from this loop and run once, in the catch/return paths below. Running it here too would
        // double-run teardown on the success path.
        console.log(`[uat] ${step.description}`);
        await runCommand(step.command, step.args);
      }
      // #1306: after the plan loop, because the Compose network it attaches to does not exist
      // until the first `up`; before the seed hook, so the fixture origin is already answering by
      // the time anything can reach for it.
      if (jobSearchFixtureBaseUrl !== undefined) {
        console.log(`[uat] starting job-search fixture origin at ${jobSearchFixtureBaseUrl}`);
        await startJobSearchFixtureContainer(projectName);
      }
      await composeSeedHook(buildSeedHookInput(projectName, level, opts, jobSearchFixtureBaseUrl));
      const baseURL = `http://127.0.0.1:${webPort}`;
      await waitForReady(`${baseURL}/health/ready`);
      console.log(`[uat] reachable at ${baseURL} after ${Date.now() - overallStart}ms`);
      return {
        baseURL,
        projectName,
        // #1026: deferred, not auto-run — a caller running Playwright against this stack needs it
        // alive between provision and its own explicit teardown() call, so this can no longer live
        // in a `finally` here. SIGINT/SIGTERM handling moves to the caller (tests/uat/run-uat.ts),
        // which is the one that knows when a long-running Playwright child should be interrupted.
        teardown: async () => {
          await cleanupAttempt();
        }
      };
    } catch (error) {
      if (error instanceof PortBindConflictError) {
        await cleanupAttempt({ preserveRunScopedState: true });
        // #1024/#1000: Coordinator condition 1 — findAvailablePort (Task 2) only proved this port
        // free at probe time; docker just told us another process won the bind race. Retry with
        // the next untried candidate instead of flaking the whole gate. The fixture container (if
        // any) went down with teardownCompose above and is recreated under the next project name.
        console.warn(
          `[uat] port ${webPort} lost the bind race after probing free; retrying with next candidate (#1024)`
        );
        remainingCandidates = remainingCandidates.filter((port) => port !== webPort);
        continue;
      }
      if (error instanceof SubnetOverlapConflictError && subnet.source === "auto") {
        await cleanupAttempt({ preserveRunScopedState: true });
        console.warn(
          `[uat] subnet ${subnet.subnet} lost the allocation race; retrying with next candidate (#1108)`
        );
        remainingSubnetCandidates = remainingSubnetCandidates.filter(
          (candidate) => candidate !== subnet.subnet
        );
        continue;
      }
      await cleanupAttempt({ error });
      throw error; // unreachable: cleanupUatAttempt rethrows the provisioning failure
    }
  }
  return cleanupRunScopedStateAfterError(
    new Error(
      `exhausted all ${UAT_PORT_RANGE_SIZE} reserved UAT ports (${UAT_PORT_RANGE_START}-${
        UAT_PORT_RANGE_START + UAT_PORT_RANGE_SIZE - 1
      }) without a successful bind`
    )
  );
}

async function main(): Promise<void> {
  const overallStart = Date.now();
  // #1087 finding 5: same fail-closed parse as tests/uat/seed/cli.ts — this
  // standalone entrypoint had its own identical unvalidated `as UatSeedLevel`
  // cast on the same env var, so a typo here silently defaulted this direct
  // path into provisioning against an unintended level too.
  const level = parseUatSeedLevel(process.env.JARVIS_UAT_SEED_LEVEL ?? "bare") as UatSeedLevel;
  const { teardown } = await provisionForUat(level);
  await teardown();
  console.log(`[uat] provision+teardown wall-clock: ${Date.now() - overallStart}ms`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
