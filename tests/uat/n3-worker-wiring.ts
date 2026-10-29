import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InstalledCollector,
  SOURCE_FILES,
  type InstalledIO
} from "./n3-fallback-observer-installed.js";
import {
  initialObserverOption,
  type ExpectedBindings,
  type FileIdentity
} from "./n3-fallback-observer-runner.js";
import type { N3ObserverOption } from "./provisioner-options.js";

const BOOTSTRAP_KEY = "/app/tests/uat/n3-fallback-observer-bootstrap.mjs";
const PRODUCER_KEY = "/app/tests/uat/lifecycle-records.ts";
const COMPOSE_FILES = ["infra/docker-compose.prod.yml", "tests/uat/compose.override.yml"];
const VOLUMES = [
  ["jarv1s-cli-auth", "/data/cli-auth"],
  ["jarv1s-cli-socket", "/run/jarv1s"],
  ["jarv1s-sports-browser-socket", "/run/moss-sports-browser"]
] as const;

type Authority = ConstructorParameters<typeof InstalledCollector>[0];

export interface WorkerObserverPlan {
  readonly option: N3ObserverOption;
  readonly runId: { readonly projectName: string; readonly suffix: string };
  readonly collector: InstalledCollector;
  readonly authority: Authority;
  /** Environment the lifecycle recorder reads inside the provisioning process. */
  readonly lifecycleEnv: Readonly<Record<string, string>>;
}

export interface WorkerObserverInput {
  readonly evidenceDir: string;
  readonly repoRoot: string;
  readonly claimedPort: number;
  readonly imageTag: string;
  /** Epoch milliseconds when the observer stops being trusted. */
  readonly deadline: number;
  readonly io?: Partial<InstalledIO>;
  readonly now?: () => number;
  /** Host reads (git, docker metadata). Defaults to a bounded child process. */
  readonly read?: ReadCommand;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type ReadCommand = (command: string, args: readonly string[], cwd?: string) => string;
const readCommand: ReadCommand = (command, args, cwd) =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", timeout: 30_000 }).trim();

function identity(path: string, type: FileIdentity["type"]): FileIdentity {
  const stat = lstatSync(path);
  return { type, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

/**
 * Pins come from this process and from direct reads, never from the observer being checked.
 * Nothing starts here; the collector stays inert until provisioning calls its hooks.
 */
export function planWorkerObserver(input: WorkerObserverInput): WorkerObserverPlan {
  const now = input.now ?? Date.now;
  const read = input.read ?? readCommand;
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const runId = { projectName: `uat-${suffix}`, suffix };
  const lifecycleDir = join(input.evidenceDir, "lifecycle");
  mkdirSync(lifecycleDir, { mode: 0o700 });
  const lifecycleNonce = randomBytes(32).toString("hex");
  const bootstrap = SOURCE_FILES[BOOTSTRAP_KEY]?.[0];
  const producerSha256 = SOURCE_FILES[PRODUCER_KEY]?.[0];
  if (!bootstrap || !producerSha256) throw new Error("N3 worker: pinned sources missing");
  const option = initialObserverOption(
    randomBytes(32).toString("hex"),
    bootstrap,
    input.deadline,
    now()
  );
  const git = (...args: string[]) => read("git", args, input.repoRoot);
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const buildFiles = ["Dockerfile", ".dockerignore"].map((path) => ({
    path: join(input.repoRoot, path),
    sha256: sha256(readFileSync(join(input.repoRoot, path)))
  }));
  const rootStat = lstatSync(input.repoRoot);
  const proc = readFileSync("/proc/self/stat", "utf8");
  const context = read("docker", ["context", "show"]);
  const authority: Authority = {
    option,
    lifecycleNonce,
    channel: identity(lifecycleDir, "directory"),
    producer: {
      pid: process.pid,
      ppid: process.ppid,
      startTicks: proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19]!,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    },
    producerSha256,
    source: {
      commit,
      tree,
      inputFingerprint: sha256(JSON.stringify({ commit, tree, buildFiles })),
      root: { path: input.repoRoot, device: rootStat.dev, inode: rootStat.ino }
    },
    daemon: {
      context,
      endpoint: JSON.parse(
        read("docker", [
          "context",
          "inspect",
          context,
          "--format",
          "{{json .Endpoints.docker.Host}}"
        ])
      ) as string,
      daemonId: JSON.parse(read("docker", ["info", "--format", "{{json .ID}}"])) as string
    },
    attempt: 1,
    project: runId.projectName,
    port: input.claimedPort,
    compose: COMPOSE_FILES.map((path) => ({
      path: join(input.repoRoot, path),
      sha256: sha256(readFileSync(join(input.repoRoot, path)))
    })),
    imageReference: `ghcr.io/motioneso/moss:${input.imageTag}`,
    volumes: VOLUMES.map(([role, destination]) => ({
      id: `${runId.projectName}_${role}`,
      role,
      destination
    })),
    dbBoundary: { endpoint: "owned-compose-postgres" }
  } satisfies Omit<
    ExpectedBindings,
    "containerId" | "imageId" | "bundleSha256" | "files" | "buildCommand" | "buildReceiptSha256"
  >;
  return {
    option,
    runId,
    authority,
    collector: new InstalledCollector(authority, lifecycleDir, input.io),
    lifecycleEnv: {
      JARVIS_UAT_LIFECYCLE_DIR: lifecycleDir,
      JARVIS_UAT_LIFECYCLE_NONCE: lifecycleNonce
    }
  };
}
