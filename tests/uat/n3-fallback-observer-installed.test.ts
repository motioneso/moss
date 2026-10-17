import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as options from "./provisioner-options.js";
import * as lifecycle from "./lifecycle-records.js";
import * as envFile from "./env-file.js";
import { lifecycleFixture } from "./provisioner-lifecycle-fixture.js";
import { InstalledCollector, type InstalledIO } from "./n3-fallback-observer-installed.js";
import {
  K,
  SOURCE_FILES,
  INSTALLED_PATHS,
  BUNDLE
} from "./n3-fallback-observer-installed-evidence.js";
import {
  NATIVE_BRIDGE,
  OBSERVER_SITES,
  initialObserverOption,
  type FileIdentity,
  type ExpectedBindings
} from "./n3-fallback-observer-runner.js";
// @ts-expect-error The fixed native bootstrap intentionally has no source-loader declarations.
import { activateObserver } from "./n3-fallback-observer-bootstrap.mjs";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), forbidden: vi.fn(), listen: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.forbidden,
  execFileSync: mocks.forbidden
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  createServer: mocks.listen,
  createConnection: mocks.forbidden
}));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: () => Buffer.from("abcdef01", "hex")
}));
const { provisionForUat } = await import("./provisioner.js");
const nativeCP = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
const immutable = (path: string) =>
  nativeCP.execFileSync("git", ["show", K + ":" + path], { cwd: root, maxBuffer: 1024 * 1024 });
const prepare = options.prepareN3Observer,
  createRecorder = lifecycle.createLifecycleRecorder;
const cleanups: (() => void)[] = [];
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  turn = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fileIdentity = (path: string, type: FileIdentity["type"]): FileIdentity => {
  const s = fs.lstatSync(path);
  return { type, device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 0o777 };
};
function edit(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys.at(-1)!] = value;
}
function tar(bytes: Buffer, path: string, type = "0", name = path.split("/").at(-1)!): Buffer {
  const out = Buffer.alloc(512 + Math.ceil(bytes.length / 512) * 512 + 1024);
  out.write(name, 0, 100);
  for (const [offset, size, value] of [
    [100, 8, 420],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, bytes.length],
    [136, 12, 0]
  ])
    out.write(value!.toString(8).padStart(size! - 1, "0") + "\0", offset!, size!);
  out.write(type, 156);
  out.write("ustar\0", 257);
  out.write("00", 263);
  bytes.copy(out, 512);
  checksum(out);
  return out;
}
function checksum(out: Buffer) {
  out.fill(32, 148, 156);
  out.write(
    out
      .subarray(0, 512)
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
    8
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T23:00:00Z"));
  for (const key of [
    "NODE_OPTIONS",
    "JARVIS_UAT_SCRIPTED_PROVIDER_BIN",
    "JARVIS_UAT_SEED_CHAT_SCRIPT",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
    "MOSS_NATIVE_SANDBOX",
    "MOSS_UAT_BUILD",
    "UAT_DOCKER_SUBNET"
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(process, "kill").mockImplementation(mocks.forbidden);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, db: "ok", pgboss: "ok" })))
  );
  mocks.listen.mockImplementation(() => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, fn: () => void) => fn(),
    close: (fn: () => void) => fn()
  }));
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  expect(mocks.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function fixture() {
  const f = lifecycleFixture();
  cleanups.push(f.dispose);
  const project = `uat-${process.pid}_abcdef01`,
    option = initialObserverOption(
      "a".repeat(64),
      SOURCE_FILES[INSTALLED_PATHS[0]!]![0],
      Date.now() + 20000,
      Date.now()
    );
  for (const [key] of Object.entries(SOURCE_FILES)) {
    const path = join(f.root, key.slice(5));
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, immutable(key.slice(5)));
  }
  for (const p of ["Dockerfile", ".dockerignore"]) fs.writeFileSync(join(f.root, p), immutable(p));
  f.app.name = `/${project}-jarv1s-1`;
  f.app.labels["com.docker.compose.project"] = project;
  for (const [i, v] of f.volumes.entries()) {
    if (i === 1) v.labels["com.docker.compose.volume"] = "jarv1s-cli-socket";
    v.id = v.name = `${project}_${v.labels["com.docker.compose.volume"]}`;
    v.labels["com.docker.compose.project"] = project;
  }
  const bundle = Buffer.from("original generated bundle"),
    source = {
      commit: "3".repeat(40),
      tree: "4".repeat(40),
      inputFingerprint: "",
      root: { path: f.root, device: fs.lstatSync(f.root).dev, inode: fs.lstatSync(f.root).ino }
    };
  source.inputFingerprint = digest({
    commit: source.commit,
    tree: source.tree,
    buildFiles: ["Dockerfile", ".dockerignore"].map((path) => ({
      path: join(f.root, path),
      sha256: hash(fs.readFileSync(join(f.root, path)))
    }))
  });
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    proc = fs.readFileSync("/proc/self/stat", "utf8");
  const authority = {
    option,
    lifecycleNonce: f.env.JARVIS_UAT_LIFECYCLE_NONCE,
    channel: fileIdentity(f.dir, "directory"),
    producer: {
      pid: process.pid,
      ppid: process.ppid,
      startTicks: proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19]!,
      bootId
    },
    producerSha256: SOURCE_FILES["/app/tests/uat/lifecycle-records.ts"]![0],
    source,
    daemon: {
      context: "default",
      endpoint: "unix:///var/run/docker.sock",
      daemonId: f.state.daemon
    },
    attempt: 1,
    project,
    port: 5201,
    compose: ["infra/docker-compose.prod.yml", "tests/uat/compose.override.yml"].map((path) => ({
      path: join(f.root, path),
      sha256: hash(fs.readFileSync(join(f.root, path)))
    })),
    imageReference: f.reference,
    volumes: f.volumes.slice(0, 2).map((v, i) => ({
      id: v.id,
      role: v.labels["com.docker.compose.volume"],
      destination: i === 0 ? "/data/cli-auth" : "/run/jarv1s"
    })),
    dbBoundary: { endpoint: "owned-compose-postgres" }
  };
  const events: string[] = [],
    calls: { args: string[]; baseline: boolean; stdio: unknown; env: unknown }[] = [];
  const h = {
    initial: undefined as ((v: Record<string, unknown>) => void) | undefined,
    final: undefined as ((v: Record<string, unknown>) => void) | undefined,
    tar: undefined as ((bytes: Buffer, path: string) => Buffer) | undefined,
    before: () => {},
    running: false,
    baseline: false,
    inspects: 0,
    holdBuild: false,
    buildCode: 0 as number | null,
    signal: null as NodeJS.Signals | null,
    spawnError: undefined as Error | undefined,
    missingClose: false,
    oversized: false,
    stderrOverflow: false,
    dirty: false,
    drift: false,
    badBirth: false,
    bridgeClose: true,
    backpressure: false,
    dropReply: false,
    apiCount: 1,
    db: "owned-compose-postgres"
  };
  const api = { pid: 432, startTicks: "4321", bootId, containerId: f.id, resolvedEntry: BUNDLE },
    socketDirectory = {
      type: "directory" as const,
      device: 1,
      inode: 11,
      uid: process.getuid!(),
      mode: 0o700
    },
    socket = { ...socketDirectory, type: "socket" as const, inode: 12, mode: 0o600 };
  let sequence = 0,
    receive: (event: unknown) => void = () => {};
  const server = Object.assign(new EventEmitter(), {
    listen: (_path: string, ready: () => void) => ready(),
    close: vi.fn()
  });
  const observer = activateObserver(option, {
    entry: BUNDLE,
    now: Date.now,
    realEntry: () => BUNDLE,
    selfHash: () => option.bootstrapSha256,
    entryHash: () => hash(bundle),
    identity: () => api,
    sameIdentity: () => true,
    makePrivate: vi.fn(),
    privateTransport: () => true,
    secureSocket: vi.fn(),
    socketPath: () => "/fake/socket",
    encode: JSON.stringify,
    server: () => server,
    subscribe: (fn: typeof receive) => {
      receive = fn;
      return vi.fn();
    },
    timer: () => ({ unref: vi.fn() }),
    clearTimer: vi.fn(),
    barrierToken: () => thread
  });
  cleanups.push(() => observer.close());
  receive({ version: 1, sequence: ++sequence, phase: "coverage", sites: OBSERVER_SITES });
  const processFiles = new Map<string, Buffer>(),
    fds = new Map<number, { data: Buffer; offset: number }>();
  let nextPid = 60000,
    pendingCopies = 0,
    nextFd = 1000000;
  let build: ChildProcess | undefined, bridge: ChildProcess | undefined;
  const info = () => {
    const v: Record<string, unknown> = {
      Id: f.id,
      Name: f.app.name,
      Image: f.imageId,
      Created: f.app.created,
      Config: {
        Image: f.reference,
        Labels: { ...f.app.labels },
        Env: [...options.n3ObserverEnv(option, undefined, {})]
      },
      State: {
        Status: h.running ? "running" : "created",
        Running: h.running,
        Pid: h.running ? 432 : 0,
        StartedAt: h.running ? "2026-10-16T23:00:00Z" : "0001-01-01T00:00:00Z"
      },
      Mounts: authority.volumes.map((v) => ({
        Type: "volume",
        Name: v.id,
        Source: "/owned/" + v.id,
        Destination: v.destination
      })),
      HostConfig: { Tmpfs: {}, Binds: null }
    };
    if (h.baseline) {
      h.inspects++;
      (h.inspects > 2 ? h.final : h.initial)?.(v);
    }
    return v;
  };
  async function data(command: string, args: readonly string[]): Promise<Buffer> {
    if (command === "git") {
      if (args[0] === "show") return immutable(String(args[1]).split(":").slice(1).join(":"));
      if (args.includes("--show-toplevel")) return Buffer.from(f.root);
      if (args.includes("--porcelain")) return Buffer.from(h.dirty ? " M Dockerfile" : "");
      return Buffer.from((args.includes("HEAD^{tree}") ? (h.drift ? "5" : "4") : "3").repeat(40));
    }
    if (command !== "docker") throw new Error("forbidden executable");
    if (args[0] === "context" && args[1] === "show") return Buffer.from("default");
    if (args[0] === "context") return Buffer.from(JSON.stringify(authority.daemon.endpoint));
    if (args[0] === "info") return Buffer.from(JSON.stringify(f.state.daemon));
    if (args[0] === "image") return Buffer.from(f.imageId);
    if (args[0] === "container") return Buffer.from(JSON.stringify(info()));
    if (args[0] === "volume" && args[1] === "ls")
      return Buffer.from(f.state.volumesPresent ? f.volumes.map((v) => v.id).join("\n") : "");
    if (args[0] === "volume" && args[1] === "inspect") {
      const v = f.volumes.find((v) => v.id === args[2]);
      if (!v) throw new Error("unknown volume");
      return Buffer.from(JSON.stringify({ Name: v.id, Driver: v.driver, Labels: v.labels }));
    }
    if (args[0] === "diff")
      return Buffer.from(h.baseline && h.inspects > 2 && h.dirty ? "C /app/dist/server.js" : "");
    if (args[0] === "cp") {
      const path = String(args[1]).slice(65),
        bytes = path === BUNDLE ? bundle : fs.readFileSync(join(f.root, path.slice(5)));
      const archive = tar(bytes, path);
      return h.baseline && h.tar ? h.tar(archive, path) : archive;
    }
    if (args[0] === "exec") {
      if (args[2] === "sha256sum") {
        const path = args[3]!;
        return Buffer.from(
          `${path === BUNDLE ? hash(bundle) : hash(fs.readFileSync(join(f.root, path.slice(5))))}  ${path}\n`
        );
      }
      if (args.includes("owned-compose-postgres") || args.some((v) => v.includes("const roles")))
        return Buffer.from(h.db);
      const apis = Array.from({ length: h.apiCount }, () => api);
      return Buffer.from(JSON.stringify({ apis, socketDirectory, socket }));
    }
    if (
      args.join(" ") ===
      `compose -p ${project} -f infra/docker-compose.prod.yml -f tests/uat/compose.override.yml config --quiet`
    )
      return Buffer.alloc(0);
    if (args.includes("create") || args.includes("up")) {
      const creating = args.includes("create");
      if (creating || args.includes("jarv1s")) {
        events.push(creating ? "o2a-create" : "original-up");
        h.running = !creating;
        f.state.appPresent = true;
      }
      if (args.includes("postgres")) f.state.volumesPresent = true;
      return Buffer.alloc(0);
    }
    if (args[0] === "compose" && args.includes("ps"))
      return Buffer.from(f.state.appPresent ? f.id : "");
    if (args[0] === "ps") return Buffer.from(f.state.appPresent ? f.app.name.slice(1) : "");
    if (args.includes("down")) {
      f.state.appPresent = f.state.volumesPresent = false;
      return Buffer.alloc(0);
    }
    if (args[0] === "network" || args[0] === "rm") return Buffer.alloc(0);
    if (args.includes("run")) return Buffer.alloc(0);
    throw new Error("unexpected fake command");
  }
  const emit = (
    child: ChildProcess,
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
    close = true
  ) => {
    child.emit("exit", code, signal);
    events.push(child === build ? "build-exit" : "read-exit");
    if (close) {
      child.emit("close", code, signal);
      events.push(child === build ? "build-close" : "read-close");
    }
  };
  mocks.spawn.mockImplementation(
    (command: string, args: string[], spawnOptions: Record<string, unknown> = {}) => {
      calls.push({
        args: [...args],
        baseline: h.baseline,
        stdio: spawnOptions.stdio,
        env: spawnOptions.env
      });
      if (args[0] === "cp") expect(++pendingCopies).toBe(1);
      if (args[0] === "build" && h.spawnError) throw h.spawnError;
      const pid = ++nextPid,
        stdout = new EventEmitter(),
        stderr = new EventEmitter();
      processFiles.set(
        `/proc/${pid}/stat`,
        Buffer.from(
          `${pid} (docker) S 1 ${pid} ${pid} ` + Array(15).fill("0").join(" ") + " 12345 0"
        )
      );
      const child = Object.assign(new EventEmitter(), {
        pid,
        stdout,
        stderr,
        stdin: {
          write: (frame: string) => {
            const reply = observer.query(JSON.parse(frame));
            if (!h.dropReply) stdout.emit("data", Buffer.from(JSON.stringify(reply) + "\n"));
            return !h.backpressure;
          },
          end: () => {
            if (h.bridgeClose) queueMicrotask(() => emit(child));
          }
        }
      }) as unknown as ChildProcess;
      if (args.includes(NATIVE_BRIDGE)) {
        bridge = child;
        events.push("bridge-spawn");
        return child;
      }
      if (args[0] === "build") {
        build = child;
        events.push("build-spawn");
        f.state.built = true;
        if (!h.holdBuild) queueMicrotask(() => emit(child, h.buildCode, h.signal, !h.missingClose));
        return child;
      }
      queueMicrotask(() => {
        void data(command, args).then(
          (bytes) => {
            if (h.stderrOverflow) stderr.emit("data", Buffer.alloc(256 * 1024 + 1));
            stdout.emit("data", h.oversized ? Buffer.alloc(256 * 1024 + 1) : bytes);
            if (args[0] === "cp") pendingCopies--;
            emit(child);
          },
          () => child.emit("error", new Error("SECRET_SENTINEL"))
        );
      });
      return child;
    }
  );
  const fakeStat = (path: string) =>
    Object.assign(fs.lstatSync(join(f.root, "Dockerfile")), {
      size: 0,
      ino: Number(path.match(/\d+/)?.[0] ?? 1)
    });
  const io: Partial<InstalledIO> = {
    spawn: mocks.spawn,
    now: Date.now,
    retain: vi.fn(),
    realpath: ((path: fs.PathLike) =>
      processFiles.has(String(path))
        ? String(path)
        : fs.realpathSync(path)) as typeof fs.realpathSync,
    lstat: ((path: fs.PathLike) =>
      processFiles.has(String(path))
        ? fakeStat(String(path))
        : fs.lstatSync(path)) as typeof fs.lstatSync,
    open: ((path: fs.PathLike, flags: number) => {
      const bytes = processFiles.get(String(path));
      if (!bytes) return fs.openSync(path, flags);
      if (h.badBirth) throw new Error("ambiguous birth");
      const fd = ++nextFd;
      fds.set(fd, { data: bytes, offset: 0 });
      return fd;
    }) as typeof fs.openSync,
    // Descriptor and pathname observations preserve the same fake proc identity.
    fstat: ((fd: number) => {
      const entry = fds.get(fd);
      return entry ? fakeStat(entry.data.toString().split(" ")[0]!) : fs.fstatSync(fd);
    }) as typeof fs.fstatSync,
    read: ((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const entry = fds.get(fd);
      if (!entry) return fs.readSync(fd, buffer, offset, length, position);
      const count = entry.data.copy(buffer, offset, entry.offset, entry.offset + length);
      entry.offset += count;
      return count;
    }) as typeof fs.readSync,
    close: (fd: number) => {
      if (!fds.delete(fd)) fs.closeSync(fd);
    }
  };
  const collector = new InstalledCollector(authority, f.dir, io),
    before = collector.beforeInitialStart.bind(collector);
  vi.spyOn(collector, "beforeInitialStart").mockImplementation(async (input) => {
    events.push("installed-hook");
    h.baseline = true;
    h.before();
    await before(input);
    events.push("baseline-ready");
  });
  vi.spyOn(process, "cwd").mockReturnValue(f.root);
  vi.spyOn(options, "prepareN3Observer").mockImplementation((o, chat) =>
    prepare(o, chat, {
      env: {},
      readSource: () => immutable("tests/uat/n3-fallback-observer-bootstrap.mjs"),
      capture: async (c, a) => data(c, a)
    })
  );
  vi.spyOn(lifecycle, "createLifecycleRecorder").mockImplementation(async () => {
    const record = await createRecorder({ root: f.root, env: f.env, capture: f.capture });
    return async (phase, input) => {
      events.push(phase);
      await record(phase, input);
    };
  });
  const envPath = join(f.root, "env.production.local");
  vi.spyOn(envFile, "writeUatEnvFile").mockImplementation((input) => {
    fs.writeFileSync(envPath, options.n3ObserverEnv(input.n3Observer, undefined, {}).join("\n"), {
      mode: 0o600
    });
    return { path: envPath, cleanup: () => {} };
  });
  vi.stubEnv("JARVIS_UAT_LIFECYCLE_DIR", f.dir);
  vi.stubEnv("JARVIS_UAT_LIFECYCLE_NONCE", f.env.JARVIS_UAT_LIFECYCLE_NONCE);
  vi.stubEnv("JARVIS_IMAGE_TAG", "uat-unique");
  vi.stubEnv("JARVIS_UAT_BUILD", "1");
  const provision = (evidence = true, optIn = true) =>
    provisionForUat(
      "bare",
      { claimedWebPort: 5201, ...(optIn ? { n3Observer: option } : {}) },
      {
        listLiveSubnets: async () => [],
        installRealChatAuth: () => undefined,
        ...(evidence ? { n3BuildEvidence: collector } : {})
      }
    );
  const copies = () => calls.filter((c) => c.baseline && c.args[0] === "cp");
  const started = () => calls.filter((c) => c.args.includes("up") && c.args.includes("jarv1s"));
  const event = (fields: Record<string, unknown>) =>
    receive({ version: 1, sequence: ++sequence, ...fields });
  return {
    f,
    h,
    authority,
    collector,
    events,
    calls,
    provision,
    copies,
    started,
    event,
    get build() {
      return build;
    },
    get bridge() {
      return bridge;
    },
    emit,
    io
  };
}
const flush = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};
async function rejectBeforeStart(f: ReturnType<typeof fixture>) {
  await expect(f.provision()).rejects.toThrow();
  expect(f.started()).toHaveLength(0);
}
describe("connected original provisioner, O2a, P and installed collector", () => {
  it("constructs inertly and supplies actual original handle/raw exit/separate close before image-built and first up", async () => {
    const f = fixture();
    expect(f.calls).toHaveLength(0);
    f.h.holdBuild = true;
    const attach = vi.spyOn(f.collector, "observeBuild");
    const pending = f.provision();
    await flush();
    expect(f.build).toBeDefined();
    expect(f.events).not.toContain("image-built");
    f.build!.emit("exit", 0, null);
    await flush();
    expect(f.events).not.toContain("image-built");
    expect(f.started()).toHaveLength(0);
    f.build!.emit("close", 0, null);
    await pending;
    expect(attach).toHaveBeenCalledWith(
      "docker",
      ["build", "-t", f.f.reference, "-f", "Dockerfile", "."],
      f.f.root
    );
    expect(f.collector.receipts().build.birth.pid).toBe(f.build!.pid);
    expect(f.collector.receipts().build).toMatchObject({
      rawExitCode: 0,
      signal: null,
      closed: true
    });
    expect(f.events.indexOf("image-built")).toBeLessThan(f.events.indexOf("o2a-create"));
    expect(f.events.indexOf("o2a-create")).toBeLessThan(f.events.indexOf("installed-hook"));
    expect(f.events.indexOf("baseline-ready")).toBeLessThan(f.events.indexOf("original-up"));
    expect(f.copies().map((c) => c.args[1])).toEqual(INSTALLED_PATHS.map((p) => `${f.f.id}:${p}`));
    expect(f.started()).toHaveLength(1);
    expect(f.started()[0]!.args.at(-1)).toBe("--no-recreate");
    const composed = f.collector.compose();
    await composed.consumer.open();
    for (const [index, mode] of (["terminal", "terminal", "positive"] as const).entries()) {
      const current = [turn, actor, thread][index]!;
      await composed.consumer.beginWindow(actor, thread, mode);
      f.event({
        phase: "entry",
        site: "turn",
        attemptId: index * 10 + 1,
        actorUserId: actor,
        surface: "drawer",
        turnId: current,
        threadId: null,
        aborted: false
      });
      f.event({
        phase: "context",
        actorUserId: actor,
        surface: "drawer",
        turnId: current,
        threadId: thread
      });
      if (mode === "positive")
        for (const [offset, site] of ["shadow.start", "shadow.run"].entries()) {
          const attemptId = index * 10 + offset + 2;
          f.event({
            phase: "entry",
            site,
            attemptId,
            actorUserId: actor,
            surface: "drawer",
            turnId: current,
            threadId: thread,
            aborted: false
          });
          f.event({
            phase: "settle",
            site,
            attemptId,
            actorUserId: actor,
            surface: "drawer",
            turnId: current,
            threadId: thread,
            outcome: "ok",
            aborted: false
          });
        }
      f.event({
        phase: "settle",
        site: "turn",
        attemptId: index * 10 + 1,
        actorUserId: actor,
        surface: "drawer",
        turnId: current,
        threadId: thread,
        outcome: "ok",
        aborted: false
      });
      const result = await composed.consumer.finishWindow({
        actorUserId: actor,
        threadId: thread,
        turnId: current,
        surface: "drawer",
        complete: true,
        http: { status: 200, finished: true, receiptSha256: "7".repeat(64) },
        ui: { finished: true, receiptSha256: "8".repeat(64) }
      });
      expect(result.delta.turn).toBe(1);
      expect(result.delta["shadow.run"]).toBe(mode === "positive" ? 1 : 0);
    }
    expect(f.events.filter((e) => e === "bridge-spawn")).toHaveLength(1);
    expect(await composed.consumer.close()).toEqual({ disposed: true, retained: undefined });
    expect(composed.expected.files["/app/tests/uat/lifecycle-records.ts"]).toBe(
      f.authority.producerSha256
    );
    expect(f.collector.receipts().baseline.inspections).toHaveLength(2);
    const copies = f.collector.receipts().baseline.copies;
    expect(copies.map((c) => c.path)).toEqual(INSTALLED_PATHS);
    expect(copies.reduce((sum, c) => sum + c.archiveBytes, 0)).toBeLessThan(67548160);
    console.info(JSON.stringify(f.collector.receipts().baseline));
  });
  it("omitted hooks preserve default commands/stdio/env and use the original build once", async () => {
    const f = fixture();
    await f.provision(false, false);
    expect(f.collector.beforeInitialStart).not.toHaveBeenCalled();
    expect(f.copies()).toHaveLength(0);
    expect(f.calls.filter((c) => c.args[0] === "build")).toEqual([
      {
        args: ["build", "-t", f.f.reference, "-f", "Dockerfile", "."],
        baseline: false,
        stdio: ["inherit", "inherit", "pipe"],
        env: undefined
      }
    ]);
    expect(f.started()).toHaveLength(1);
    expect(f.started()[0]!.args).not.toContain("--no-recreate");
    expect(f.events.indexOf("image-built")).toBeGreaterThan(f.events.indexOf("build-exit"));
  });
  it("refuses inconsistent observer opt-in before any original build", async () => {
    const f = fixture();
    await expect(f.provision(true, false)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    "nonzero",
    "signal",
    "spawn",
    "birth",
    "substituted",
    "missing-close",
    "source-close",
    "daemon-close"
  ])("refuses original-child %s uncertainty", async (kind) => {
    const f = fixture();
    if (kind === "nonzero") f.h.buildCode = 7;
    if (kind === "signal") {
      f.h.buildCode = null;
      f.h.signal = "SIGTERM";
    }
    if (kind === "spawn") f.h.spawnError = new Error("original-spawn-error");
    if (kind === "birth") f.h.badBirth = true;
    if (kind === "missing-close") f.h.missingClose = true;
    if (kind === "source-close" || kind === "daemon-close") f.h.holdBuild = true;
    if (kind === "substituted") {
      const observe = f.collector.observeBuild.bind(f.collector);
      vi.spyOn(f.collector, "observeBuild").mockImplementation(async (...args) => {
        const observation = await observe(...args);
        return {
          ...observation,
          attach: () =>
            observation.attach(Object.assign(new EventEmitter(), { pid: 999 }) as ChildProcess)
        };
      });
    }
    const pending = f.provision();
    const rejected =
      kind === "spawn"
        ? expect(pending).rejects.toBe(f.h.spawnError)
        : expect(pending).rejects.toThrow();
    await flush();
    if (kind === "source-close" || kind === "daemon-close") {
      if (kind === "source-close") f.h.drift = true;
      else f.f.state.daemon = "wrong";
      f.emit(f.build!);
    }
    if (kind === "missing-close") await vi.advanceTimersByTimeAsync(20001);
    await rejected;
    expect(f.f.state).toMatchObject({ appPresent: false, volumesPresent: false });
    expect(f.events).not.toContain("image-built");
    expect(f.started()).toHaveLength(0);
    if (kind !== "spawn") expect(f.collector.retained.size).toBeGreaterThan(0);
  });
  it.each(["host-source", "channel-mode", "chain", "inventory", "daemon", "source"])(
    "authenticates %s before any new baseline cp",
    async (kind) => {
      const f = fixture();
      f.h.before = () => {
        if (kind === "host-source")
          fs.writeFileSync(join(f.f.root, "tests/uat/lifecycle-records.ts"), "wrong");
        if (kind === "channel-mode") fs.chmodSync(f.f.dir, 0o755);
        if (kind === "daemon") f.f.state.daemon = "wrong";
        if (kind === "source") f.h.drift = true;
        if (kind === "chain" || kind === "inventory") {
          const path = join(f.f.dir, "000003.json"),
            record = JSON.parse(fs.readFileSync(path, "utf8"));
          if (kind === "chain") record.previousDigest = "0".repeat(64);
          else record.inventory = [];
          delete record.digest;
          fs.writeFileSync(path, JSON.stringify({ ...record, digest: digest(record) }));
        }
      };
      await rejectBeforeStart(f);
      expect(f.copies()).toHaveLength(0);
    }
  );
  it.each(["bind", "volume", "tmpfs", "other"])(
    "rejects all %s file/ancestor overlays before cp/up",
    async (type) => {
      for (const destination of [INSTALLED_PATHS[0], "/app", "/", "/app/packages/chat/src/live"]) {
        const f = fixture();
        f.h.initial = (info) => {
          const mounts = info.Mounts as object[];
          mounts.push({ Type: type, Destination: destination, Source: "/owned", Name: "other" });
          if (type === "tmpfs") edit(info, "HostConfig.Tmpfs", { [String(destination)]: "" });
        };
        await rejectBeforeStart(f);
        expect(f.copies(), String(destination)).toHaveLength(0);
      }
    }
  );
  it.each(["relative", "trailing", "duplicate", "incomplete", "auth", "socket", "volume-inspect"])(
    "refuses independent %s mount/config uncertainty",
    async (kind) => {
      const f = fixture();
      f.h.initial = (info) => {
        const mounts = info.Mounts as Record<string, unknown>[];
        if (kind === "relative")
          mounts.push({ Type: "bind", Source: "/x", Destination: "relative" });
        if (kind === "trailing")
          mounts.push({ Type: "bind", Source: "/x", Destination: "/other/" });
        if (kind === "duplicate") mounts.push({ ...mounts[0] });
        if (kind === "incomplete") edit(info, "HostConfig.Tmpfs", { "/app": "" });
        if (kind === "auth") mounts.splice(0, 1);
        if (kind === "socket") mounts[1]!.Name = "wrong";
        if (kind === "volume-inspect") f.f.volumes[0]!.driver = "wrong";
      };
      await rejectBeforeStart(f);
      expect(f.copies()).toHaveLength(0);
    }
  );
  it("accepts a sibling-prefix mount without broadening the exact file map", async () => {
    const f = fixture();
    f.h.initial = f.h.final = (info) =>
      (info.Mounts as object[]).push({
        Type: "bind",
        Source: "/owned",
        Destination: "/application"
      });
    await f.provision();
    expect(f.copies()).toHaveLength(14);
    expect(f.started()).toHaveLength(1);
  });
  it.each(["overlay", "image", "config", "state", "diff"])(
    "refuses final-only %s substitution after all baseline copies",
    async (kind) => {
      const f = fixture();
      f.h.final = (info) => {
        if (kind === "overlay")
          (info.Mounts as object[]).push({
            Type: "bind",
            Source: "/owned",
            Destination: INSTALLED_PATHS[0]
          });
        if (kind === "image") info.Image = "sha256:" + "9".repeat(64);
        if (kind === "config") edit(info, "Config.Image", "wrong");
        if (kind === "state") edit(info, "State.Running", true);
        if (kind === "diff") f.h.dirty = true;
      };
      await rejectBeforeStart(f);
      expect(f.copies()).toHaveLength(14);
    }
  );
  it.each([
    "symlink",
    "hardlink",
    "extra",
    "directory",
    "duplicate",
    "traversal",
    "absolute",
    "pax",
    "longname",
    "checksum",
    "size",
    "truncated",
    "trailing"
  ])("rejects matching bytes inside invalid %s baseline tar before up", async (kind) => {
    const f = fixture();
    f.h.tar = (archive, path) => {
      if (path !== INSTALLED_PATHS[0]) return archive;
      const bytes = fs.readFileSync(join(f.f.root, path.slice(5)));
      if (["symlink", "hardlink", "pax", "longname"].includes(kind))
        return tar(
          bytes,
          path,
          ({ symlink: "2", hardlink: "1", pax: "x", longname: "L" } as Record<string, string>)[kind]
        );
      if (kind === "traversal" || kind === "absolute")
        return tar(bytes, path, "0", kind === "absolute" ? "/bootstrap" : "../bootstrap");
      if (kind === "checksum") {
        archive[0] = 88;
        return archive;
      }
      if (kind === "size") {
        archive.write("99999999999\0", 124, 12);
        checksum(archive);
        return archive;
      }
      if (kind === "truncated") return archive.subarray(0, archive.length - 512);
      return Buffer.concat([
        archive.subarray(0, archive.length - 1024),
        tar(
          Buffer.alloc(0),
          path,
          kind === "directory" ? "5" : "0",
          kind === "extra" ? "other" : "n3-fallback-observer-bootstrap.mjs"
        )
      ]);
    };
    await rejectBeforeStart(f);
    expect(f.copies()).toHaveLength(1);
  });
  it.each([
    "api",
    "db",
    "source",
    "daemon",
    "bridge-command",
    "bridge-close",
    "backpressure",
    "late-reply"
  ])("retains independent running %s semantics through the accepted adapter", async (kind) => {
    const f = fixture();
    await f.provision();
    const composed = f.collector.compose();
    if (kind === "api") f.h.apiCount = 2;
    if (kind === "db") f.h.db = "wrong";
    if (kind === "source") f.h.drift = true;
    if (kind === "daemon") f.f.state.daemon = "wrong";
    if (["api", "db", "source", "daemon"].includes(kind)) {
      await expect(composed.consumer.open()).rejects.toThrow();
      return;
    }
    if (kind === "bridge-command") {
      expect(() =>
        composed.collectors.bridge(
          {
            command: "docker",
            args: ["run", "verifier"],
            daemon: f.authority.daemon,
            deadline: f.authority.option.deadline
          },
          { data: vi.fn(), failure: vi.fn(), closed: vi.fn() }
        )
      ).toThrow();
      return;
    }
    if (kind === "backpressure") f.h.backpressure = true;
    if (kind === "late-reply") f.h.dropReply = true;
    if (kind === "backpressure" || kind === "late-reply") {
      const pending = composed.consumer.open();
      const assertion = expect(pending).rejects.toThrow();
      await flush();
      if (kind === "late-reply") await vi.advanceTimersByTimeAsync(20001);
      await assertion;
      expect(f.collector.retained.size).toBeGreaterThan(0);
      return;
    }
    await composed.consumer.open();
    f.h.bridgeClose = false;
    const pending = composed.consumer.close();
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(f.collector.retained.has(f.bridge!)).toBe(true);
  });
  it.each(["archive", "host-source"])(
    "refuses %s ceiling overflow before first up",
    async (kind) => {
      const f = fixture(),
        key = INSTALLED_PATHS[0]!;
      if (kind === "archive")
        f.h.tar = (_bytes, path) =>
          path === key
            ? Buffer.alloc(512 + Math.ceil(SOURCE_FILES[key]![1] / 512) * 512 + 16384 + 512)
            : _bytes;
      else f.h.before = () => fs.appendFileSync(join(f.f.root, key.slice(5)), "overflow");
      await rejectBeforeStart(f);
      expect(f.copies()).toHaveLength(1);
    }
  );
  it("refuses oversized stderr before baseline cp/start and redacts raw errors", async () => {
    const f = fixture();
    f.h.stderrOverflow = true;
    await expect(f.provision()).rejects.toThrow(/^N3 installed: RED$/);
    expect(f.copies()).toHaveLength(0);
    expect(f.started()).toHaveLength(0);
    expect(f.collector.retained.size).toBeGreaterThan(0);
  });
  it("enforces metadata output ceiling, shared deadline and no late start/spawn", async () => {
    const f = fixture();
    f.h.oversized = true;
    await rejectBeforeStart(f);
    expect(f.collector.retained.size).toBeGreaterThan(0);
    const g = fixture();
    g.h.holdBuild = true;
    const pending = g.provision();
    const assertion = expect(pending).rejects.toThrow();
    await flush();
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    const before = g.calls.length;
    g.emit(g.build!);
    await flush();
    expect(g.calls).toHaveLength(before);
    expect(g.started()).toHaveLength(0);
    expect(() => g.collector.compose()).toThrow(/^N3 installed: RED$/);
  });
});
