import type { N3BuildEvidence } from "./n3-fallback-observer-installed.js";
import { prepareN3Observer, type UatProvisionOptions } from "./provisioner-options.js";
export type { UatProvisionOptions } from "./provisioner-options.js";
import { createLifecycleRecorder, type LifecycleAttempt } from "./lifecycle-records.js";
import { buildUatComposeArgs } from "./compose-args.js";
export { buildUatComposeArgs } from "./compose-args.js";
import * as newsFeedbackFixture from "./fixtures/news-feedback-fixture-container.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMossEnv } from "@moss/db";

import { JOB_SEARCH_FIXTURE_CONTAINER_PORT } from "./fixtures/job-search-fixture-server.js";
import * as briefingWriter from "./briefing-writer-container.js";

export {
  briefingWriterFixtureBaseUrlFor,
  briefingWriterFixtureContainerName
} from "./briefing-writer-container.js";
import {
  classifierFixtureBaseUrlFor,
  removeClassifierFixtureContainer,
  startClassifierFixtureContainer
} from "./fixtures/classifier-fixture-container.js";
import { CLAUDE_TOKEN_REUSED_ENV } from "./claude-signin-handoff.js";
import * as mcpFixture from "./classifier-mcp-fixture-container.js";
import {
  REAL_CHAT_CONFIGURED_ENV,
  installUatRealChatAuth,
  uatRealChatProvider,
  type UatRealChatAuth
} from "./real-chat-env.js";
import * as apiKeyChatEnv from "./api-key-chat-env.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID } from "./seed/admin.js";
import { parseUatSeedLevel } from "./seed/level-validation.js";
import {
  UAT_SUBNET_CANDIDATES,
  findSkippedUatNetworks,
  listLiveDockerSubnets,
  selectUatSubnet
} from "./subnet-selection.js";
import {
  UAT_CLI_RUNNER_RPC_SECRET,
  UAT_POSTGRES_PASSWORD,
  writeUatEnvFile,
  type UatEnvFile
} from "./env-file.js";

export { writeUatEnvFile };
export type { UatEnvFile };

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
  const name = jobSearchFixtureContainerName(projectName);
  const existing = await runCapture("docker", ["ps", "-aq", "--filter", `name=^/${name}$`]).catch(
    () => "unknown" // Discovery failure must not prevent the cleanup attempt.
  );
  if (existing.trim()) await runCommand("docker", ["rm", "--force", name]).catch(() => {});
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
  /** [task:p8-briefing-writer-unreachable]: docker-reachable writer-fixture base URL. Absent unless withBriefingWriterFixture is set. */
  readonly briefingWriterAiProviderBaseUrl?: string;
  readonly classifierFixtureAiProviderBaseUrl?: string;
  readonly newsFeedbackFixtureBaseUrl?: string;
  readonly sportsPublicSourceFixtures?: boolean;
  readonly workflowApprovalFixture?: boolean;
  /** #2175: three seeded audit-log rows (suppressed / refused / success+duration). */
  readonly activityOutcomeFixture?: boolean;
  /** #2267: opt-in trusted owner-draft fixture for the Workshop storage proof. */
  readonly withWorkshopStorageFixture?: boolean;
  /** #1121 Task 4: an id from UAT_CHAT_SCRIPTS. Consumed by Task 5's seed/cli.ts wiring
   *  (blocked on #1557) — until then this reaches the seed service but nothing reads it. */
  readonly chatScript?: string;
  /** #3410: opt-in API-key chat provider. The key file is mounted read-only into the seed container. */
  readonly apiKeyChat?: apiKeyChatEnv.ApiKeyChatUatProvider;
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
  briefingWriterAiProviderBaseUrl,
  classifierFixtureAiProviderBaseUrl,
  newsFeedbackFixtureBaseUrl,
  sportsPublicSourceFixtures,
  workflowApprovalFixture,
  activityOutcomeFixture,
  withWorkshopStorageFixture,
  chatScript,
  apiKeyChat
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
      // [task:p8-briefing-writer-unreachable]: empty string reads as absent in cli.ts
      // (`|| undefined`) — same "always pass, empty means off" shape as the job-search var.
      `MOSS_UAT_BRIEFING_WRITER_AI_BASE_URL=${briefingWriterAiProviderBaseUrl ?? ""}`,
      "-e",
      `MOSS_UAT_CLASSIFIER_FIXTURE_AI_BASE_URL=${classifierFixtureAiProviderBaseUrl ?? ""}`,
      "-e",
      `MOSS_UAT_NEWS_FEEDBACK_FIXTURE_BASE_URL=${newsFeedbackFixtureBaseUrl ?? ""}`,
      "-e",
      `JARVIS_UAT_SPORTS_PUBLIC_SOURCE_FIXTURES=${sportsPublicSourceFixtures === true ? "1" : "0"}`,
      "-e",
      `JARVIS_UAT_WORKFLOW_APPROVAL_FIXTURE=${workflowApprovalFixture === true ? "1" : "0"}`,
      "-e",
      `JARVIS_UAT_ACTIVITY_OUTCOME_FIXTURE=${activityOutcomeFixture === true ? "1" : "0"}`,
      "-e",
      `JARVIS_UAT_WORKSHOP_STORAGE_FIXTURE=${withWorkshopStorageFixture === true ? "1" : "0"}`,
      "-e",
      // #1121 Task 4: same "always pass, empty means off" shape. Nothing reads this yet —
      // Task 5 (blocked on #1557) adds the cli.ts consumer.
      `JARVIS_UAT_SEED_CHAT_SCRIPT=${chatScript ?? ""}`,
      ...apiKeyChatEnv.apiKeyChatSeedArgs(apiKeyChat),
      "-e",
      "JARVIS_UAT_SEED_CONFIRM=1",
      "seed"
    ]),
    apiKeyChatEnv.apiKeyChatSeedProcessEnv()
  );
};

export interface UatComposeCommand {
  readonly args: readonly string[];
  readonly command: "docker";
  readonly description: string;
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
 * #2173: retains bounded app evidence (one health read) plus the 3 newest Claude print-engine
 * transcripts under the chat engine's configured CLI home base, `$HOME` as fallback — #2164 r17)
 * before the terminal-failure branch tears down. Compose project/service scoped
 * (buildUatComposeArgs), never the compose file's hardcoded container name, a bare
 * `docker inspect`, or the settings file (#2173 comment 5497191033 section 4). Also used by
 * run-uat.ts's spec-level failure path (#2164).
 *
 * #2164 r18: also retains the full (untailed) `postgres` service log — the app deliberately never
 * re-logs a thrown database error's SQLSTATE/constraint/statement (#1251 hostile-object rule),
 * but Postgres already writes all three to its own container log, which teardown would otherwise
 * discard first.
 *
 * #2164 r19: transcript capture used to `tail -c 4000` each file, cutting off the exact tool
 * call/response that would show the root cause. Now captures each transcript in full.
 *
 * #2164 r21: the `jarv1s` service log was still `--tail 50`, cutting off the per-turn `mcp
 * tools/list observed` line (`mcp-transport.ts`) on a run over 50 lines. Now full, same as above.
 */
export async function captureFailureEvidence(projectName: string, reason: string): Promise<void> {
  const [logs, health, transcripts, postgresLogs] = await Promise.all([
    runCapture("docker", buildUatComposeArgs(projectName, ["logs", "jarv1s"])).catch(
      (error) => `<log capture failed: ${String(error)}>`
    ),
    runCapture(
      "docker",
      buildUatComposeArgs(projectName, ["ps", "jarv1s", "--format", "json"])
    ).catch((error) => `<health capture failed: ${String(error)}>`),
    runCapture(
      "docker",
      buildUatComposeArgs(projectName, [
        "exec",
        "-T",
        "jarv1s",
        "sh",
        "-c",
        'cli_home_base="${MOSS_CLI_HOME_BASE:-${JARVIS_CLI_HOME_BASE:-$HOME}}"; ' +
          "find \"$cli_home_base/.claude/projects\" -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null " +
          "| sort -rn | head -3 | cut -d' ' -f2- " +
          '| while read -r f; do echo "--- $f ---"; cat "$f"; done'
      ])
    ).catch((error) => `<transcript capture failed: ${String(error)}>`),
    runCapture("docker", buildUatComposeArgs(projectName, ["logs", "postgres"])).catch(
      (error) => `<postgres log capture failed: ${String(error)}>`
    )
  ]);
  console.error(
    `[uat] ${projectName} jarv1s ${reason} — last 50 log lines, health status, full Claude print transcript(s), and full postgres log:`
  );
  console.error(logs);
  console.error(health);
  console.error(transcripts);
  console.error(postgresLogs);
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
  readonly beforeTeardown?: () => Promise<void>;
  readonly afterTeardown?: (failed: boolean) => Promise<void>;
  readonly error?: unknown;
}): Promise<void> {
  const errors: unknown[] = Object.hasOwn(input, "error") ? [input.error] : [];
  try {
    for (const cleanup of [
      input.beforeTeardown,
      input.teardownCompose,
      input.assertNoLeaks,
      input.afterTeardown && (() => input.afterTeardown!(errors.length > 0))
    ]) {
      if (!cleanup) continue;
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

async function runCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  evidence?: N3BuildEvidence
): Promise<void> {
  const observation = evidence && (await evidence.observeBuild(command, args, process.cwd()));
  const exited = new Promise<void>((resolvePromise, reject) => {
    let stderr = "";
    // #1024/#1000: stdout stays "inherit" for live operator visibility; stderr is piped so we can
    // inspect it for the port-bind-conflict signature, but every chunk is still forwarded to the
    // real stderr as it arrives so nothing is lost from the operator's view.
    const child = spawn(command, args, { stdio: ["inherit", "inherit", "pipe"], env });
    observation?.attach(child);
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
  await (observation ? Promise.all([exited, observation.closed]) : exited);
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

export function buildSeedHookInput(
  projectName: string,
  level: UatSeedLevel,
  opts?: UatProvisionOptions,
  // N42/#57: NOT part of UatProvisionOptions — provisionForUat computes this itself (the fixture
  // server's docker-reachable base URL) and passes it through explicitly, the same way it already
  // threads jobSearchFixtureBaseUrl into writeUatEnvFile below, rather than asking every caller of
  // UatProvisionOptions to compute a Docker bridge gateway address by hand.
  jobSearchAiProviderBaseUrl?: string,
  briefingWriterAiProviderBaseUrl?: string,
  classifierFixtureAiProviderBaseUrl?: string,
  newsFeedbackFixtureBaseUrl?: string,
  apiKeyChat?: apiKeyChatEnv.ApiKeyChatUatProvider
): {
  projectName: string;
  level: UatSeedLevel;
  excludeChunks?: readonly string[];
  withoutNewsJsonBinding?: boolean;
  jobSearchAiProviderBaseUrl?: string;
  briefingWriterAiProviderBaseUrl?: string;
  classifierFixtureAiProviderBaseUrl?: string;
  newsFeedbackFixtureBaseUrl?: string;
  sportsPublicSourceFixtures?: boolean;
  workflowApprovalFixture?: boolean;
  activityOutcomeFixture?: boolean;
  withWorkshopStorageFixture?: boolean;
  chatScript?: string;
  apiKeyChat?: apiKeyChatEnv.ApiKeyChatUatProvider;
} {
  return {
    projectName,
    level,
    excludeChunks: opts?.excludeChunks,
    withoutNewsJsonBinding: opts?.withoutNewsJsonBinding,
    jobSearchAiProviderBaseUrl,
    briefingWriterAiProviderBaseUrl,
    classifierFixtureAiProviderBaseUrl,
    newsFeedbackFixtureBaseUrl,
    sportsPublicSourceFixtures: opts?.withSportsPublicSourceFixtures,
    workflowApprovalFixture: opts?.withWorkflowApprovalFixture,
    activityOutcomeFixture: opts?.withActivityOutcomeFixture,
    withWorkshopStorageFixture: opts?.withWorkshopStorageFixture,
    chatScript: opts?.chatScript,
    apiKeyChat
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
    readonly n3BuildEvidence?: N3BuildEvidence;
    /** Caller-chosen project name for one attempt; a retry after it fails closed. */
    readonly runId?: UatRunId;
    readonly listLiveSubnets?: typeof listLiveDockerSubnets;
    readonly installRealChatAuth?: typeof installUatRealChatAuth;
  } = {}
): Promise<{ baseURL: string; projectName: string; teardown: () => Promise<void> }> {
  const observer = await prepareN3Observer(opts?.n3Observer, opts?.chatScript);
  dependencies.n3BuildEvidence?.validateObserver(opts?.n3Observer, observer);
  const recordLifecycle = await createLifecycleRecorder();
  const lifecycleEnabled = process.env.JARVIS_UAT_LIFECYCLE_DIR !== undefined;
  const overallStart = Date.now();
  const apiKeyChatSeed = opts?.withApiKeyChatProvider
    ? await apiKeyChatEnv.readApiKeyChatUatProvider(process.env)
    : undefined;
  // #1024/#1000: retry each candidate once; fail when the reserved port range is exhausted.
  let remainingCandidates =
    opts?.claimedWebPort === undefined
      ? Array.from({ length: UAT_PORT_RANGE_SIZE }, (_, i) => UAT_PORT_RANGE_START + i)
      : [opts.claimedWebPort];
  let remainingSubnetCandidates = [...UAT_SUBNET_CANDIDATES];
  let runIdUsed = false;
  let imageBuilt = false; // build once; a port-bind retry shouldn't rebuild the image
  // #2732: install the Codex credential copy per attempt, after its app container starts.
  // There is no stored-token setup before the loop.
  delete process.env[REAL_CHAT_CONFIGURED_ENV];
  while (remainingCandidates.length > 0) {
    if (dependencies.runId && runIdUsed) throw new Error("caller-chosen run id allows one attempt");
    const { projectName } = dependencies.runId ?? generateUatRunId();
    runIdUsed = true;
    const webPort: number = await findAvailablePort(remainingCandidates);
    const liveSubnets: Awaited<ReturnType<typeof listLiveDockerSubnets>> = await (
      dependencies.listLiveSubnets ?? listLiveDockerSubnets
    )();
    const subnet: ReturnType<typeof selectUatSubnet> = selectUatSubnet({
      requested: process.env.UAT_DOCKER_SUBNET,
      live: liveSubnets,
      candidates: remainingSubnetCandidates
    });
    if (subnet.source === "auto") {
      for (const network of findSkippedUatNetworks(liveSubnets, remainingSubnetCandidates)) {
        console.warn(
          `[uat] skipping subnet ${network.subnet} held by existing UAT network ${network.networkName}`
        );
      }
    }
    // #1306 Task 22: opt-in (see UatProvisionOptions.withJobSearchFixture), per-attempt like the
    // Codex credential copy below: the fixture is a container on THIS attempt's Compose network,
    // so a port-bind retry gets a fresh one under the new project name. The URL is knowable now —
    // it is just the container's name — which is what lets it be written into the env file the
    // stack starts with, several steps before the container itself exists.
    const jobSearchFixtureBaseUrl =
      opts?.withJobSearchFixture || opts?.withEspnFixture
        ? jobSearchFixtureBaseUrlFor(projectName)
        : undefined;
    // [task:p8-briefing-writer-unreachable]: per-attempt container on THIS attempt's network.
    const briefingWriterFixtureBaseUrl = opts?.withBriefingWriterFixture
      ? briefingWriter.briefingWriterFixtureBaseUrlFor(projectName)
      : undefined;
    const classifierFixtureBaseUrl = opts?.withClassifierFixture
      ? classifierFixtureBaseUrlFor(projectName)
      : undefined;
    const newsFeedbackFixtureBaseUrl = opts?.withNewsFeedbackFixture
      ? newsFeedbackFixture.newsFeedbackFixtureBaseUrlFor(projectName)
      : undefined;
    const envFile: UatEnvFile = writeUatEnvFile({
      webPort,
      subnet: subnet.subnet,
      jobSearchFixtureBaseUrl,
      chatScript: opts?.chatScript,
      n3Observer: opts?.n3Observer
    });
    process.env.JARVIS_ENV_FILE = envFile.path;
    process.env.JARVIS_IMAGE_TAG ??= "uat-smoke";
    // #1024/#1000: must be exported for every retry iteration, not just the first — a TOCTOU
    // port-bind retry picks a new webPort, and JARVIS_WEB_PORT must track it or compose would
    // interpolate the stale (or default/prod) port. See uatComposeInterpolationEnv's doc comment.
    Object.assign(process.env, uatComposeInterpolationEnv({ webPort, subnet: subnet.subnet }));
    const attempt: LifecycleAttempt & { failed: boolean } = {
      projectName,
      webPort,
      composeArgs: buildUatComposeArgs(projectName, []),
      failed: false
    };
    let realChatAuth: UatRealChatAuth | undefined;
    // #1306: remove owned fixtures before down so they cannot block network removal.
    const teardownCompose = async () => {
      // Credential cleanup must precede down; retain its error while attempting resource cleanup.
      let realChatCleanupError: unknown;
      const cleanupErrors: unknown[] = [];
      const retainFailure = (code: string) => {
        if (lifecycleEnabled)
          cleanupErrors.push(new Error(`UAT lifecycle cleanup: ${code}-failed`));
      };
      if (realChatAuth !== undefined) {
        try {
          await realChatAuth.cleanup();
        } catch (error) {
          realChatCleanupError = error;
        }
      }
      // Only fixtures this attempt started. The ESPN fixture shares the job-search container.
      if (briefingWriterFixtureBaseUrl !== undefined) {
        await briefingWriter.removeBriefingWriterFixtureContainer(projectName, runCommand);
      }
      if (classifierFixtureBaseUrl !== undefined) {
        await removeClassifierFixtureContainer(projectName, { runCommand, runCapture });
      }
      if (newsFeedbackFixtureBaseUrl !== undefined)
        await newsFeedbackFixture.removeNewsFeedbackFixtureContainer(projectName, {
          runCommand,
          runCapture
        });
      await mcpFixture.removeClassifierMcpFixtureContainer(projectName, runCommand);
      if (jobSearchFixtureBaseUrl !== undefined) await removeJobSearchFixtureContainer(projectName);
      // Remove exact project-scoped meeting fixtures even after interrupted Playwright.
      await runCommand("docker", ["rm", "--force", `${projectName}-meeting-chat-fixture`]).catch(
        () => {}
      );
      await runCommand("docker", ["rm", "--force", `${projectName}-meeting-outputs-fixture`]).catch(
        () => {}
      );
      await runCommand("docker", buildUatComposeArgs(projectName, ["down", "-v"])).catch(
        (error) => {
          console.error(`teardown failed for ${projectName}:`, error);
          retainFailure("compose-down");
        }
      );
      const ownedNetworks = await runCapture("docker", [
        "network",
        "ls",
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
        "--format",
        "{{.ID}}"
      ]).catch(() => {
        retainFailure("network-discovery");
        return "";
      });
      for (const networkId of ownedNetworks.split("\n").filter(Boolean)) {
        await runCommand("docker", ["network", "rm", networkId]).catch(() =>
          retainFailure("network-removal")
        );
      }
      if (cleanupErrors.length) {
        if (realChatCleanupError !== undefined) cleanupErrors.push(realChatCleanupError);
        throw new AggregateError(cleanupErrors, "UAT owned cleanup failed");
      }
      if (realChatCleanupError !== undefined) throw realChatCleanupError;
    };
    const cleanupAttempt = (options: { readonly error?: unknown } = {}) =>
      cleanupUatAttempt({
        teardownCompose,
        assertNoLeaks: () => assertNoLeakedResources(projectName),
        cleanupEnvFile: envFile.cleanup,
        beforeTeardown: () => recordLifecycle("before-teardown", attempt),
        afterTeardown: (failed) =>
          recordLifecycle("after-teardown", { ...attempt, failed: failed || attempt.failed }),
        ...options
      });
    try {
      await recordLifecycle("attempt-created", attempt);
      console.log(
        `[uat] provisioning ${projectName} on port ${webPort} subnet ${subnet.subnet} (${subnet.source})`
      );
      if (resolveMossEnv(process.env, "JARVIS_UAT_BUILD") !== "0" && !imageBuilt) {
        await runCommand(
          "docker",
          [
            "build",
            "-t",
            `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG}`,
            "-f",
            "Dockerfile",
            "."
          ],
          undefined,
          dependencies.n3BuildEvidence
        );
        imageBuilt = true;
      }
      await recordLifecycle("image-built", attempt);
      const plan = createUatProvisionPlan({ projectName, seedHook: bareSeedHook });
      for (const step of plan.slice(0, -1)) {
        // The final down step belongs to cleanupAttempt, including failed creation.
        console.log(`[uat] ${step.description}`);
        observer?.checkDeadline();
        if (observer && step.args.includes("up") && step.args.includes("jarv1s"))
          await observer.beforeInitialStart({
            projectName,
            envPath: envFile.path,
            recordCreated: () => recordLifecycle("resources-created", attempt)
          });
        if (observer && step.args.includes("up") && step.args.includes("jarv1s"))
          await dependencies.n3BuildEvidence?.beforeInitialStart({ projectName });
        await runCommand(
          step.command,
          observer && step.args.includes("up") && step.args.includes("jarv1s")
            ? [...step.args, "--no-recreate"]
            : step.args
        );
        observer?.checkDeadline();
        await recordLifecycle("resources-created", attempt);
      }
      // Auth copy needs the running app; Claude sign-in remains explicit in its spec.
      realChatAuth = (dependencies.installRealChatAuth ?? installUatRealChatAuth)(
        projectName,
        UAT_ADMIN_ID,
        (extra) => buildUatComposeArgs(projectName, extra)
      );
      if (realChatAuth !== undefined) {
        process.env[REAL_CHAT_CONFIGURED_ENV] = "1";
        console.log(
          uatRealChatProvider() !== "claude"
            ? `[uat] host Codex login copied into ${projectName}; real chat is available`
            : process.env[CLAUDE_TOKEN_REUSED_ENV] === "1"
              ? `[uat] Claude sign-in selected for ${projectName}; the spec tries the saved sign-in first`
              : `[uat] Claude sign-in selected for ${projectName}; the spec asks for a sign-in link`
        );
      }
      // #1306: after the plan loop, because the Compose network it attaches to does not exist
      // until the first `up`; before the seed hook, so the fixture origin is already answering by
      // the time anything can reach for it.
      if (jobSearchFixtureBaseUrl !== undefined) {
        console.log(`[uat] starting job-search fixture origin at ${jobSearchFixtureBaseUrl}`);
        await startJobSearchFixtureContainer(projectName);
      }
      if (briefingWriterFixtureBaseUrl !== undefined) {
        console.log(
          `[uat] starting briefing-writer fixture origin at ${briefingWriterFixtureBaseUrl}`
        );
        await briefingWriter.startBriefingWriterFixtureContainer(projectName, {
          runCommand,
          runCapture
        });
      }
      if (classifierFixtureBaseUrl !== undefined) {
        console.log(`[uat] starting classifier fixture origin at ${classifierFixtureBaseUrl}`);
        await startClassifierFixtureContainer(projectName, { runCommand, runCapture });
      }
      if (newsFeedbackFixtureBaseUrl !== undefined)
        await newsFeedbackFixture.startNewsFeedbackFixtureContainer(projectName, {
          runCommand,
          runCapture
        });
      if (opts?.withClassifierMcpFixture) {
        await mcpFixture.startClassifierMcpFixtureContainer(projectName, {
          runCommand,
          runCapture
        });
      }
      await composeSeedHook(
        buildSeedHookInput(
          projectName,
          level,
          opts,
          opts?.withJobSearchFixture ? jobSearchFixtureBaseUrl : undefined,
          opts?.withBriefingWriterFixture ? briefingWriterFixtureBaseUrl : undefined,
          opts?.withClassifierFixture ? classifierFixtureBaseUrl : undefined,
          newsFeedbackFixtureBaseUrl,
          apiKeyChatSeed
        )
      );
      await recordLifecycle("resources-created", { ...attempt, requireApp: true });
      const baseURL = `http://127.0.0.1:${webPort}`;
      await waitForReady(`${baseURL}/health/ready`);
      console.log(`[uat] reachable at ${baseURL} after ${Date.now() - overallStart}ms`);
      return {
        baseURL,
        projectName,
        // #1026: caller tears down after Playwright and owns SIGINT/SIGTERM handling.
        teardown: async () => {
          await cleanupAttempt();
        }
      };
    } catch (caught) {
      attempt.failed = true;
      let error = caught;
      try {
        await recordLifecycle("resources-created", attempt);
      } catch (metadataError) {
        error = new AggregateError([error, metadataError], "UAT provisioning and lifecycle failed");
      }
      if (error instanceof PortBindConflictError) {
        await cleanupAttempt();
        // A successful probe cannot prevent a later bind race; retry only after owned cleanup.
        console.warn(
          `[uat] port ${webPort} lost the bind race after probing free; retrying with next candidate (#1024)`
        );
        remainingCandidates = remainingCandidates.filter((port) => port !== webPort);
        continue;
      }
      if (error instanceof SubnetOverlapConflictError && subnet.source === "auto") {
        await cleanupAttempt();
        console.warn(
          `[uat] subnet ${subnet.subnet} lost the allocation race; retrying with next candidate (#1108)`
        );
        remainingSubnetCandidates = remainingSubnetCandidates.filter(
          (candidate) => candidate !== subnet.subnet
        );
        continue;
      }
      await captureFailureEvidence(projectName, "failed to provision");
      await cleanupAttempt({ error });
      throw error; // unreachable: cleanupUatAttempt rethrows the provisioning failure
    }
  }
  throw new Error(
    `exhausted all ${UAT_PORT_RANGE_SIZE} reserved UAT ports (${UAT_PORT_RANGE_START}-${
      UAT_PORT_RANGE_START + UAT_PORT_RANGE_SIZE - 1
    }) without a successful bind`
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
