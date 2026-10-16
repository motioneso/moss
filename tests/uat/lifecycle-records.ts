import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export type LifecyclePhase =
  | "attempt-created"
  | "image-built"
  | "resources-created"
  | "before-teardown"
  | "after-teardown";
export interface LifecycleAttempt {
  readonly projectName: string;
  readonly webPort: number;
  readonly composeArgs: readonly string[];
  readonly failed?: boolean;
  readonly requireApp?: boolean;
}
export type RecordLifecycle = (phase: LifecyclePhase, attempt: LifecycleAttempt) => Promise<void>;
export type LifecycleCapture = (
  command: "git" | "docker",
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
) => Promise<string>;
const exec = promisify(execFile);
const captureMetadata: LifecycleCapture = async (command, args, env, cwd) => {
  try {
    const result = await exec(command, [...args], {
      env,
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 30_000
    });
    return result.stdout.trim();
  } catch {
    // Never forward child stderr, argv, environment or inspect output to the channel/logs.
    throw new Error("UAT lifecycle metadata command failed");
  }
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const fail = (code: string): never => {
  throw new Error(`UAT lifecycle: ${code}`);
};
const text = (value: unknown, max = 4096): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return fail("invalid-metadata");
  return value;
};
const identifier = (value: unknown) => {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result)) return fail("invalid-identity");
  return result;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-metadata");
  return value as Record<string, unknown>;
};
const json = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return fail("invalid-metadata-json");
  }
};
const parse = (value: string) => object(json(value));
const timestamp = (value: unknown) => {
  const result = text(value, 40);
  if (!Number.isFinite(Date.parse(result))) return fail("invalid-timestamp");
  return result;
};
const imageIdentity = (value: unknown) => {
  const result = text(value, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) return fail("invalid-image-id");
  return result;
};
const dockerKeys = [
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION"
] as const;
const composePaths = [
  "infra/docker-compose.prod.yml",
  "tests/uat/compose.override.yml",
  "infra/docker-compose.native-sandbox.yml"
];
const labelKeys = [
  "project",
  "project.working_dir",
  "project.config_files",
  "service",
  "volume",
  "network",
  "version",
  "config-hash",
  "container-number",
  "oneoff",
  "image",
  "depends_on",
  "replace"
];
type Kind = "container" | "volume" | "network";
interface ResourceMetadata {
  readonly id: string;
  readonly name: string;
  readonly created: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly role: string;
  readonly imageId?: string;
  readonly imageReference?: string;
  readonly webPorts?: readonly { hostIp: string; hostPort: number }[];
  readonly driver?: string;
}
type Observation =
  | { state: "present"; metadata: ResourceMetadata }
  | { state: "absent" }
  | { state: "error"; code: string };
interface InventoryEntry {
  readonly kind: Kind;
  readonly id: string;
  readonly firstSeen: string;
  readonly creation: ResourceMetadata | null;
  readonly creationFingerprint: string | null;
  observation: Observation;
}
interface AttemptState {
  readonly number: number;
  readonly project: string;
  readonly port: number;
  readonly argsDigest: string;
  readonly compose: readonly { path: string; sha256: string }[];
  readonly start: string;
  end: string | null;
  phase: LifecyclePhase;
  failed: boolean;
  appSeen: boolean;
  readonly inventory: Map<string, InventoryEntry>;
}
const formats: Record<Kind, string> = {
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Config.Labels}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}',
  volume:
    '{"id":{{json .Name}},"name":{{json .Name}},"created":{{json .CreatedAt}},"labels":{{json .Labels}},"driver":{{json .Driver}}}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Labels}},"driver":{{json .Driver}}}'
};

/** One dedicated in-process producer. The consumer must independently authenticate this channel. */
export async function createLifecycleRecorder(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly root?: string;
    readonly capture?: LifecycleCapture;
  } = {}
): Promise<RecordLifecycle> {
  const liveEnv = options.env ?? process.env;
  const dir = liveEnv.JARVIS_UAT_LIFECYCLE_DIR;
  const nonce = liveEnv.JARVIS_UAT_LIFECYCLE_NONCE;
  if (dir === undefined && nonce === undefined) return async () => {};
  let channel: ReturnType<typeof lstatSync>;
  try {
    if (
      !dir ||
      !nonce ||
      !isAbsolute(dir) ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(nonce) ||
      realpathSync(dir) !== resolve(dir)
    )
      throw new Error();
    channel = lstatSync(dir);
    if (
      !channel.isDirectory() ||
      channel.uid !== process.getuid?.() ||
      (channel.mode & 0o777) !== 0o700 ||
      readdirSync(dir).length !== 0 ||
      liveEnv.JARVIS_UAT_BUILD === "0" ||
      liveEnv.MOSS_UAT_BUILD === "0"
    )
      throw new Error();
  } catch {
    throw new Error("Invalid UAT lifecycle configuration");
  }
  const channelPath = dir!;
  const env = Object.freeze({ ...liveEnv });
  const root = realpathSync(options.root ?? fileURLToPath(new URL("../../", import.meta.url)));
  const rootStat = lstatSync(root);
  const capture = options.capture ?? captureMetadata;
  const read = async (command: "git" | "docker", args: readonly string[]) => {
    const value = await capture(command, args, env, root);
    if (Buffer.byteLength(value) > 256 * 1024) return fail("metadata-too-large");
    return value.trim();
  };
  const git = (...args: string[]) => read("git", args);
  const commit = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^[a-f0-9]{40}$/.test(tree) ||
    (await git("status", "--porcelain", "--untracked-files=normal")) ||
    (await git("rev-parse", "--show-toplevel")) !== root
  )
    return fail("source-not-clean");
  const buildFiles = ["Dockerfile", ".dockerignore"].map((path) => ({
    path: join(root, path),
    sha256: hash(readFileSync(join(root, path)))
  }));
  const source = {
    commit,
    tree,
    inputFingerprint: digest({ commit, tree, buildFiles }),
    root: { path: root, device: rootStat.dev, inode: rootStat.ino }
  };
  const proc = readFileSync("/proc/self/stat", "utf8");
  const startTicks = proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) return fail("producer-start-unknown");
  const producer = {
    pid: process.pid,
    ppid: process.ppid,
    startTicks,
    bootId: text(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), 36)
  };
  const docker = (...args: string[]) => read("docker", args);
  const endpointNow = async () => {
    const context = identifier(await docker("context", "show"));
    const endpoint: unknown =
      liveEnv.DOCKER_HOST && !liveEnv.DOCKER_CONTEXT
        ? liveEnv.DOCKER_HOST
        : json(
            await docker(
              "context",
              "inspect",
              context,
              "--format",
              "{{json .Endpoints.docker.Host}}"
            )
          );
    const url = new URL(text(endpoint));
    if (
      !["unix:", "tcp:", "ssh:", "npipe:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return fail("invalid-docker-endpoint");
    return { context, endpoint: url.href };
  };
  const selected = await endpointNow();
  const daemonId = identifier(json(await docker("info", "--format", "{{json .ID}}")));
  const daemon = { ...selected, daemonId };
  const checkDaemon = async () => {
    if (
      dockerKeys.some((key) => liveEnv[key] !== env[key]) ||
      digest(await endpointNow()) !== digest(selected) ||
      json(await docker("info", "--format", "{{json .ID}}")) !== daemonId
    )
      return fail("daemon-mismatch");
  };
  const selectedDocker = async (...args: string[]) => {
    await checkDaemon();
    const value = await docker(...args);
    await checkDaemon();
    return value;
  };
  const tag = identifier(env.JARVIS_IMAGE_TAG ?? "uat-smoke");
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) return fail("invalid-image-tag");
  const reference = `ghcr.io/motioneso/moss:${tag}`;
  let image: {
    tag: string;
    reference: string;
    id: string;
    created: string;
    builtAt: string;
    buildFingerprint: string;
    initialTagAbsent: true;
  } | null = null;
  let tagChecked = false;
  let sequence = 0;
  let previousDigest: string | null = null;
  let attemptCount = 0;
  let current: AttemptState | undefined;
  let poisoned = false;
  let busy = false;

  const checkSource = async (attempt: AttemptState) => {
    const now = lstatSync(root);
    if (
      now.dev !== source.root.device ||
      now.ino !== source.root.inode ||
      (await git("rev-parse", "HEAD")) !== commit ||
      (await git("status", "--porcelain", "--untracked-files=normal"))
    )
      return fail("source-mismatch");
    for (const file of [...buildFiles, ...attempt.compose])
      if (hash(readFileSync(file.path)) !== file.sha256) return fail("source-input-mismatch");
    if ((liveEnv.JARVIS_IMAGE_TAG ?? "uat-smoke") !== tag) return fail("image-tag-mismatch");
  };
  const fixtureNames = (project: string) =>
    [
      "jsfixture",
      "bwfixture",
      "clsfixture",
      "newsfixture",
      "mcpfixture",
      "meeting-chat-fixture",
      "meeting-outputs-fixture"
    ].map((role) => `${project}-${role}`);
  const lines = (value: string) => {
    const result = value ? value.split("\n").map(identifier) : [];
    if (result.length > 256 || new Set(result).size !== result.length)
      return fail("invalid-resource-list");
    return result;
  };
  const discover = async (attempt: AttemptState, kind: Kind, errors: string[]) => {
    const projectFilter = `label=com.docker.compose.project=${attempt.project}`;
    const args =
      kind === "container"
        ? ["ps", "-a", "--quiet", "--no-trunc"]
        : [kind, "ls", "--quiet", ...(kind === "network" ? ["--no-trunc"] : [])];
    const ids: string[] = [];
    const collectIds = async (filter: string) => {
      try {
        ids.push(...lines(await selectedDocker(...args, "--filter", filter)));
      } catch {
        errors.push(`${kind}-discovery-error`);
      }
    };
    await collectIds(projectFilter);
    if (kind === "container") {
      for (const name of fixtureNames(attempt.project)) await collectIds(`name=^/${name}$`);
    }
    return [...new Set(ids)];
  };
  const inspect = async (
    attempt: AttemptState,
    kind: Kind,
    id: string
  ): Promise<ResourceMetadata> => {
    const raw = parse(await selectedDocker(kind, "inspect", id, "--format", formats[kind]));
    const resourceId = identifier(raw.id);
    if (resourceId !== id || (kind !== "volume" && !/^[a-f0-9]{64}$/.test(resourceId)))
      return fail("resource-id-mismatch");
    const name = text(raw.name, 128).replace(/^\//, "");
    identifier(name);
    const labels: Record<string, string> = {};
    const rawLabels = raw.labels == null ? {} : object(raw.labels);
    for (const key of labelKeys) {
      const value = rawLabels[`com.docker.compose.${key}`];
      if (value !== undefined) labels[`com.docker.compose.${key}`] = text(value);
    }
    const fixture = kind === "container" && fixtureNames(attempt.project).includes(name);
    if (!fixture && labels["com.docker.compose.project"] !== attempt.project)
      return fail("resource-project-mismatch");
    if (
      kind === "container" &&
      !fixture &&
      (labels["com.docker.compose.project.working_dir"] !== dirname(attempt.compose[0]!.path) ||
        labels["com.docker.compose.project.config_files"] !==
          attempt.compose.map((file) => file.path).join(","))
    )
      return fail("resource-compose-mismatch");
    const created = timestamp(raw.created);
    if (
      Date.parse(created) < Date.parse(attempt.start) - 1000 ||
      Date.parse(created) > Date.now() + 1000
    )
      return fail("resource-creation-window-mismatch");
    const role = fixture
      ? name.slice(attempt.project.length + 1)
      : identifier(labels[`com.docker.compose.${kind === "container" ? "service" : kind}`]);
    const base = { id: resourceId, name, created, labels, role };
    if (kind !== "container") return { ...base, driver: identifier(raw.driver) };
    const imageId = imageIdentity(raw.imageId);
    const imageReference = text(raw.imageReference, 256);
    const bindings = object(raw.ports ?? {})["3000/tcp"] ?? [];
    if (!Array.isArray(bindings) || bindings.length > 8) return fail("invalid-port-bindings");
    const webPorts = bindings.map((value: unknown) => {
      const port = object(value);
      const hostPort = Number(port.HostPort);
      const hostIp = text(port.HostIp, 64);
      if (
        !Number.isInteger(hostPort) ||
        hostPort < 1 ||
        hostPort > 65535 ||
        !/^[a-fA-F0-9:.]+$/.test(hostIp)
      )
        return fail("invalid-port-bindings");
      return { hostIp, hostPort };
    });
    return { ...base, imageId, imageReference, webPorts };
  };
  const observe = async (attempt: AttemptState, entry: InventoryEntry): Promise<Observation> => {
    const args =
      entry.kind === "container"
        ? ["ps", "-a", "--quiet", "--no-trunc", "--filter", `id=${entry.id}`]
        : [
            entry.kind,
            "ls",
            "--quiet",
            ...(entry.kind === "network" ? ["--no-trunc"] : []),
            "--filter",
            `${entry.kind === "volume" ? "name" : "id"}=${entry.id}`
          ];
    if (!lines(await selectedDocker(...args)).includes(entry.id)) return { state: "absent" };
    const metadata = await inspect(attempt, entry.kind, entry.id);
    if (digest(metadata) !== entry.creationFingerprint)
      return fail("resource-fingerprint-mismatch");
    return { state: "present", metadata };
  };
  const writeRecord = (body: unknown) => {
    const stat = lstatSync(channelPath);
    if (
      stat.dev !== channel.dev ||
      stat.ino !== channel.ino ||
      stat.uid !== channel.uid ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.isSymbolicLink()
    )
      return fail("channel-identity-mismatch");
    const fd = openSync(
      channelPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    let temporary: string | undefined;
    try {
      const opened = fstatSync(fd);
      if (
        opened.ino !== channel.ino ||
        opened.dev !== channel.dev ||
        opened.uid !== channel.uid ||
        (opened.mode & 0o777) !== 0o700
      )
        return fail("channel-identity-mismatch");
      const recordDigest = digest(body);
      const data = JSON.stringify({ ...object(body), digest: recordDigest }) + "\n";
      if (Buffer.byteLength(data) > 256 * 1024 || sequence >= 4096)
        return fail("record-limit-exceeded");
      const anchored = `/proc/self/fd/${fd}`;
      temporary = join(anchored, `.pending-${randomBytes(12).toString("hex")}`);
      const output = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        fchmodSync(output, 0o600);
        writeFileSync(output, data);
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      // link is atomic and exclusive, unlike rename which would silently replace an accepted record.
      linkSync(temporary, join(anchored, `${String(sequence + 1).padStart(6, "0")}.json`));
      unlinkSync(temporary);
      temporary = undefined;
      fsyncSync(fd);
      sequence++;
      previousDigest = recordDigest;
    } catch {
      return fail("record-publication-failed");
    } finally {
      try {
        if (temporary) unlinkSync(temporary);
      } catch {
        /* The failed publication already makes the stream nonzero. */
      } finally {
        closeSync(fd);
      }
    }
  };

  return async (phase, input) => {
    if (busy) return fail("concurrent-record");
    busy = true;
    try {
      if (
        ![
          "attempt-created",
          "image-built",
          "resources-created",
          "before-teardown",
          "after-teardown"
        ].includes(phase)
      )
        return fail("unknown-phase");
      if (phase === "attempt-created") {
        if (current && current.phase !== "after-teardown") return fail("attempt-not-finished");
        if (
          !/^uat-[a-zA-Z0-9_-]{1,100}$/.test(input.projectName) ||
          !Number.isInteger(input.webPort) ||
          input.webPort < 1 ||
          input.webPort > 65535
        )
          return fail("invalid-attempt");
        const expected = ["compose", "-p", input.projectName];
        const paths: string[] = [];
        for (let i = 3; i < input.composeArgs.length; i += 2) {
          const path = input.composeArgs[i + 1];
          if (input.composeArgs[i] !== "-f" || !path || path !== composePaths[paths.length])
            return fail("invalid-compose-binding");
          paths.push(path);
        }
        if (
          input.composeArgs.slice(0, 3).join("\0") !== expected.join("\0") ||
          (paths.length !== 2 && paths.length !== 3)
        )
          return fail("invalid-compose-binding");
        current = {
          number: ++attemptCount,
          project: input.projectName,
          port: input.webPort,
          argsDigest: digest(input.composeArgs),
          compose: paths.map((path) => ({
            path: join(root, path),
            sha256: hash(readFileSync(join(root, path)))
          })),
          start: new Date().toISOString(),
          end: null,
          phase,
          failed: false,
          appSeen: false,
          inventory: new Map()
        };
      }
      const attempt = current;
      if (
        !attempt ||
        input.projectName !== attempt.project ||
        input.webPort !== attempt.port ||
        digest(input.composeArgs) !== attempt.argsDigest
      )
        return fail("attempt-binding-mismatch");
      if (
        (phase === "image-built" && attempt.phase !== "attempt-created") ||
        (phase === "resources-created" &&
          ![
            "image-built",
            "resources-created",
            ...(input.failed ? ["attempt-created"] : [])
          ].includes(attempt.phase)) ||
        (phase === "before-teardown" &&
          ["before-teardown", "after-teardown"].includes(attempt.phase)) ||
        (phase === "after-teardown" && attempt.phase !== "before-teardown")
      )
        return fail("phase-order");
      attempt.failed ||= input.failed === true;
      const errors: string[] = [];
      const collect = async (code: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch {
          errors.push(code);
        }
      };
      await collect("source-binding-error", () => checkSource(attempt));
      await collect("daemon-binding-error", checkDaemon);
      if (phase === "attempt-created" && !tagChecked) {
        await collect("image-tag-not-absent", async () => {
          if (
            await selectedDocker(
              "image",
              "ls",
              "--quiet",
              "--no-trunc",
              "--filter",
              `reference=${reference}`
            )
          )
            return fail("image-tag-not-absent");
          tagChecked = true;
        });
      }
      if (phase === "image-built") {
        await collect("image-build-identity-error", async () => {
          if (!tagChecked) return fail("image-tag-unchecked");
          const built = parse(
            await selectedDocker(
              "image",
              "inspect",
              reference,
              "--format",
              '{"id":{{json .Id}},"created":{{json .Created}}}'
            )
          );
          const id = imageIdentity(built.id);
          if (image && image.id !== id) return fail("image-replaced");
          image ??= {
            tag,
            reference,
            id,
            created: timestamp(built.created),
            builtAt: new Date().toISOString(),
            buildFingerprint: source.inputFingerprint,
            initialTagAbsent: true
          };
        });
      }
      const residuals: { kind: Kind; id: string }[] = [];
      for (const kind of ["container", "volume", "network"] as const) {
        await collect(`${kind}-discovery-error`, async () => {
          for (const id of await discover(attempt, kind, errors)) {
            const key = `${kind}:${id}`;
            if (phase === "attempt-created") return fail("project-not-empty");
            if (phase === "after-teardown") {
              residuals.push({ kind, id });
              continue;
            }
            const existing = attempt.inventory.get(key);
            if (!existing) {
              if (attempt.inventory.size >= 256) return fail("inventory-limit-exceeded");
              attempt.inventory.set(key, {
                kind,
                id,
                firstSeen: new Date().toISOString(),
                creation: null,
                creationFingerprint: null,
                observation: { state: "error", code: "metadata-unavailable" }
              });
            }
            await collect(`${kind}-inspection-error`, async () => {
              const metadata = await inspect(attempt, kind, id);
              if (existing?.creation && existing.creationFingerprint !== digest(metadata))
                return fail("resource-fingerprint-mismatch");
              if (!existing?.creation)
                attempt.inventory.set(key, {
                  kind,
                  id,
                  firstSeen: attempt.inventory.get(key)!.firstSeen,
                  creation: metadata,
                  creationFingerprint: digest(metadata),
                  observation: { state: "present", metadata }
                });
            });
          }
        });
      }
      for (const entry of attempt.inventory.values()) {
        try {
          entry.observation = await observe(attempt, entry);
          if (entry.kind === "container" && entry.creation?.role === "jarv1s") {
            const app =
              entry.observation.state === "present" ? entry.observation.metadata : entry.creation;
            if (
              !image ||
              app.imageId !== image.id ||
              app.imageReference !== reference ||
              !app.webPorts?.length ||
              app.webPorts.some((port) => port.hostPort !== attempt.port)
            )
              return fail("app-build-binding-error");
            attempt.appSeen = true;
          }
          if (phase === "after-teardown" && entry.observation.state === "present")
            errors.push("recorded-resource-present");
        } catch {
          entry.observation = { state: "error", code: "resource-observation-error" };
          errors.push("resource-observation-error");
        }
      }
      if (residuals.length) errors.push("project-residuals-present");
      if (
        input.requireApp &&
        (!image ||
          ![...attempt.inventory.values()].some(
            (entry) => entry.creation?.role === "jarv1s" && entry.observation.state === "present"
          ))
      )
        errors.push("app-build-proof-missing");
      if (phase === "before-teardown") {
        attempt.end = new Date().toISOString();
        if (!attempt.failed && (!image || !attempt.appSeen)) errors.push("app-build-proof-missing");
      }
      if (phase === "after-teardown" && (!image || !attempt.appSeen) && !attempt.failed)
        errors.push("app-build-proof-missing");
      if (poisoned) errors.push("prior-record-failure");
      const complete =
        phase === "after-teardown" &&
        !attempt.failed &&
        errors.length === 0 &&
        image !== null &&
        attempt.appSeen;
      attempt.phase = phase;
      writeRecord({
        schema: 1,
        sequence: sequence + 1,
        previousDigest,
        nonce,
        producer,
        source,
        daemon,
        phase,
        observedAt: new Date().toISOString(),
        attempt: {
          number: attempt.number,
          project: attempt.project,
          port: attempt.port,
          compose: attempt.compose,
          start: attempt.start,
          end: attempt.end,
          failed: attempt.failed
        },
        image,
        inventory: [...attempt.inventory.values()],
        residuals,
        errors,
        complete
      });
      if (errors.length) {
        poisoned = true;
        return fail("record-incomplete");
      }
    } catch (error) {
      poisoned = true;
      throw error;
    } finally {
      busy = false;
    }
  };
}
