import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  N3ObserverConsumer,
  initialObserverOption,
  validateProducer,
  validateInstallation,
  NATIVE_BRIDGE,
  OBSERVER_SITES,
  type ExpectedBindings,
  type ProducerSnapshot,
  type InstallationObservation,
  type BridgeEvents,
  type CompletionAttestation,
  type FileIdentity,
  type OwnedBridge,
  type BridgeSpec
} from "./n3-fallback-observer-runner.js";
import { lifecycleFixture } from "./provisioner-lifecycle-fixture.js";
// @ts-expect-error Native fixed bootstrap deliberately ships without source-loader declarations.
import { activateObserver } from "./n3-fallback-observer-bootstrap.mjs";

const forbidden = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  signal: vi.fn(),
  socket: vi.fn(),
  fetch: vi.fn()
}));
vi.mock("node:child_process", () => ({ spawn: forbidden.spawn, execFile: forbidden.execFile }));
vi.mock("node:net", () => ({ createConnection: forbidden.socket, createServer: forbidden.socket }));
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turn = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const bootId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-10-16T23:00:00.000Z";
const stat = (type: FileIdentity["type"], mode: number, inode = 10): FileIdentity => ({
  type,
  mode,
  inode,
  device: 1,
  uid: 1000
});
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(time));
  vi.spyOn(process, "kill").mockImplementation(forbidden.signal);
  vi.stubGlobal("fetch", forbidden.fetch);
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function replace(target: object, path: string | string[], value: unknown) {
  const parts = typeof path === "string" ? path.split(".") : path;
  let node = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object") throw new Error("Invalid mutation path");
    node[part] = structuredClone(next);
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}
function fixture() {
  const source = {
    commit: "3".repeat(40),
    tree: "4".repeat(40),
    inputFingerprint: "5".repeat(64),
    root: { path: "/frozen/source", device: 1, inode: 2 }
  };
  const e = {
    option: initialObserverOption("a".repeat(64), "b".repeat(64), Date.now() + 1000, Date.now()),
    lifecycleNonce: "c".repeat(64),
    channel: stat("directory", 0o700),
    producer: { pid: 100, ppid: 99, startTicks: "1000", bootId },
    producerSha256: "d".repeat(64),
    source,
    daemon: { context: "default", endpoint: "unix:///var/run/docker.sock", daemonId: "owned" },
    attempt: 1,
    project: "uat-123_abcdef01",
    port: 5201,
    compose: [{ path: "/frozen/source/infra/docker-compose.prod.yml", sha256: "e".repeat(64) }],
    containerId: "1".repeat(64),
    imageId: `sha256:${"2".repeat(64)}`,
    imageReference: "ghcr.io/motioneso/moss:uat-unique",
    bundleSha256: "f".repeat(64),
    files: {
      "/app/dist/server.js": "f".repeat(64),
      "/app/tests/uat/n3-fallback-observer-bootstrap.mjs": "b".repeat(64),
      "/app/tests/uat/lifecycle-records.ts": "d".repeat(64),
      "/app/packages/chat/src/live/chat-session-manager.ts": "e".repeat(64)
    },
    volumes: [
      { id: "auth", role: "jarv1s-cli-auth", destination: "/auth" },
      { id: "socket", role: "jarv1s-sports-browser-socket", destination: "/socket" }
    ],
    dbBoundary: { containerId: "db-owned", database: "uat-owned" },
    buildReceiptSha256: "9".repeat(64),
    buildCommand: ["owned-fresh-build"]
  } satisfies ExpectedBindings;
  const api = { pid: 123, startTicks: "12345", bootId, containerId: e.containerId };
  const installation = {
    containerId: e.containerId,
    imageId: e.imageId,
    imageReference: e.imageReference,
    source,
    daemon: { ...e.daemon },
    files: { ...e.files },
    bootstrapSha256: e.option.bootstrapSha256,
    bundleSha256: e.bundleSha256,
    volumes: structuredClone(e.volumes),
    dbBoundary: { ...e.dbBoundary },
    apis: [{ ...api, resolvedEntry: "/app/dist/server.js" }],
    socketDirectory: stat("directory", 0o700, 11),
    socket: stat("socket", 0o600, 12),
    build: {
      command: [...e.buildCommand],
      exitCode: 0,
      rawExitCode: 0,
      completed: true,
      source,
      imageId: e.imageId,
      bundleSha256: e.bundleSha256,
      bootstrapSha256: e.option.bootstrapSha256,
      receiptSha256: "9".repeat(64)
    }
  } satisfies InstallationObservation;
  const app = {
    id: e.containerId,
    name: `/${e.project}-jarv1s-1`,
    created: time,
    labels: {
      "com.docker.compose.project": e.project,
      "com.docker.compose.service": "jarv1s",
      "com.docker.compose.project.working_dir": `${e.source.root.path}/infra`,
      "com.docker.compose.project.config_files": e.compose.map((c) => c.path).join(",")
    },
    role: "jarv1s",
    imageId: e.imageId,
    imageReference: e.imageReference,
    webPorts: [{ hostIp: "127.0.0.1", hostPort: e.port }],
    configuredWebPorts: [{ hostIp: "", hostPort: e.port }]
  };
  const inventory = [
    { kind: "container", metadata: app },
    ...e.volumes.map((v) => ({
      kind: "volume",
      metadata: {
        id: v.id,
        name: v.id,
        created: time,
        labels: { "com.docker.compose.project": e.project, "com.docker.compose.volume": v.role },
        role: v.role,
        driver: "local"
      }
    }))
  ].map(({ kind, metadata }) => ({
    kind,
    id: metadata.id,
    firstSeen: time,
    creation: metadata,
    creationFingerprint: digest({ ...metadata, webPorts: undefined }),
    observation: { state: "present", metadata }
  }));
  const image = {
    tag: "uat-unique",
    reference: e.imageReference,
    id: e.imageId,
    created: time,
    builtAt: time,
    buildFingerprint: source.inputFingerprint,
    initialTagAbsent: true
  };
  const bodies: Record<string, unknown>[] = [
    "attempt-created",
    "image-built",
    "resources-created"
  ].map((phase) => ({
    schema: 1,
    sequence: 0,
    previousDigest: null,
    nonce: e.lifecycleNonce,
    producer: e.producer,
    source,
    daemon: e.daemon,
    phase,
    observedAt: time,
    attempt: {
      number: 1,
      project: e.project,
      port: e.port,
      compose: e.compose,
      start: time,
      end: null,
      failed: false
    },
    image: phase === "attempt-created" ? null : image,
    inventory: phase === "resources-created" ? inventory : [],
    residuals: [],
    errors: [],
    complete: false
  }));
  const producer = (records = bodies): ProducerSnapshot => {
    let previous: string | null = null;
    return {
      channel: e.channel,
      producerSha256: e.producerSha256,
      records: records.map((body, i) => {
        const record = { ...body, sequence: i + 1, previousDigest: previous };
        previous = digest(record);
        return {
          name: `${String(i + 1).padStart(6, "0")}.json`,
          stat: stat("file", 0o600, i + 20),
          raw: JSON.stringify({ ...record, digest: previous }) + "\n"
        };
      })
    };
  };
  return { e, api, installation, producer, bodies, inventory, image };
}
function completion(): CompletionAttestation {
  return {
    actorUserId: actor,
    threadId: thread,
    surface: "drawer",
    turnId: turn,
    complete: true,
    http: { status: 200, finished: true, receiptSha256: "7".repeat(64) },
    ui: { finished: true, receiptSha256: "8".repeat(64) }
  };
}
function harness() {
  const f = fixture();
  let receive: (event: unknown) => void = () => {};
  const server = Object.assign(new EventEmitter(), {
    listen: (_path: string, ready: () => void) => ready(),
    close: vi.fn()
  });
  const io = {
    entry: "/app/dist/server.js",
    now: () => Date.now(),
    realEntry: () => "/app/dist/server.js",
    selfHash: () => f.e.option.bootstrapSha256,
    entryHash: () => f.e.bundleSha256,
    identity: () => f.api,
    sameIdentity: () => true,
    makePrivate: vi.fn(),
    privateTransport: () => true,
    secureSocket: vi.fn(),
    socketPath: () => "/fake/socket",
    encode: JSON.stringify,
    server: () => server,
    subscribe: (fn: (event: unknown) => void) => {
      receive = fn;
      return vi.fn();
    },
    timer: () => ({ unref: vi.fn() }),
    clearTimer: vi.fn(),
    barrierToken: () => thread
  };
  const observer = activateObserver(f.e.option, io);
  cleanups.push(() => observer.close());
  let sequence = 0;
  let currentTurn = turn;
  const event = (fields: Record<string, unknown>) =>
    receive({ version: 1, sequence: ++sequence, ...fields });
  event({ phase: "coverage", sites: OBSERVER_SITES });
  let events: BridgeEvents;
  const specs: BridgeSpec[] = [];
  const requests: Record<string, unknown>[] = [];
  let transform = (reply: Record<string, unknown>) => JSON.stringify(reply) + "\n";
  let deliver = true,
    backpressure = false,
    closeProof = true;
  const birth = { pid: 456, startTicks: "45678", bootId, group: 456, session: 456 };
  const handle: OwnedBridge = {
    birth,
    write: vi.fn((frame: string) => {
      const request = JSON.parse(frame);
      requests.push(request);
      const reply = observer.query(request);
      if (deliver) events.data(Buffer.from(transform(reply)));
      return !backpressure;
    }),
    end: vi.fn(() => {
      if (closeProof) events.closed({ birth, exitCode: 0 });
    })
  };
  const collectors = {
    installation: vi.fn(async (_deadline: number) => f.installation),
    producer: vi.fn(async (_deadline: number) => f.producer()),
    bridge: vi.fn((spec: BridgeSpec, callbacks: BridgeEvents) => {
      specs.push(spec);
      events = callbacks;
      return handle;
    })
  };
  const consumer = new N3ObserverConsumer(f.e, collectors);
  const entry = (site = "turn", turnId = currentTurn) => {
    const attemptId = sequence + 1;
    event({
      phase: "entry",
      site,
      attemptId,
      actorUserId: actor,
      surface: "drawer",
      turnId,
      threadId: site === "turn" ? null : thread,
      aborted: false
    });
    return attemptId;
  };
  const bind = (threadId = thread) =>
    event({
      phase: "context",
      actorUserId: actor,
      surface: "drawer",
      turnId: currentTurn,
      threadId
    });
  const settle = (attemptId: number, site = "turn", turnId = currentTurn) =>
    event({
      phase: "settle",
      site,
      attemptId,
      actorUserId: actor,
      surface: "drawer",
      turnId,
      threadId: thread,
      outcome: "ok",
      aborted: false
    });
  const turnDone = () => {
    const id = entry();
    bind();
    settle(id);
  };
  return {
    ...f,
    setTurn: (id: string) => {
      currentTurn = id;
    },
    observer,
    consumer,
    collectors,
    specs,
    requests,
    handle,
    entry,
    bind,
    settle,
    turnDone,
    event,
    io,
    get events() {
      return events;
    },
    transform: (fn: typeof transform) => {
      transform = fn;
    },
    delivery: (value: boolean) => {
      deliver = value;
    },
    backpressure: () => {
      backpressure = true;
    },
    noCloseProof: () => {
      closeProof = false;
    }
  };
}

async function openWindow(mode: "terminal" | "positive" = "terminal") {
  const h = harness();
  await h.consumer.open();
  await h.consumer.beginWindow(actor, thread, mode);
  return h;
}

describe("inert receipt boundaries", () => {
  it("constructs only the four initial provisioning fields", () => {
    const f = fixture();
    expect(Object.keys(f.e.option)).toEqual(["nonce", "bootstrapSha256", "schema", "deadline"]);
    expect(() =>
      initialObserverOption("short", f.e.option.bootstrapSha256, Date.now() + 1, Date.now())
    ).toThrow();
    expect(() =>
      initialObserverOption(f.e.option.nonce, f.e.option.bootstrapSha256, Date.now(), Date.now())
    ).toThrow();
    new N3ObserverConsumer(f.e, { installation: vi.fn(), producer: vi.fn(), bridge: vi.fn() });
  });
  it("accepts independent source/image/file/API/DB receipts without certifying their collection", () => {
    const f = fixture();
    expect(validateInstallation(f.e, f.installation)).toEqual(f.api);
    expect(validateProducer(f.e, f.producer()).digests).toHaveLength(3);
  });
  const installationMutations: [string, unknown][] = [
    ["containerId", "0".repeat(64)],
    ["imageId", `sha256:${"0".repeat(64)}`],
    ["imageReference", "relabelled"],
    ["source.commit", "0".repeat(40)],
    ["source.tree", "0".repeat(40)],
    ["source.inputFingerprint", "0".repeat(64)],
    ["source.root.inode", 999],
    ["daemon.daemonId", "other"],
    ["daemon.context", "other"],
    ["daemon.endpoint", "unix:///other"],
    ["bundleSha256", "0".repeat(64)],
    ["bootstrapSha256", "0".repeat(64)],
    ["volumes.0.id", "other-auth"],
    ["volumes.1.destination", "/other"],
    ["volumes.1.role", "other"],
    ["dbBoundary.database", "other"],
    ["apis", []],
    ["apis.0.resolvedEntry", "/other.js"],
    ["apis.0.containerId", "0".repeat(64)],
    ["apis.0.startTicks", "bad"],
    ["apis.0.bootId", "bad"],
    ["socket.mode", 0o666],
    ["socketDirectory.mode", 0o755],
    ["socket.uid", 999],
    ["build.exitCode", 1],
    ["build.rawExitCode", 1],
    ["build.completed", false],
    ["build.command", ["unowned-build"]],
    ["build.source.tree", "0".repeat(40)],
    ["build.imageId", `sha256:${"0".repeat(64)}`],
    ["build.bundleSha256", "0".repeat(64)],
    ["build.bootstrapSha256", "0".repeat(64)],
    ["build.receiptSha256", ""]
  ];
  it.each(installationMutations)("rejects installation %s mismatch", (path, value) => {
    const f = fixture();
    replace(f.installation, path, value);
    expect(() => validateInstallation(f.e, f.installation)).toThrow();
  });
  it.each(Object.keys(fixture().e.files))("rejects writable-layer substitution at %s", (path) => {
    const f = fixture();
    replace(f.installation.files, [path], "0".repeat(64));
    expect(() => validateInstallation(f.e, f.installation)).toThrow();
  });
  it("rejects duplicate API", () => {
    const f = fixture();
    f.installation.apis.push({ ...f.installation.apis[0]! });
    expect(() => validateInstallation(f.e, f.installation)).toThrow();
  });
  const recordMutations: [string, unknown][] = [
    ["schema", 2],
    ["nonce", "0".repeat(64)],
    ["producer.pid", 999],
    ["producer.startTicks", "999"],
    ["producer.bootId", actor],
    ["source.tree", "0".repeat(40)],
    ["daemon.daemonId", "other"],
    ["attempt.project", "other"],
    ["attempt.number", 2],
    ["attempt.port", 5298],
    ["attempt.compose", []],
    ["attempt.failed", true],
    ["phase", "image-built"],
    ["errors", ["inspection-failed"]],
    ["residuals", [{ kind: "volume", id: "other" }]],
    ["complete", true],
    ["inventory", []],
    ["image.id", `sha256:${"0".repeat(64)}`],
    ["image.initialTagAbsent", false],
    ["image.buildFingerprint", "0".repeat(64)],
    ["inventory.0.creation.labels", { "com.docker.compose.project": "other" }]
  ];
  it.each(recordMutations)("rejects authentic chained %s failure", (path, value) => {
    const f = fixture();
    // Detach the untrusted observation from authoritative pins before mutation.
    const bodies = structuredClone(f.bodies);
    replace(bodies[2]!, path, value);
    expect(() => validateProducer(f.e, f.producer(bodies))).toThrow();
  });
  it.each([
    "lost",
    "reordered",
    "duplicate",
    "digest",
    "previous",
    "name",
    "mode",
    "channel",
    "producer bytes"
  ])("rejects %s producer receipt", (kind) => {
    const f = fixture(),
      s = structuredClone(f.producer());
    const records = [...s.records];
    if (kind === "lost") records.splice(1, 1);
    if (kind === "reordered") [records[0], records[1]] = [records[1]!, records[0]!];
    if (kind === "duplicate") records.push(records[2]!);
    if (kind === "previous")
      records[1] = {
        ...records[1]!,
        raw: records[1]!.raw.replace('"previousDigest":"', '"previousDigest":"0')
      };
    if (kind === "name") records[1] = { ...records[1]!, name: "000099.json" };
    if (kind === "mode") records[1] = { ...records[1]!, stat: stat("file", 0o644) };
    if (kind === "digest")
      records[2] = {
        ...s.records[2]!,
        raw: s.records[2]!.raw.replace(
          /"digest":"[a-f0-9]{64}"/,
          '"digest":"' + "0".repeat(64) + '"'
        )
      };
    const snapshot = {
      ...s,
      records,
      channel: kind === "channel" ? { ...s.channel, inode: 999 } : s.channel,
      producerSha256: kind === "producer bytes" ? "0".repeat(64) : s.producerSha256
    };
    expect(() => validateProducer(f.e, snapshot)).toThrow();
  });
  it("requires terminal complete absence independently of bridge closure", () => {
    const f = fixture();
    expect(() => validateProducer(f.e, f.producer(), true)).toThrow();
    for (const phase of ["before-teardown", "after-teardown"])
      f.bodies.push({
        ...f.bodies[2],
        phase,
        attempt: { ...(f.bodies[2]!.attempt as object), end: time },
        complete: phase === "after-teardown",
        inventory:
          phase === "before-teardown"
            ? f.inventory
            : f.inventory.map((entry) => ({ ...entry, observation: { state: "absent" } }))
      });
    expect(validateProducer(f.e, f.producer(), true).digests).toHaveLength(5);
    f.bodies[4]!.complete = false;
    expect(() => validateProducer(f.e, f.producer(), true)).toThrow();
  });
});

describe("persistent version1 consumer composed with actual O2a", () => {
  it("uses one exact native bridge and three cumulative windows with measured positive deltas", async () => {
    const h = harness();
    await h.consumer.open();
    for (const [index, mode] of (["terminal", "terminal", "positive"] as const).entries()) {
      const turnId = [turn, actor, thread][index]!;
      h.setTurn(turnId);
      await h.consumer.beginWindow(actor, thread, mode);
      const id = h.entry();
      h.bind();
      if (mode === "positive") {
        const shadow = h.entry("shadow.start"),
          run = h.entry("shadow.run");
        h.settle(shadow, "shadow.start");
        h.settle(run, "shadow.run");
      }
      h.settle(id);
      const result = await h.consumer.finishWindow({ ...completion(), turnId });
      expect(result.delta.turn).toBe(1);
      expect(result.delta["shadow.run"]).toBe(mode === "positive" ? 1 : 0);
    }
    expect(h.collectors.bridge).toHaveBeenCalledTimes(1);
    expect(h.specs[0]).toEqual({
      command: "docker",
      daemon: h.e.daemon,
      deadline: h.e.option.deadline,
      args: [
        "exec",
        "-i",
        h.e.containerId,
        "node",
        "-e",
        NATIVE_BRIDGE,
        `/run/jarv1s/n3-${h.e.option.nonce}/observer.sock`,
        String(h.e.option.deadline)
      ]
    });
    expect(h.requests.map((r) => r.requestId)).toEqual(h.requests.map((_, i) => i + 1));
    expect((await h.consumer.status()).completedWindows).toBe(3);
    expect(await h.consumer.close()).toEqual({ disposed: true, retained: undefined });
    expect(h.handle.end).toHaveBeenCalledTimes(1);
    expect(h.collectors.installation.mock.calls.every(([d]) => d === h.e.option.deadline)).toBe(
      true
    );
    expect(h.collectors.producer.mock.calls.every(([d]) => d === h.e.option.deadline)).toBe(true);
  });
  it("waits for actual detached heal and shadow settlement after the turn ends", async () => {
    const h = await openWindow("positive");
    const id = h.entry();
    h.bind();
    const heal = h.entry("heal"),
      shadow = h.entry("shadow.run");
    h.settle(id);
    let done = false;
    const result = h.consumer.finishWindow(completion()).then((value) => {
      done = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe(false);
    expect(h.requests.some((r) => r.op === "barrier")).toBe(false);
    h.settle(heal, "heal");
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe(false);
    h.settle(shadow, "shadow.run");
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).delta.heal).toBe(1);
    expect(done).toBe(true);
  });
  it.each([
    "pid",
    "startTicks",
    "bootId",
    "socket inode",
    "directory inode",
    "file drift",
    "record replacement"
  ])("rejects %s drift at later boundaries", async (kind) => {
    const h = harness();
    await h.consumer.open();
    if (kind === "pid") h.installation.apis[0]!.pid++;
    if (kind === "startTicks") h.installation.apis[0]!.startTicks += "1";
    if (kind === "bootId") h.installation.apis[0]!.bootId = actor;
    if (kind === "socket inode") h.installation.socket = { ...h.installation.socket, inode: 999 };
    if (kind === "directory inode")
      h.installation.socketDirectory = { ...h.installation.socketDirectory, inode: 999 };
    if (kind === "file drift") h.installation.files["/app/dist/server.js"] = "0".repeat(64);
    if (kind === "record replacement") h.bodies[0]!.observedAt = "2026-10-16T23:00:01.000Z";
    await expect(h.consumer.status()).rejects.toThrow("RED");
    expect(h.consumer.failed).toBe(true);
    expect(h.consumer.retainedBridge).toBe(h.handle);
  });
  it.each([
    "wrong owner",
    "wrong thread",
    "wrong turn",
    "no turn",
    "unfinished UI",
    "unfinished HTTP",
    "HTTP failure",
    "no receipt",
    "thread event"
  ])("rejects %s completion", async (kind) => {
    const h = await openWindow();
    if (kind === "thread event") {
      const id = h.entry();
      h.bind(actor);
      h.settle(id);
    } else if (kind !== "no turn") h.turnDone();
    const attestation = structuredClone(completion());
    const changed = {
      ...attestation,
      actorUserId: kind === "wrong owner" ? thread : actor,
      threadId: kind === "wrong thread" ? actor : thread,
      turnId: kind === "wrong turn" ? actor : turn,
      http: {
        ...attestation.http,
        status: kind === "HTTP failure" ? 500 : 200,
        finished: kind !== "unfinished HTTP",
        receiptSha256: kind === "no receipt" ? "" : attestation.http.receiptSha256
      },
      ui: { ...attestation.ui, finished: kind !== "unfinished UI" }
    };
    await expect(h.consumer.finishWindow(changed as CompletionAttestation)).rejects.toThrow("RED");
    expect(h.consumer.failed).toBe(true);
  });
  it("rejects terminal non-turn deltas even when all descendants settle", async () => {
    const h = await openWindow();
    const id = h.entry();
    h.bind();
    const launch = h.entry("launch");
    h.settle(launch, "launch");
    h.settle(id);
    await expect(h.consumer.finishWindow(completion())).rejects.toThrow("RED");
  });
  it("rejects barrier invalidation between acknowledgement and end", async () => {
    const h = await openWindow();
    h.turnDone();
    h.transform((reply) => {
      if (reply.barrier) h.event({ phase: "coverage", sites: OBSERVER_SITES });
      return JSON.stringify(reply) + "\n";
    });
    await expect(h.consumer.finishWindow(completion())).rejects.toThrow("RED");
  });
  it.each([
    "extra",
    "parse",
    "oversized",
    "error",
    "unready",
    "coverage",
    "counter",
    "sequence",
    "pins",
    "identity",
    "reply ID"
  ])("makes %s response failure sticky", async (kind) => {
    const h = harness();
    await h.consumer.open();
    h.transform((reply) => {
      if (kind === "extra") return JSON.stringify(reply) + "\n{}\n";
      if (kind === "parse") return "{broken\n";
      if (kind === "oversized") return JSON.stringify(reply) + " ".repeat(4096) + "\n";
      if (kind === "error") reply.error = "bad";
      if (kind === "unready") reply.ready = false;
      if (kind === "coverage") reply.coverage = ["turn"];
      if (kind === "counter") reply.attempts = -1;
      if (kind === "sequence") reply.sequence = 0;
      if (kind === "pins")
        reply.pins = { bootstrapSha256: "0".repeat(64), bundleSha256: h.e.bundleSha256 };
      if (kind === "identity") reply.identity = { ...h.api, pid: 999 };
      if (kind === "reply ID") reply.requestId = 1;
      return JSON.stringify(reply) + "\n";
    });
    await expect(h.consumer.status()).rejects.toThrow("RED");
    h.transform((reply) => JSON.stringify(reply) + "\n");
    await expect(h.consumer.status()).rejects.toThrow("RED");
    expect(h.collectors.bridge).toHaveBeenCalledTimes(1);
  });
  it("preserves counters across windows and rejects rollback after a completed turn", async () => {
    const h = await openWindow();
    h.turnDone();
    await h.consumer.finishWindow(completion());
    h.transform((reply) => {
      reply.counters = Object.fromEntries(OBSERVER_SITES.map((s) => [s, 0]));
      reply.attempts = 0;
      return JSON.stringify(reply) + "\n";
    });
    await expect(h.consumer.status()).rejects.toThrow("RED");
  });
  it("accepts fragmented single frames and rejects unsolicited replies", async () => {
    const h = harness();
    await h.consumer.open();
    h.transform((reply) => {
      const raw = JSON.stringify(reply) + "\n";
      h.events.data(Buffer.from(raw.slice(0, 20)));
      return raw.slice(20);
    });
    await h.consumer.status();
    h.events.data(Buffer.from("{}\n"));
    expect(h.consumer.failed).toBe(true);
    await expect(h.consumer.status()).rejects.toThrow("RED");
  });
  it.each(["failure", "disconnect", "backpressure", "concurrent", "reopen"])(
    "retains the owned bridge after %s",
    async (kind) => {
      const h = harness();
      await h.consumer.open();
      if (kind === "failure") h.events.failure();
      if (kind === "disconnect") h.events.closed({ birth: h.handle.birth, exitCode: 1 });
      if (kind === "backpressure") {
        h.backpressure();
        await expect(h.consumer.status()).rejects.toThrow();
      }
      if (kind === "concurrent") {
        const p = h.consumer.status();
        await expect(h.consumer.status()).rejects.toThrow();
        await expect(p).rejects.toThrow();
      }
      if (kind === "reopen") await expect(h.consumer.open()).rejects.toThrow();
      expect(h.consumer.failed).toBe(true);
      expect(h.consumer.retainedBridge).toBe(h.handle);
    }
  );
  it("has one absolute deadline across status, windows, collector waits and close", async () => {
    const h = await openWindow();
    h.turnDone();
    await h.consumer.finishWindow(completion());
    await vi.advanceTimersByTimeAsync(990);
    h.delivery(false);
    const result = h.consumer.status();
    const assertion = expect(result).rejects.toThrow("RED");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(await h.consumer.close()).toEqual({ disposed: false, retained: h.handle });
    expect(h.handle.end).not.toHaveBeenCalled();
  });
  it("expires an unsettled descendant without issuing a barrier", async () => {
    const h = await openWindow("positive");
    const id = h.entry();
    h.bind();
    h.entry("heal");
    h.settle(id);
    const result = h.consumer.finishWindow(completion());
    const assertion = expect(result).rejects.toThrow("RED");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(h.requests.some((r) => r.op === "barrier")).toBe(false);
  });
  it("does not spawn after an expired collector eventually resolves", async () => {
    const h = harness();
    let resolve: (s: ProducerSnapshot) => void = () => {};
    h.collectors.producer.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const result = h.consumer.open();
    const assertion = expect(result).rejects.toThrow("RED");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    resolve(h.producer());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.collectors.bridge).not.toHaveBeenCalled();
  });
  it.each(["receipt", "handle"])("keeps close uncertainty for changed %s birth", async (kind) => {
    const h = harness();
    await h.consumer.open();
    h.noCloseProof();
    const close = h.consumer.close();
    if (kind === "handle") Object.assign(h.handle.birth, { startTicks: "999" });
    h.events.closed({ birth: { ...h.handle.birth, startTicks: "999" }, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await close).toEqual({ disposed: false, retained: h.handle });
    expect(h.consumer.failed).toBe(true);
  });
  it("scrubs collector and spawn errors without retrying or claiming cleanup", async () => {
    const h = harness();
    h.collectors.bridge.mockImplementation(() => {
      throw new Error("SECRET_SENTINEL");
    });
    await expect(h.consumer.open()).rejects.toThrow(/^N3 consumer: RED$/);
    expect(h.consumer.failed).toBe(true);
    expect(h.collectors.bridge).toHaveBeenCalledTimes(1);
    expect(await h.consumer.close()).toEqual({ disposed: false, retained: undefined });
  });
});

describe("accepted producer and native bridge compatibility", () => {
  it("scrubs malformed private producer JSON", () => {
    const f = fixture(),
      snapshot = f.producer(),
      records = [...snapshot.records];
    records[0] = { ...records[0]!, raw: "SECRET_SENTINEL invalid JSON" };
    expect(() => validateProducer(f.e, { ...snapshot, records })).toThrow(
      /^N3 consumer: invalid JSON$/
    );
  });
  it("consumes actual P records produced with its injected fake Docker capture", async () => {
    const f = lifecycleFixture();
    cleanups.push(f.dispose);
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.appPresent = true;
    f.state.volumesPresent = true;
    await record("resources-created", f.attempt);
    const expected = fixture().e;
    const rootStat = lstatSync(f.root);
    const buildFiles = ["Dockerfile", ".dockerignore"].map((path) => ({
      path: join(f.root, path),
      sha256: hash(readFileSync(join(f.root, path)))
    }));
    const source = {
      commit: "3".repeat(40),
      tree: "4".repeat(40),
      root: {
        path: f.root,
        device: rootStat.dev,
        inode: rootStat.ino
      },
      inputFingerprint: digest({
        commit: "3".repeat(40),
        tree: "4".repeat(40),
        buildFiles
      })
    };
    const proc = readFileSync("/proc/self/stat", "utf8");
    const producer = {
      pid: process.pid,
      ppid: process.ppid,
      startTicks: proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19]!,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    };
    const fileStat = (path: string, type: FileIdentity["type"]): FileIdentity => {
      const s = lstatSync(path);
      return { type, device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 0o777 };
    };
    const channel = fileStat(f.dir, "directory");
    const e: ExpectedBindings = {
      ...expected,
      source,
      producer,
      channel,
      lifecycleNonce: f.env.JARVIS_UAT_LIFECYCLE_NONCE,
      containerId: f.id,
      imageId: f.imageId,
      imageReference: f.reference,
      daemon: {
        context: "default",
        endpoint: "unix:///var/run/docker.sock",
        daemonId: f.state.daemon
      },
      compose: ["infra/docker-compose.prod.yml", "tests/uat/compose.override.yml"].map((p) => ({
        path: join(f.root, p),
        sha256: hash(readFileSync(join(f.root, p)))
      })),
      volumes: f.volumes.slice(0, 2).map((v, i) => ({
        id: v.id,
        role: v.labels["com.docker.compose.volume"],
        destination: expected.volumes[i]!.destination
      }))
    };
    const snapshot: ProducerSnapshot = {
      channel,
      producerSha256: e.producerSha256,
      records: readdirSync(f.dir)
        .sort()
        .map((name) => ({
          name,
          stat: fileStat(join(f.dir, name), "file"),
          raw: readFileSync(join(f.dir, name), "utf8")
        }))
    };
    expect(validateProducer(e, snapshot).digests).toHaveLength(3);
  });
  function bridgeVm() {
    const stdin = Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn()
    });
    const stdout = Object.assign(new EventEmitter(), { write: vi.fn(() => true) });
    const socket = Object.assign(new EventEmitter(), {
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn()
    });
    const proc = {
      argv: ["node", "/run/jarv1s/n3-fixed/observer.sock", String(Date.now() + 100)],
      stdin,
      stdout,
      exitCode: 0
    };
    const connect = vi.fn(() => socket),
      timer = vi.fn(),
      clear = vi.fn();
    runInNewContext(NATIVE_BRIDGE, {
      require: (name: string) => {
        expect(name).toBe("node:net");
        return { createConnection: connect };
      },
      process: proc,
      Date,
      Math,
      Number,
      setTimeout: timer,
      clearTimeout: clear
    });
    return { stdin, stdout, socket, proc, connect, timer, clear };
  }
  it("relays one persistent fake socket and closes only its own bridge", () => {
    const h = bridgeVm();
    h.socket.emit("connect");
    h.stdin.emit("data", Buffer.from("{}\n"));
    h.socket.emit("data", Buffer.from("{}\n"));
    expect(h.socket.write).toHaveBeenCalledWith(Buffer.from("{}\n"));
    expect(h.stdout.write).toHaveBeenCalledWith(Buffer.from("{}\n"));
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.stdin.emit("end");
    h.socket.emit("close");
    expect(h.proc.exitCode).toBe(0);
    expect(h.clear).toHaveBeenCalledTimes(1);
  });
  it.each(["input overflow", "output overflow", "socket loss", "backpressure", "deadline"])(
    "native bridge rejects %s without reconnect",
    (kind) => {
      const h = bridgeVm();
      if (kind === "input overflow") h.stdin.emit("data", Buffer.alloc(4097, 65));
      if (kind === "output overflow") h.socket.emit("data", Buffer.alloc(4097, 65));
      if (kind === "socket loss") h.socket.emit("close");
      if (kind === "backpressure") {
        h.socket.write.mockReturnValue(false);
        h.stdin.emit("data", Buffer.from("{}\n"));
      }
      if (kind === "deadline") h.timer.mock.calls[0]![0]();
      expect(h.proc.exitCode).toBe(1);
      expect(h.connect).toHaveBeenCalledTimes(1);
    }
  );
});
