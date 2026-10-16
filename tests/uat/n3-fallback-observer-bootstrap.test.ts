import type * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as OsActual from "node:os";
import * as Path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { deriveTrustedOrigins } from "../../scripts/setup-prod-origins.js";
import { UAT_ADMIN_ID } from "./seed/admin.js";
import type * as Os from "node:os";
import type * as Net from "node:net";
import { EventEmitter } from "node:events";
import { channel } from "node:diagnostics_channel";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleFixture } from "./provisioner-lifecycle-fixture.js";
import * as options from "./provisioner-options.js";
import {
  n3ObserverEnv,
  prepareN3Observer,
  type N3ObserverOption,
  type N3Capture
} from "./provisioner-options.js";
import * as envFile from "./env-file.js";
import type {
  ChatAttemptEvent,
  ChatAttemptSite
} from "../../packages/chat/src/live/chat-attempt-observer.js";
// @ts-expect-error The fixed Node import is deployed as native JavaScript, without a source loader.
import { activateObserver, runtime, SITES } from "./n3-fallback-observer-bootstrap.mjs";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), createServer: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
  execFileSync: vi.fn(() => "{}")
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof Os>()),
  networkInterfaces: () => ({})
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof Net>()),
  createServer: mocks.createServer
}));
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turn = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const identity = { pid: 123, startTicks: "12345", bootId: actor, containerId: "a".repeat(64) };
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const source = readFileSync(new URL("./n3-fallback-observer-bootstrap.mjs", import.meta.url));
const option = (): N3ObserverOption => ({
  nonce: "ab".repeat(32),
  bootstrapSha256: hash(source),
  schema: 1,
  deadline: Date.now() + 60_000
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function harness(overrides: Record<string, unknown> = {}) {
  let now = 1000;
  let expire: (() => void) | undefined;
  let connected: ((socket: EventEmitter) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_path: string, ready: () => void) => ready()),
    close: vi.fn((done: () => void) => done())
  });
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    destroy: vi.fn()
  });
  const io = {
    entry: "/app/dist/server.js",
    now: () => now,
    realEntry: () => "/app/dist/server.js",
    selfHash: () => "a".repeat(64),
    entryHash: () => "b".repeat(64),
    identity: () => ({ ...identity }),
    sameIdentity: vi.fn(() => true),
    makePrivate: vi.fn(),
    privateTransport: vi.fn(() => true),
    socketPath: () => "/private/observer.sock",
    secureSocket: vi.fn(),
    encode: vi.fn(JSON.stringify),
    subscribe: vi.fn(() => vi.fn()),
    server: vi.fn((fn: (socket: EventEmitter) => void) => {
      connected = fn;
      return server;
    }),
    timer: vi.fn((fn: () => void) => {
      expire = fn;
      return { unref: vi.fn() };
    }),
    barrierToken: () => thread,
    clearTimer: vi.fn(),
    ...overrides
  };
  const config = {
    nonce: "a".repeat(64),
    bootstrapSha256: "a".repeat(64),
    schema: 1,
    deadline: 5000
  };
  const api = activateObserver(config, io);
  cleanups.push(() => api.close());
  let sequence = 0;
  let requestId = 0;
  const publish = (fields: Partial<ChatAttemptEvent>) => {
    const event = { version: 1, sequence: ++sequence, ...fields };
    api.receive(event);
    return event.sequence;
  };
  const ready = () => publish({ phase: "coverage", sites: SITES });
  const query = (fields: Record<string, unknown>) =>
    api.query({
      version: 1,
      nonce: config.nonce,
      requestId: ++requestId,
      identity: { ...identity },
      ...fields
    });
  const begin = (mode = "terminal") =>
    query({ op: "begin", actorUserId: actor, threadId: thread, surface: "drawer", mode });
  const entry = (site: ChatAttemptSite = "turn", turnId = turn) => {
    const id = sequence + 1;
    publish({
      phase: "entry",
      site,
      attemptId: id,
      actorUserId: actor,
      turnId,
      threadId: site === "turn" ? null : thread,
      surface: "drawer",
      aborted: false
    });
    return id;
  };
  const bind = () =>
    publish({
      phase: "context",
      actorUserId: actor,
      turnId: turn,
      threadId: thread,
      surface: "drawer"
    });
  const settle = (id: number, site: ChatAttemptSite = "turn", turnId = turn) =>
    publish({
      phase: "settle",
      site,
      attemptId: id,
      actorUserId: actor,
      turnId,
      threadId: thread,
      surface: "drawer",
      aborted: false,
      outcome: "ok"
    });
  const finish = () => {
    const barrier = query({ op: "barrier", sequence }).barrier;
    return query({
      op: "end",
      sequence,
      barrier: barrier?.token,
      actorUserId: actor,
      threadId: thread,
      surface: "drawer",
      turnId: turn,
      complete: true
    });
  };
  return {
    api,
    io,
    server,
    socket,
    config,
    publish,
    ready,
    query,
    begin,
    entry,
    bind,
    settle,
    finish,
    connect: () => connected?.(socket),
    expire: () => expire?.(),
    setNow: (v: number) => {
      now = v;
    },
    sequence: () => sequence
  };
}

describe("N3 whole subscriber and cumulative version 1 protocol", () => {
  it("requires all coverage and an acknowledged barrier, retaining counters across windows", () => {
    const h = harness();
    expect(h.api.status().ready).toBe(false);
    h.ready();
    expect(h.begin().ready).toBe(true);
    const id = h.entry();
    h.bind();
    h.settle(id);
    const result = h.finish();
    expect(result).toMatchObject({
      completedWindows: 1,
      openAttempts: 0,
      error: null,
      counters: { turn: 1 },
      delta: { turn: 1 }
    });
    h.begin();
    const nextTurn = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const next = h.entry("turn", nextTurn);
    h.publish({
      phase: "context",
      actorUserId: actor,
      turnId: nextTurn,
      threadId: thread,
      surface: "drawer"
    });
    h.settle(next, "turn", nextTurn);
    expect(h.api.status()).toMatchObject({
      counters: { turn: 2 },
      attempts: 2,
      sequence: h.sequence(),
      completedWindows: 1
    });
  });
  it.each(["heal", "shadow.run"] as const)(
    "keeps detached %s pending after turn settlement",
    (site) => {
      const h = harness();
      h.ready();
      h.begin("positive");
      const id = h.entry();
      h.bind();
      const detached = h.entry(site);
      h.settle(id);
      expect(h.api.status().openAttempts).toBe(1);
      h.settle(detached, site);
      expect(h.finish()).toMatchObject({ error: null, completedWindows: 1 });
    }
  );
  it("rejects a barrier while the original detached descendant remains pending", () => {
    const h = harness();
    h.ready();
    h.begin("positive");
    const id = h.entry();
    h.bind();
    h.entry("heal");
    h.settle(id);
    expect(h.query({ op: "barrier", sequence: h.sequence() }).error).toBe("barrier");
  });
  it.each([
    "missing_barrier",
    "wrong_actor",
    "wrong_thread",
    "wrong_turn",
    "no_completion",
    "forbidden"
  ])("makes %s evidence sticky red", (which) => {
    const h = harness();
    h.ready();
    h.begin();
    const id = h.entry();
    h.bind();
    if (which === "forbidden") {
      const launch = h.entry("launch");
      h.settle(launch, "launch");
    }
    h.settle(id);
    const barrier = h.query({ op: "barrier", sequence: h.sequence() }).barrier;
    const result = h.query({
      op: "end",
      sequence: h.sequence(),
      barrier: barrier?.token,
      actorUserId: which === "wrong_actor" ? thread : actor,
      threadId: which === "wrong_thread" ? actor : thread,
      surface: "drawer",
      turnId: which === "wrong_turn" ? actor : turn,
      complete: which !== "no_completion",
      ...(which === "missing_barrier" ? { barrier: 0 } : {})
    });
    expect(result.ready).toBe(false);
    expect(result.error).toBeTruthy();
    expect(h.query({ op: "status" }).error).toBe(result.error);
  });
  it.each([
    "loss",
    "reset",
    "schema",
    "unknown_context",
    "coverage_loss",
    "concurrency",
    "orphan",
    "double_settle"
  ])("rejects %s at the real receive boundary", (which) => {
    const h = harness();
    h.ready();
    if (which === "loss" || which === "reset")
      h.api.receive({
        version: 1,
        sequence: which === "loss" ? 3 : 1,
        phase: "coverage",
        sites: SITES
      });
    if (which === "schema")
      h.api.receive({ version: 2, sequence: 2, phase: "coverage", sites: SITES });
    if (which === "unknown_context") h.publish({ phase: "entry", site: "launch", attemptId: 2 });
    if (which === "coverage_loss") h.publish({ phase: "coverage", sites: ["turn"] });
    if (which === "orphan") h.entry("heal");
    if (which === "concurrency") {
      h.entry();
      h.entry("turn", actor);
    }
    if (which === "double_settle") {
      const id = h.entry();
      h.bind();
      h.settle(id);
      h.settle(id);
    }
    expect(h.api.status().error).toBeTruthy();
  });
  it.each(["identity", "permissions", "deadline"])(
    "detects %s without resetting the shared deadline",
    (which) => {
      const h = harness();
      h.ready();
      if (which === "identity") h.io.sameIdentity.mockReturnValue(false);
      if (which === "permissions") h.io.privateTransport.mockReturnValue(false);
      if (which === "deadline") h.setNow(h.config.deadline);
      expect(h.api.status().error).toBe(which);
      expect(h.io.timer).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "realEntry",
    "selfHash",
    "identity",
    "makePrivate",
    "server",
    "subscribe",
    "timer",
    "secureSocket",
    "encode",
    "sameIdentity",
    "privateTransport"
  ])("contains the %s failure domain without publishing a raw error", (method) => {
    const h = harness({
      [method]: () => {
        throw new Error("SECRET_SENTINEL");
      }
    });
    h.ready();
    expect(() => h.api.status()).not.toThrow();
    expect(h.api.status()?.ready).not.toBe(true);
    expect(JSON.stringify(h.api.status())).not.toContain("SECRET_SENTINEL");
  });
  it("contains thenable throws and promise rejection callbacks", async () => {
    const h = harness();
    h.ready();
    expect(() =>
      h.api.guard(() => ({
        get then() {
          throw new Error("SECRET_SENTINEL");
        }
      }))()
    ).not.toThrow();
    expect(h.api.status().error).toBe("callback");
    const next = harness();
    next.ready();
    next.api.guard(() => Promise.reject(new Error("SECRET_SENTINEL")))();
    await Promise.resolve();
    await Promise.resolve();
    expect(next.api.status().error).toBe("callback");
  });
  it("contains synchronous and asynchronous timer, socket, serialization and cleanup failures", async () => {
    const h = harness();
    h.ready();
    h.connect();
    h.socket.emit("error", new Error("SECRET_SENTINEL"));
    expect(h.api.status().error).toBe("transport");
    expect(() => h.expire()).not.toThrow();
    h.server.close.mockImplementation(() => {
      throw new Error("SECRET_SENTINEL");
    });
    expect(() => h.api.close()).not.toThrow();
    expect(h.io.clearTimer).toHaveBeenCalled();
    const serial = harness();
    serial.ready();
    serial.connect();
    serial.io.encode.mockImplementation(() => {
      throw new Error("SECRET_SENTINEL");
    });
    serial.socket.emit("data", Buffer.from("{}\n"));
    expect(serial.api.status().error).toBeTruthy();
    const timer = harness();
    timer.ready();
    timer.expire();
    expect(timer.api.status().error).toBe("deadline");
    const rejected = harness({ subscribe: () => Promise.reject(new Error("SECRET_SENTINEL")) });
    // A malformed async subscription initializer is rejected by initialization validation.
    rejected.api.close();
    await Promise.resolve();
  });
  it.each(["supervisor", "worker", "health", "query", "migration"])(
    "keeps imported %s children inert",
    (name) => {
      const h = harness({ entry: `/app/${name}.js` });
      expect(h.io.makePrivate).not.toHaveBeenCalled();
      expect(h.io.subscribe).not.toHaveBeenCalled();
      expect(h.io.timer).not.toHaveBeenCalled();
    }
  );
  it.each([
    "oversized",
    "malformed",
    "extra_field",
    "wrong_nonce",
    "wrong_identity",
    "loss",
    "backpressure",
    "write_throw"
  ])("bounds and fails %s transport without content in replies", (which) => {
    const h = harness();
    h.ready();
    h.connect();
    const command = { version: 1, nonce: h.config.nonce, requestId: 1, op: "status", identity };
    if (which === "loss") h.socket.emit("close");
    else if (which === "oversized") h.socket.emit("data", Buffer.alloc(4097, 65));
    else if (which === "malformed") h.socket.emit("data", Buffer.from("SECRET_SENTINEL\n"));
    else {
      if (which === "backpressure") h.socket.write.mockReturnValue(false);
      if (which === "write_throw")
        h.socket.write.mockImplementation(() => {
          throw new Error("SECRET_SENTINEL");
        });
      const frame = {
        ...command,
        ...(which === "extra_field" ? { text: "SECRET_SENTINEL" } : {}),
        ...(which === "wrong_nonce" ? { nonce: "b".repeat(64) } : {}),
        ...(which === "wrong_identity" ? { identity: { ...identity, pid: 999 } } : {})
      };
      h.socket.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
    }
    expect(h.api.status().error).toBeTruthy();
    expect(JSON.stringify(h.socket.write.mock.calls)).not.toContain("SECRET_SENTINEL");
  });
  it("caps cumulative attempts and metadata rather than resetting at a window", () => {
    const h = harness({ encode: () => "x" });
    h.ready();
    const id = h.entry();
    h.bind();
    for (let i = 0; i < 255; i++) {
      const a = h.entry("heal");
      h.settle(a, "heal");
    }
    expect(h.api.status().attempts).toBe(256);
    h.entry("heal");
    expect(h.api.status().error).toBe("attempt_limit");
    h.settle(id);
    const bytes = harness({ encode: () => "x".repeat(4096) });
    bytes.ready();
    for (let i = 0; i < 16; i++) bytes.ready();
    expect(bytes.api.status().error).toBe("metadata_limit");
  });
  it("applies private directory/socket modes and detects replacement at the actual runtime seam", () => {
    const stat = (socket: boolean) => ({
      ino: socket ? 2 : 1,
      dev: 3,
      uid: process.getuid!(),
      mode: socket ? 0o600 : 0o700,
      isDirectory: () => !socket,
      isSocket: () => socket
    });
    const files = {
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
      lstatSync: vi.fn((path: string) => stat(path.endsWith(".sock")))
    };
    const io = runtime("/app/dist/server.js", files);
    io.makePrivate("a".repeat(64));
    io.secureSocket();
    expect(files.mkdirSync).toHaveBeenCalledWith(`/run/jarv1s/n3-${"a".repeat(64)}`, {
      mode: 0o700
    });
    expect(files.chmodSync).toHaveBeenCalledWith(
      `/run/jarv1s/n3-${"a".repeat(64)}/observer.sock`,
      0o600
    );
    expect(io.privateTransport()).toBe(true);
    files.lstatSync.mockImplementation((path: string) => ({
      ...stat(path.endsWith(".sock")),
      ino: 999
    }));
    expect(io.privateTransport()).toBe(false);
  });
  it("accepts actual O1 turn events and waits for a detached original promise", async () => {
    const diagnostics = channel("moss.chat.attempt.v1");
    const h = harness({
      subscribe: (receive: (event: unknown) => void) => {
        diagnostics.subscribe(receive);
        return () => diagnostics.unsubscribe(receive);
      }
    });
    const observer = await import("../../packages/chat/src/live/chat-attempt-observer.js");
    observer.registerChatAttemptSites(...SITES);
    h.begin("positive");
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    observer.observeChatTurn({ actorUserId: actor, surface: "drawer", turnId: turn }, () => {
      observer.bindChatAttemptThread(thread, { actorUserId: actor, surface: "drawer" });
      observer.observeChatAttempt("heal", () => pending);
    });
    expect(h.api.status()).toMatchObject({ error: null, openAttempts: 1 });
    resolve();
    await pending;
    await Promise.resolve();
    expect(h.api.status()).toMatchObject({
      error: null,
      openAttempts: 0,
      counters: { turn: 1, heal: 1 }
    });
  });
});

function tarFile(bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write("file.mjs");
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header[156] = 48;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length + 1024)
  ]);
}
function provisioningFixture() {
  const f = lifecycleFixture();
  cleanups.push(f.dispose);
  const config = { ...option() };
  const file = envFile.writeUatEnvFile({
    webPort: 5201,
    subnet: "10.250.1.0/24",
    n3Observer: config
  });
  cleanups.push(file.cleanup);
  const events: string[] = [];
  const info = {
    Id: f.id,
    Image: f.imageId,
    State: { Status: "created" },
    Config: { Image: f.reference, Env: n3ObserverEnv(config, undefined, {}) },
    Mounts: [
      ["jarv1s-cli-auth", "/data/cli-auth"],
      ["jarv1s-cli-socket", "/run/jarv1s"]
    ].map(([name, Destination]) => ({
      Type: "volume",
      Name: `${f.attempt.projectName}_${name}`,
      Destination
    }))
  };
  const capture: N3Capture = vi.fn(async (command, args, deadline) => {
    expect(deadline).toBe(config.deadline);
    if (command === "git" && args[0] === "show") return source;
    if (command === "git") return Buffer.from(await f.capture(command, args, f.env, f.root));
    if (args.includes("create")) {
      events.push("create");
      f.state.appPresent = true;
      return Buffer.alloc(0);
    }
    if (args.includes("ps")) return Buffer.from(f.id);
    if (args[0] === "container") {
      events.push("inspect");
      return Buffer.from(JSON.stringify(info));
    }
    if (args[0] === "image") return Buffer.from(f.imageId);
    if (args[0] === "cp") {
      events.push("bootstrap-hash");
      return tarFile(source);
    }
    throw new Error("Unexpected fake command");
  });
  const prepare = () =>
    prepareN3Observer(config, undefined, { env: {}, capture, readSource: () => source });
  const input = {
    projectName: f.attempt.projectName,
    envPath: file.path,
    recordCreated: async () => {
      events.push("producer-created");
    }
  };
  return { f, config, file, events, info, capture, prepare, input };
}

describe("N3 typed initial-start provisioning and immutable pins", () => {
  it("preserves exact default env bytes and omitted-option no-effects", async () => {
    const input = { webPort: 5201, subnet: "10.250.1.0/24" };
    const child = await vi.importActual<typeof ChildProcess>("node:child_process");
    const baseline = child.execFileSync(
      "git",
      ["show", "8fe37b0858a3ccd8f838d4c6ddbf42763708f558:tests/uat/env-file.ts"],
      { encoding: "utf8" }
    );
    const exports: Record<string, unknown> = {};
    const modules: Record<string, unknown> = {
      "node:child_process": { execFileSync: () => "{}" },
      "node:fs": Fs,
      "node:os": { ...OsActual, networkInterfaces: () => ({}) },
      "node:path": Path,
      "../../scripts/setup-prod-origins.js": { deriveTrustedOrigins },
      "./seed/admin.js": { UAT_ADMIN_ID }
    };
    runInNewContext(
      ts.transpileModule(baseline, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022
        }
      }).outputText,
      {
        exports,
        process: {
          env: { JARVIS_UAT_EXTRA_ORIGIN_HOSTS: process.env.JARVIS_UAT_EXTRA_ORIGIN_HOSTS }
        },
        require: (name: string) => {
          if (!(name in modules)) throw new Error("Unexpected baseline import");
          return modules[name];
        }
      }
    );
    const baselineWriter = exports.writeUatEnvFile as typeof envFile.writeUatEnvFile;
    const original = baselineWriter(input);
    cleanups.push(original.cleanup);
    const explicit = envFile.writeUatEnvFile(input);
    cleanups.push(explicit.cleanup);
    expect(readFileSync(original.path)).toEqual(readFileSync(explicit.path));
    expect(readFileSync(explicit.path, "utf8")).not.toMatch(/NODE_OPTIONS|MOSS_N3_OBSERVER/);
    const capture = vi.fn();
    expect(await prepareN3Observer(undefined, undefined, { capture })).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([
    "nonce",
    "hash",
    "schema",
    "deadline",
    "expired",
    "extra",
    "loader",
    "script",
    "inherited_script"
  ])("rejects %s before env allocation or source/image commands", async (which) => {
    const config = option();
    const raw: Record<string, unknown> = { ...config };
    const env: NodeJS.ProcessEnv = {};
    if (which === "nonce") raw.nonce = "SECRET_SENTINEL\nBAD=1";
    if (which === "hash") raw.bootstrapSha256 = "bad";
    if (which === "schema") raw.schema = 2;
    if (which === "deadline") raw.deadline = Infinity;
    if (which === "expired") raw.deadline = Date.now() - 1;
    if (which === "extra") raw.import = "SECRET_SENTINEL";
    if (which === "loader") env.NODE_OPTIONS = "--import=SECRET_SENTINEL";
    if (which === "inherited_script") env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN = "SECRET_SENTINEL";
    const capture = vi.fn();
    await expect(
      prepareN3Observer(
        raw as unknown as N3ObserverOption,
        which === "script" ? "scripted" : undefined,
        { capture, env }
      )
    ).rejects.toThrow(/validation failed/);
    expect(capture).not.toHaveBeenCalled();
  });
  it("derives fixed import and verifies the single stopped initial container before start", async () => {
    const p = provisioningFixture();
    const prepared = await p.prepare();
    await prepared!.beforeInitialStart(p.input);
    expect(p.events).toEqual([
      "create",
      "producer-created",
      "inspect",
      "bootstrap-hash",
      "inspect"
    ]);
    expect(p.f.state.appPresent).toBe(true);
    expect(statSync(p.file.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(p.file.path, "utf8")).toContain(
      `NODE_OPTIONS=--import=${options.N3_BOOTSTRAP_PATH}\n`
    );
    expect(
      (p.capture as ReturnType<typeof vi.fn>).mock.calls.every(
        ([, args]) => !args.includes("run") && !args.includes("start") && !args.includes("up")
      )
    ).toBe(true);
  });
  it.each([
    "source",
    "image",
    "bootstrap",
    "env",
    "mounts",
    "state",
    "identity",
    "deadline",
    "producer"
  ])("rejects %s pin or boundary failure before initial start", async (which) => {
    const p = provisioningFixture();
    if (which === "source") p.config.bootstrapSha256 = "0".repeat(64);
    if (which === "image") p.info.Image = `sha256:${"3".repeat(64)}`;
    if (which === "env") p.info.Config.Env = ["SECRET_SENTINEL"];
    if (which === "mounts") p.info.Mounts = [];
    if (which === "state") p.info.State.Status = "running";
    if (which === "identity") p.info.Id = "9".repeat(64);
    if (which === "bootstrap")
      vi.mocked(p.capture).mockImplementation(async (cmd, args) =>
        cmd === "git"
          ? args[0] === "show"
            ? source
            : Buffer.from(args[0] === "status" ? "" : "3".repeat(40))
          : args[0] === "cp"
            ? tarFile(Buffer.from("SECRET_SENTINEL"))
            : Buffer.from(
                args[0] === "container"
                  ? JSON.stringify(p.info)
                  : args[0] === "image"
                    ? p.f.imageId
                    : args.includes("ps")
                      ? p.f.id
                      : ""
              )
      );
    const promise = p.prepare().then(async (prepared) => {
      if (which === "deadline") vi.spyOn(Date, "now").mockReturnValue(p.config.deadline);
      await prepared!.beforeInitialStart({
        ...p.input,
        recordCreated:
          which === "producer"
            ? async () => {
                throw new Error("producer-boundary-failed");
              }
            : p.input.recordCreated
      });
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });
  it("rejects a bad source pin before all command I/O", async () => {
    const p = provisioningFixture();
    p.config.bootstrapSha256 = "0".repeat(64);
    await expect(p.prepare()).rejects.toThrow(/validation failed/);
    expect(p.capture).not.toHaveBeenCalled();
  });
  it("scrubs raw child and invalid JSON errors without swallowing the provisioning failure", async () => {
    for (const malformed of [false, true]) {
      const p = provisioningFixture();
      const original = p.capture;
      const capture: N3Capture = (command, args, deadline) => {
        if (command === "docker" && args[0] === "container") {
          if (malformed) return Promise.resolve(Buffer.from("SECRET_SENTINEL"));
          return Promise.reject(new Error("SECRET_SENTINEL"));
        }
        return original(command, args, deadline);
      };
      const error = await prepareN3Observer(p.config, undefined, {
        env: {},
        capture,
        readSource: () => source
      })
        .then((prepared) => prepared!.beforeInitialStart(p.input))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("SECRET_SENTINEL");
    }
  });
  it.each(["success", "pin", "pin+cleanup"])(
    "preserves %s ordering and errors at the actual provisioner callsite",
    async (which) => {
      const { provisionForUat } = await import("./provisioner.js");
      const saved = { ...process.env };
      cleanups.push(() => {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      });
      vi.stubEnv("JARVIS_UAT_LIFECYCLE_DIR", undefined);
      vi.stubEnv("JARVIS_UAT_LIFECYCLE_NONCE", undefined);
      vi.stubEnv("JARVIS_UAT_BUILD", "0");
      vi.stubEnv("UAT_DOCKER_SUBNET", undefined);
      const config = option();
      const events: string[] = [];
      const before = vi.fn(
        async (input: { envPath: string; recordCreated: () => Promise<void> }) => {
          expect(readFileSync(input.envPath, "utf8")).toContain(
            `MOSS_N3_OBSERVER_NONCE=${config.nonce}`
          );
          await input.recordCreated();
          events.push("verify-before-start");
          if (which !== "success") throw new Error("pin-failed");
        }
      );
      vi.spyOn(options, "prepareN3Observer").mockResolvedValue({
        beforeInitialStart: before,
        checkDeadline: vi.fn()
      });
      mocks.createServer.mockImplementation(() => ({
        once: vi.fn(),
        listen: (_port: number, _host: string, done: () => void) => done(),
        close: (done: () => void) => done()
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, db: "ok", pgboss: "ok" }) }))
      );
      mocks.spawn.mockImplementation((_cmd: string, args: string[]) => ({
        stdout: { on: (_event: string, done: (chunk: Buffer) => void) => done(Buffer.alloc(0)) },
        stderr: { on: vi.fn() },
        on: (event: string, done: (code: number) => void) => {
          if (args.includes("down")) events.push("cleanup");
          if (args.includes("up") && args.includes("jarv1s")) {
            expect(args).toContain("--no-recreate");
            events.push("app-start");
          }
          if (event === "exit") done(which === "pin+cleanup" && args[0] === "ps" ? 1 : 0);
        }
      }));
      const result = await provisionForUat(
        "bare",
        { n3Observer: config, claimedWebPort: 5201 },
        { listLiveSubnets: async () => [], installRealChatAuth: () => undefined }
      ).catch((error: unknown) => error);
      if (which === "success") {
        expect(result).toHaveProperty("teardown");
        expect(events.indexOf("verify-before-start")).toBeLessThan(events.indexOf("app-start"));
        await (result as { teardown: () => Promise<void> }).teardown();
      } else if (which === "pin") expect(String(result)).toContain("pin-failed");
      else {
        expect(result).toBeInstanceOf(AggregateError);
        expect(String((result as AggregateError).errors[0])).toContain("pin-failed");
        expect((result as AggregateError).errors.length).toBeGreaterThan(1);
      }
      expect(before).toHaveBeenCalledTimes(1);
      expect(options.prepareN3Observer).toHaveBeenCalledWith(config, undefined);
      expect(events).toContain("cleanup");
      if (which !== "success") expect(events).not.toContain("app-start");
      expect(() => statSync(process.env.JARVIS_ENV_FILE!)).toThrow();
    }
  );
});
