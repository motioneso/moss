import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ComposeSmokePlanInput {
  readonly apiPort?: string;
  readonly composeFile?: string;
  /** Build the compose images locally before bringing the stack up (prod variant). */
  readonly build?: boolean;
}

export interface ComposeSmokeCommand {
  readonly args: readonly string[];
  readonly command: "docker";
  readonly description: string;
}

export interface ComposeSmokePlan {
  readonly commands: readonly ComposeSmokeCommand[];
  readonly healthUrl: string;
}

export function createComposeSmokePlan(input: ComposeSmokePlanInput = {}): ComposeSmokePlan {
  const composeFile = input.composeFile ?? "infra/docker-compose.yml";
  const isProd = composeFile === "infra/docker-compose.prod.yml";
  const publicPort = isProd
    ? (process.env.JARVIS_WEB_PORT ?? "1533")
    : (input.apiPort ?? process.env.JARVIS_API_PORT ?? "3000");
  // Compose project, image ref, service name, and DB name below still say "jarv1s",
  // not "moss": they're coupled to infra/docker-compose.prod.yml (service name, image
  // ref, POSTGRES_DB) and .github/workflows/ci.yml (the `-p` teardown project). Renaming
  // any one alone breaks the smoke; all four move together in the #1444 cutover PR.
  const composeArgs = isProd
    ? ["compose", "-p", "jarv1s-prod-smoke", "-f", composeFile]
    : ["compose", "-f", composeFile];

  const imageTag = process.env.JARVIS_IMAGE_TAG ?? "smoke";
  const buildCommands: ComposeSmokeCommand[] = input.build
    ? [
        {
          command: "docker",
          args: ["build", "-t", `ghcr.io/motioneso/moss:${imageTag}`, "-f", "Dockerfile", "."],
          description: "Build the Moss image locally and tag it to the prod GHCR ref"
        }
      ]
    : [];

  const migrateCommand: ComposeSmokeCommand | undefined = isProd
    ? undefined
    : {
        command: "docker",
        args: [...composeArgs, "run", "--rm", "migrate"],
        description: "Run database migrations"
      };
  const upCommand: ComposeSmokeCommand = isProd
    ? {
        command: "docker",
        args: [
          ...composeArgs,
          "up",
          "-d",
          "postgres",
          "jarv1s",
          "sports-source-renderer",
          "--wait"
        ],
        description: "Start Postgres, Moss, and the Sports renderer"
      }
    : {
        command: "docker",
        args: [
          ...composeArgs,
          "up",
          "-d",
          "api",
          "web",
          "worker",
          "sports-source-renderer",
          "--wait"
        ],
        description: "Start API, web, worker, and Sports renderer services"
      };
  const appService = isProd ? "jarv1s" : "api";

  return {
    // Use the readiness probe, not the liveness `/health`. `/health` returns
    // `{ ok: true }` as soon as the process is listening — it says nothing about
    // whether Postgres or pg-boss are reachable, so a smoke that migrated the DB
    // could still pass against a server with a broken DB connection. `/health/ready`
    // runs `SELECT 1` and checks pg-boss, returning `{ ok, db, pgboss }` with a 503
    // until both are up, which is the post-migration invariant we want to assert (#171).
    healthUrl: `http://localhost:${publicPort}/health/ready`,
    commands: [
      ...buildCommands,
      {
        command: "docker",
        args: [...composeArgs, "config", "--quiet"],
        description: "Validate Docker Compose configuration"
      },
      ...(isProd
        ? [
            {
              command: "docker" as const,
              args: [...composeArgs, "run", "--rm", "sports-renderer-smoke"],
              description:
                "Complete a FotMob-shaped document and XHR through both exact-image UDS sockets"
            }
          ]
        : []),
      {
        command: "docker",
        args: [...composeArgs, "up", "-d", "postgres", "--wait"],
        description: "Start Postgres and wait for readiness"
      },
      ...(migrateCommand ? [migrateCommand] : []),
      upCommand,
      {
        command: "docker",
        args: [
          ...composeArgs,
          "exec",
          "-T",
          appService,
          "test",
          "-S",
          "/run/moss-sports-browser/renderer.sock"
        ],
        description: "Probe the Sports renderer socket from the app"
      },
      {
        command: "docker",
        args: [
          ...composeArgs,
          "exec",
          "-T",
          "-w",
          "/app/packages/sports",
          "sports-source-renderer",
          "node",
          "--input-type=module",
          "-e",
          "import{chromium}from'playwright-core';const b=await chromium.launch({headless:true});const p=await b.newPage();let reached=false;try{reached=Boolean(await p.goto('https://example.com',{timeout:5000}))}catch{}await b.close();if(reached)throw new Error('renderer direct egress succeeded')"
        ],
        description: "Prove Chromium cannot bypass the renderer network sandbox"
      },
      {
        command: "docker",
        args: [...composeArgs, "stop", "sports-source-renderer"],
        description: "Stop the optional renderer before checking ordinary app readiness"
      }
    ]
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = createComposeSmokePlan({
    apiPort: args.apiPort,
    composeFile: args.composeFile,
    build: args.build
  });
  const cleanup = ensureProdSmokeEnv(args.composeFile ?? "infra/docker-compose.yml");

  try {
    for (const command of plan.commands) {
      console.log(command.description);
      await runCommand(command.command, command.args);
    }

    await waitForHealth(plan.healthUrl);
    console.log(`Compose smoke passed: ${plan.healthUrl}`);
  } finally {
    cleanup();
  }
}

function ensureProdSmokeEnv(composeFile: string): () => void {
  if (composeFile === "infra/docker-compose.prod.yml") process.env.JARVIS_IMAGE_TAG ??= "smoke";
  if (composeFile !== "infra/docker-compose.prod.yml" || process.env.JARVIS_ENV_FILE) {
    process.env.POSTGRES_PASSWORD ??= "postgres";
    process.env.JARVIS_CLI_RUNNER_RPC_SECRET ??= "smoke-only-not-real";
    process.env.JARVIS_DOCKER_SUBNET ??= "10.253.0.0/24";
    return () => {};
  }

  const dir = mkdtempSync(join(tmpdir(), "moss-prod-smoke-"));
  const envFile = join(dir, "env.production.local");
  process.env.POSTGRES_PASSWORD ??= "postgres";
  process.env.JARVIS_CLI_RUNNER_RPC_SECRET ??= "smoke-only-not-real";
  process.env.JARVIS_DOCKER_SUBNET ??= "10.253.0.0/24";
  process.env.JARVIS_ENV_FILE = envFile;
  writeFileSync(
    envFile,
    [
      "NODE_ENV=production",
      "POSTGRES_PASSWORD=postgres",
      "JARVIS_DOCKER_SUBNET=10.253.0.0/24",
      "JARVIS_BOOTSTRAP_DATABASE_URL=postgres://postgres:postgres@postgres:5432/jarv1s",
      "JARVIS_MIGRATION_DATABASE_URL=postgres://jarvis_migration_owner:ci-migration-pw@postgres:5432/jarv1s",
      "JARVIS_APP_DATABASE_URL=postgres://jarvis_app_runtime:ci-app-pw@postgres:5432/jarv1s",
      "JARVIS_AUTH_DATABASE_URL=postgres://jarvis_auth_runtime:ci-auth-pw@postgres:5432/jarv1s",
      "JARVIS_WORKER_DATABASE_URL=postgres://jarvis_worker_runtime:ci-worker-pw@postgres:5432/jarv1s",
      "BETTER_AUTH_SECRET=smoke-only-not-a-real-secret-0000000000",
      "JARVIS_CONNECTOR_SECRET_KEY=00000000000000000000000000000000",
      "JARVIS_AI_SECRET_KEY=11111111111111111111111111111111",
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEY=22222222222222222222222222222222",
      "JARVIS_CLI_RUNNER_RPC_SECRET=smoke-only-not-real",
      "JARVIS_EMBED_PROVIDER=stub",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  return () => rmSync(dir, { force: true, recursive: true });
}

function parseArgs(args: readonly string[]): {
  readonly apiPort?: string;
  readonly composeFile?: string;
  readonly build?: boolean;
} {
  return {
    apiPort: readFlag(args, "--api-port"),
    composeFile: readFlag(args, "--compose-file"),
    build: args.includes("--build")
  };
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
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
        // The readiness probe only returns ok:true when DB and pg-boss are both
        // reachable; assert the component fields too so a future payload change
        // can't let a DB-down server slip through the smoke (#171).
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
