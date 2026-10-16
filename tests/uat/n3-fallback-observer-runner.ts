import { createHash } from "node:crypto";
import type { N3ObserverOption } from "./provisioner-options.js";

export const OBSERVER_SITES = [
  "turn",
  "ensure.initial",
  "ensure.retry",
  "heal",
  "factory",
  "launch",
  "replay.submit",
  "submit.initial",
  "submit.retry",
  "classifier.evaluate",
  "shadow.start",
  "shadow.run"
] as const;
type Site = (typeof OBSERVER_SITES)[number];
type JsonObject = Record<string, unknown>;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`N3 consumer: ${code}`);
}
function object(value: unknown): JsonObject {
  check(value && Object.getPrototypeOf(value) === Object.prototype, "object");
  return value as JsonObject;
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = object(a),
      right = object(b);
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
};
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
function keys(value: JsonObject, names: readonly string[]) {
  check(
    Object.keys(value).length === names.length && names.every((k) => Object.hasOwn(value, k)),
    "keys"
  );
}
function parseFrame(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("N3 consumer: invalid JSON");
  }
}
export interface ApiIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
  readonly containerId: string;
}
export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly uid: number;
  readonly mode: number;
  readonly type: "directory" | "file" | "socket";
}
export interface SourceFreeze {
  readonly commit: string;
  readonly tree: string;
  readonly inputFingerprint: string;
  readonly root: { readonly path: string; readonly device: number; readonly inode: number };
}
export interface VolumeBinding {
  readonly id: string;
  readonly destination: string;
  readonly role: string;
}
export interface ExpectedBindings {
  readonly option: N3ObserverOption;
  readonly lifecycleNonce: string;
  readonly channel: FileIdentity;
  readonly producer: Omit<ApiIdentity, "containerId"> & { readonly ppid: number };
  readonly producerSha256: string;
  readonly source: SourceFreeze;
  readonly daemon: {
    readonly context: string;
    readonly endpoint: string;
    readonly daemonId: string;
  };
  readonly attempt: number;
  readonly project: string;
  readonly port: number;
  readonly compose: readonly { readonly path: string; readonly sha256: string }[];
  readonly containerId: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly bundleSha256: string;
  /** Entire reviewed executable/source union, including product source and producer. */
  readonly files: Readonly<Record<string, string>>;
  readonly volumes: readonly VolumeBinding[];
  readonly dbBoundary: Readonly<Record<string, string>>;
  /** Exact owned fresh-build command, retained with its independent raw-exit receipt. */
  readonly buildCommand: readonly string[];
  readonly buildReceiptSha256: string;
}
export interface ProducerSnapshot {
  readonly channel: FileIdentity;
  readonly producerSha256: string;
  readonly records: readonly {
    readonly name: string;
    readonly stat: FileIdentity;
    readonly raw: string;
  }[];
}
export interface InstallationObservation {
  readonly containerId: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly source: SourceFreeze;
  readonly daemon: ExpectedBindings["daemon"];
  readonly files: Readonly<Record<string, string>>;
  readonly bootstrapSha256: string;
  readonly bundleSha256: string;
  readonly volumes: readonly VolumeBinding[];
  readonly dbBoundary: Readonly<Record<string, string>>;
  readonly apis: readonly (ApiIdentity & { readonly resolvedEntry: string })[];
  readonly socketDirectory: FileIdentity;
  readonly socket: FileIdentity;
  readonly build: {
    readonly command: readonly string[];
    readonly exitCode: number;
    readonly rawExitCode: number;
    readonly completed: boolean;
    readonly source: SourceFreeze;
    readonly imageId: string;
    readonly bundleSha256: string;
    readonly bootstrapSha256: string;
    readonly receiptSha256: string;
  };
}
/** Only construction; no provisioner import or process activation. */
export function initialObserverOption(
  nonce: string,
  bootstrapSha256: string,
  deadline: number,
  now: number
): N3ObserverOption {
  check(
    hex.test(nonce) &&
      hex.test(bootstrapSha256) &&
      Number.isSafeInteger(deadline) &&
      deadline > now,
    "option"
  );
  return Object.freeze({ nonce, bootstrapSha256, schema: 1, deadline });
}
function identity(value: ApiIdentity) {
  check(
    natural(value.pid) &&
      value.pid > 0 &&
      /^[0-9]{1,24}$/.test(value.startTicks) &&
      uuid.test(value.bootId) &&
      hex.test(value.containerId),
    "api-identity"
  );
}
function privateFile(stat: FileIdentity, type: FileIdentity["type"], mode: number, uid: number) {
  check(
    stat.type === type &&
      stat.mode === mode &&
      stat.uid === uid &&
      natural(stat.device) &&
      natural(stat.inode) &&
      stat.inode > 0,
    "private-channel"
  );
}
function validateExpected(e: ExpectedBindings, now: number) {
  check(
    equal(
      initialObserverOption(e.option.nonce, e.option.bootstrapSha256, e.option.deadline, now),
      e.option
    ),
    "option"
  );
  check(
    /^[a-zA-Z0-9_-]{32,128}$/.test(e.lifecycleNonce) &&
      hex.test(e.producerSha256) &&
      hex.test(e.bundleSha256) &&
      hex.test(e.containerId) &&
      /^sha256:[a-f0-9]{64}$/.test(e.imageId),
    "pins"
  );
  check(
    /^[a-f0-9]{40}$/.test(e.source.commit) &&
      /^[a-f0-9]{40}$/.test(e.source.tree) &&
      hex.test(e.source.inputFingerprint) &&
      natural(e.attempt) &&
      e.attempt > 0 &&
      e.port >= 5180 &&
      e.port <= 5299 &&
      e.project.length > 0,
    "source"
  );
  check(
    e.files["/app/dist/server.js"] === e.bundleSha256 &&
      e.files["/app/tests/uat/n3-fallback-observer-bootstrap.mjs"] === e.option.bootstrapSha256 &&
      e.files["/app/tests/uat/lifecycle-records.ts"] === e.producerSha256 &&
      Object.values(e.files).every((v) => hex.test(v)),
    "source-files"
  );
  check(
    e.volumes.length >= 2 &&
      new Set(e.volumes.map((v) => v.id)).size === e.volumes.length &&
      new Set(e.volumes.map((v) => v.destination)).size === e.volumes.length &&
      e.volumes.some((v) => v.role === "jarv1s-cli-auth") &&
      e.volumes.some((v) => v.role === "jarv1s-sports-browser-socket") &&
      Object.keys(e.dbBoundary).length > 0 &&
      e.buildCommand.length > 0 &&
      hex.test(e.buildReceiptSha256),
    "installation-pins"
  );
  privateFile(e.channel, "directory", 0o700, e.channel.uid);
}
/** Validate the original producer bytes in original JSON property order; never rewrite records. */
export function validateProducer(
  e: ExpectedBindings,
  snapshot: ProducerSnapshot,
  terminal = false
): { readonly digests: readonly string[]; readonly raw: readonly string[] } {
  check(
    equal(snapshot.channel, e.channel) && snapshot.producerSha256 === e.producerSha256,
    "producer-channel"
  );
  check(snapshot.records.length >= 3 && snapshot.records.length <= 4096, "producer-count");
  let previous: string | null = null;
  let phase = "",
    start: unknown,
    image: unknown;
  const inventory = new Map<string, unknown>();
  const digests: string[] = [];
  const raw: string[] = [];
  for (const [index, file] of snapshot.records.entries()) {
    privateFile(file.stat, "file", 0o600, e.channel.uid);
    check(
      file.name === `${String(index + 1).padStart(6, "0")}.json` &&
        Buffer.byteLength(file.raw) <= 256 * 1024,
      "producer-file"
    );
    const r = object(parseFrame(file.raw));
    keys(r, [
      "schema",
      "sequence",
      "previousDigest",
      "nonce",
      "producer",
      "source",
      "daemon",
      "phase",
      "observedAt",
      "attempt",
      "image",
      "inventory",
      "residuals",
      "errors",
      "complete",
      "digest"
    ]);
    const { digest: actual, ...body } = r;
    check(
      actual === digest(body) && r.previousDigest === previous && r.sequence === index + 1,
      "producer-chain"
    );
    // Producer identity has no containerId: it is a host producer, never an API namespace PID.
    const producer = e.producer;
    check(
      r.schema === 1 &&
        r.nonce === e.lifecycleNonce &&
        equal(r.producer, producer) &&
        equal(r.source, e.source) &&
        equal(r.daemon, e.daemon),
      "producer-binding"
    );
    const a = object(r.attempt);
    keys(a, ["number", "project", "port", "compose", "start", "end", "failed"]);
    check(
      a.number === e.attempt &&
        a.project === e.project &&
        a.port === e.port &&
        equal(a.compose, e.compose) &&
        a.failed === false &&
        typeof a.start === "string" &&
        Number.isFinite(Date.parse(a.start)),
      "producer-attempt"
    );
    if (index === 0) start = a.start;
    check(
      a.start === start &&
        typeof r.observedAt === "string" &&
        Number.isFinite(Date.parse(r.observedAt)) &&
        equal(r.errors, []) &&
        equal(r.residuals, []),
      "producer-incomplete"
    );
    const next = r.phase;
    check(
      (index === 0 && next === "attempt-created") ||
        (phase === "attempt-created" && next === "image-built") ||
        (["image-built", "resources-created"].includes(phase) && next === "resources-created") ||
        (phase === "resources-created" && next === "before-teardown") ||
        (phase === "before-teardown" && next === "after-teardown"),
      "producer-phase"
    );
    check(
      r.complete === (next === "after-teardown") &&
        (["before-teardown", "after-teardown"].includes(String(next))
          ? typeof a.end === "string" && Number.isFinite(Date.parse(a.end))
          : a.end === null),
      "producer-completeness"
    );
    if (next === "attempt-created") check(r.image === null, "producer-image");
    else {
      const im = object(r.image);
      keys(im, [
        "tag",
        "reference",
        "id",
        "created",
        "builtAt",
        "buildFingerprint",
        "initialTagAbsent"
      ]);
      check(
        im.id === e.imageId &&
          im.reference === e.imageReference &&
          e.imageReference === `ghcr.io/motioneso/moss:${String(im.tag)}` &&
          im.buildFingerprint === e.source.inputFingerprint &&
          im.initialTagAbsent === true &&
          typeof im.created === "string" &&
          Number.isFinite(Date.parse(im.created)) &&
          typeof im.builtAt === "string" &&
          Number.isFinite(Date.parse(im.builtAt)),
        "producer-image"
      );
      if (image) check(equal(image, im), "producer-image-drift");
      image = im;
    }
    check(Array.isArray(r.inventory) && r.inventory.length <= 256, "producer-inventory");
    const seen = new Set<string>();
    for (const item of r.inventory) {
      const entry = object(item),
        creation = object(entry.creation),
        observation = object(entry.observation);
      keys(entry, ["kind", "id", "firstSeen", "creation", "creationFingerprint", "observation"]);
      const key = `${String(entry.kind)}:${String(entry.id)}`;
      check(
        !seen.has(key) &&
          ["container", "volume", "network"].includes(String(entry.kind)) &&
          entry.id === creation.id &&
          entry.creationFingerprint === digest({ ...creation, webPorts: undefined }),
        "producer-resource"
      );
      seen.add(key);
      const labels = object(creation.labels);
      check(
        labels["com.docker.compose.project"] === e.project &&
          (entry.kind === "container"
            ? labels["com.docker.compose.service"] === creation.role &&
              labels["com.docker.compose.project.working_dir"] === `${e.source.root.path}/infra` &&
              labels["com.docker.compose.project.config_files"] ===
                e.compose.map((c) => c.path).join(",")
            : labels[`com.docker.compose.${String(entry.kind)}`] === creation.role),
        "producer-label"
      );
      if (inventory.has(key)) check(equal(inventory.get(key), creation), "producer-resource-drift");
      inventory.set(key, creation);
      check(
        next === "after-teardown"
          ? equal(observation, { state: "absent" })
          : observation.state === "present" &&
              equal(
                { ...object(observation.metadata), webPorts: undefined },
                { ...creation, webPorts: undefined }
              ),
        "producer-observation"
      );
      if (creation.role === "jarv1s" && entry.kind === "container")
        check(
          creation.id === e.containerId &&
            creation.imageId === e.imageId &&
            creation.imageReference === e.imageReference &&
            Array.isArray(creation.configuredWebPorts) &&
            creation.configuredWebPorts.length > 0 &&
            creation.configuredWebPorts.every((p) => object(p).hostPort === e.port),
          "producer-container"
        );
    }
    check(
      [...inventory.keys()].every((key) => seen.has(key)),
      "producer-resource-missing"
    );
    phase = String(next);
    previous = String(actual);
    digests.push(previous);
    raw.push(file.raw);
  }
  check(terminal ? phase === "after-teardown" : phase === "resources-created", "producer-boundary");
  check(
    inventory.has(`container:${e.containerId}`) &&
      e.volumes.every((v) => object(inventory.get(`volume:${v.id}`)).role === v.role),
    "producer-first-start"
  );
  return { digests, raw };
}
export function validateInstallation(e: ExpectedBindings, o: InstallationObservation): ApiIdentity {
  check(
    o.containerId === e.containerId &&
      o.imageId === e.imageId &&
      o.imageReference === e.imageReference &&
      equal(o.source, e.source) &&
      equal(o.daemon, e.daemon) &&
      equal(o.files, e.files) &&
      o.bootstrapSha256 === e.option.bootstrapSha256 &&
      o.bundleSha256 === e.bundleSha256 &&
      equal(o.volumes, e.volumes) &&
      equal(o.dbBoundary, e.dbBoundary),
    "installation"
  );
  const build = o.build;
  check(
    equal(build.command, e.buildCommand) &&
      build.completed === true &&
      build.exitCode === 0 &&
      build.rawExitCode === 0 &&
      equal(build.source, e.source) &&
      build.imageId === e.imageId &&
      build.bundleSha256 === e.bundleSha256 &&
      build.bootstrapSha256 === e.option.bootstrapSha256 &&
      build.receiptSha256 === e.buildReceiptSha256 &&
      hex.test(build.receiptSha256),
    "fresh-build"
  );
  check(o.apis.length === 1 && o.apis[0]?.resolvedEntry === "/app/dist/server.js", "api-count");
  const { resolvedEntry: _entry, ...api } = o.apis[0]!;
  identity(api);
  check(api.containerId === e.containerId, "api-container");
  privateFile(o.socketDirectory, "directory", 0o700, e.channel.uid);
  privateFile(o.socket, "socket", 0o600, e.channel.uid);
  return api;
}

/** Fixed native bridge. No import loader, endpoint, discovery handshake or reconnect. */
export const NATIVE_BRIDGE = String.raw`
const net = require("node:net");
const path = process.argv[1], deadline = Number(process.argv[2]);
let bytes = 0, input = 0, output = 0, closing = false;
const red = () => { process.exitCode = 1; socket.destroy(); process.stdin.destroy(); };
const socket = net.createConnection(path);
const timer = setTimeout(red, Math.max(0, Math.min(deadline - Date.now(), 2147483647)));
process.stdin.pause();
socket.on("connect", () => { process.stdin.resume(); });
process.stdin.on("data", chunk => {
  bytes += chunk.length;
  if (bytes > 65536) return red();
  for (const byte of chunk) { input++; if (input > 4096) return red(); if (byte === 10) input = 0; }
  if (!socket.write(chunk)) red();
});
socket.on("data", chunk => {
  for (const byte of chunk) { output++; if (output > 4096) return red(); if (byte === 10) output = 0; }
  if (!process.stdout.write(chunk)) red();
});
process.stdin.on("end", () => { closing = true; socket.end(); });
process.stdin.on("error", red); socket.on("error", red); process.stdout.on("error", red);
socket.on("close", () => { clearTimeout(timer); if (!closing || input || output) process.exitCode = 1; process.stdin.destroy(); });
`;
export interface BridgeBirth {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
  readonly group: number;
  readonly session: number;
}
export interface OwnedBridge {
  readonly birth: BridgeBirth;
  write(frame: string): boolean;
  end(): void;
}
export interface BridgeSpec {
  readonly command: "docker";
  readonly args: readonly string[];
  readonly deadline: number;
  readonly daemon: ExpectedBindings["daemon"];
}
export interface BridgeEvents {
  data(chunk: Buffer): void;
  failure(): void;
  closed(receipt: { readonly birth: BridgeBirth; readonly exitCode: number }): void;
}
export interface ConsumerCollectors {
  /** Must retain uncertain command handles; cancellation is not closure. No arbitrary command API. */
  installation(deadline: number): Promise<InstallationObservation>;
  producer(deadline: number): Promise<ProducerSnapshot>;
  /** Synchronous owned spawn; on uncertainty retain ownership externally before throwing. */
  bridge(spec: BridgeSpec, events: BridgeEvents): OwnedBridge;
}
export interface CompletionAttestation {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly surface: "drawer";
  readonly turnId: string;
  readonly complete: true;
  readonly http: {
    readonly status: number;
    readonly finished: true;
    readonly receiptSha256: string;
  };
  readonly ui: { readonly finished: true; readonly receiptSha256: string };
}
interface ObserverStatus {
  version: 1;
  identity: ApiIdentity;
  pins: { bootstrapSha256: string; bundleSha256: string };
  ready: true;
  error: null;
  sequence: number;
  counters: Record<Site, number>;
  coverage: Site[];
  openAttempts: number;
  attempts: number;
  metadataBytes: number;
  completedWindows: number;
}
export interface WindowResult {
  readonly turnId: string;
  readonly delta: Readonly<Record<Site, number>>;
  readonly status: ObserverStatus;
}
/** An inert, single-use owner. Collectors supply independent observations; socket pins cannot. */
export class N3ObserverConsumer {
  private readonly expected: ExpectedBindings;
  private red = false;
  private busy = false;
  private opening = false;
  private closing = false;
  private disposed = false;
  private handle?: OwnedBridge;
  private birth?: BridgeBirth;
  private api?: ApiIdentity;
  private installation?: InstallationObservation;
  private chain: readonly string[] = [];
  private records: readonly string[] = [];
  private sequence = 0;
  private last?: ObserverStatus;
  private requestId = 0;
  private pending?: { resolve(value: unknown): void; reject(reason: Error): void };
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  private window?: {
    actorUserId: string;
    threadId: string;
    surface: "drawer";
    mode: "terminal" | "positive";
    number: number;
    start: ObserverStatus;
  };
  private closeResolve?: () => void;
  constructor(
    expected: ExpectedBindings,
    private readonly collectors: ConsumerCollectors
  ) {
    validateExpected(expected, Date.now());
    this.expected = structuredClone(expected);
  }
  get failed() {
    return this.red;
  }
  /** Retain this exact handle on uncertainty; this module never guesses a PID to signal. */
  get retainedBridge(): OwnedBridge | undefined {
    return this.disposed ? undefined : this.handle;
  }
  private fail(): Error {
    this.red = true;
    const error = new Error("N3 consumer: RED");
    this.pending?.reject(error);
    this.pending = undefined;
    return error;
  }
  private healthy() {
    if (
      this.red ||
      this.disposed ||
      Date.now() >= this.expected.option.deadline ||
      (this.handle && this.birth && !equal(this.handle.birth, this.birth))
    )
      throw this.fail();
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    const remaining = this.expected.option.deadline - Date.now();
    if (remaining <= 0) throw this.fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(this.fail()), Math.min(remaining, 2147483647));
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw this.fail();
    this.busy = true;
    try {
      this.healthy();
      return await this.bounded(work);
    } catch {
      throw this.fail();
    } finally {
      this.busy = false;
    }
  }
  private async reconcile() {
    this.healthy();
    const e = this.expected;
    const producer = await this.bounded(() => this.collectors.producer(e.option.deadline));
    this.healthy();
    const chain = validateProducer(e, producer);
    check(
      this.chain.every((d, i) => d === chain.digests[i] && this.records[i] === chain.raw[i]),
      "chain-drift"
    );
    this.chain = chain.digests;
    this.records = chain.raw;
    const installation = await this.bounded(() => this.collectors.installation(e.option.deadline));
    this.healthy();
    const api = validateInstallation(e, installation);
    if (this.api)
      check(equal(api, this.api) && equal(installation, this.installation), "boundary-drift");
    this.api = api;
    this.installation = structuredClone(installation);
  }
  private data(chunk: Buffer) {
    try {
      check(!this.red && !this.closing && Buffer.isBuffer(chunk) && chunk.length > 0, "transport");
      this.bytes += chunk.length;
      check(this.bytes <= 65536 && this.buffer.length + chunk.length <= 4096, "frame-limit");
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      check(end === this.buffer.length - 1 && this.pending, "extra-reply");
      const value: unknown = JSON.parse(this.buffer.subarray(0, end).toString("utf8"));
      this.buffer = Buffer.alloc(0);
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(value);
    } catch {
      this.fail();
    }
  }
  private statusReply(value: unknown, extra: readonly string[] = []): ObserverStatus {
    const r = object(value);
    keys(r, [
      "version",
      "identity",
      "pins",
      "ready",
      "error",
      "sequence",
      "counters",
      "coverage",
      "openAttempts",
      "attempts",
      "metadataBytes",
      "completedWindows",
      ...extra
    ]);
    check(
      r.version === 1 &&
        r.ready === true &&
        r.error === null &&
        equal(r.identity, this.api) &&
        equal(r.pins, {
          bootstrapSha256: this.expected.option.bootstrapSha256,
          bundleSha256: this.expected.bundleSha256
        }),
      "status-identity"
    );
    const counts = object(r.counters);
    const coverage = r.coverage;
    keys(counts, OBSERVER_SITES);
    check(
      OBSERVER_SITES.every((s) => natural(counts[s])) &&
        Array.isArray(coverage) &&
        coverage.length === OBSERVER_SITES.length &&
        new Set(coverage).size === OBSERVER_SITES.length &&
        OBSERVER_SITES.every((s) => coverage.includes(s)),
      "coverage"
    );
    check(
      [r.sequence, r.openAttempts, r.attempts, r.metadataBytes, r.completedWindows].every(
        natural
      ) &&
        Number(r.attempts) <= 256 &&
        Number(r.metadataBytes) <= 65536 &&
        Number(r.openAttempts) <= Number(r.attempts) &&
        Object.values(counts).reduce<number>((sum, n) => sum + Number(n), 0) === r.attempts,
      "counters"
    );
    const current = r as unknown as ObserverStatus;
    if (this.last) {
      check(
        current.sequence >= this.last.sequence &&
          current.metadataBytes >= this.last.metadataBytes &&
          current.attempts >= this.last.attempts &&
          current.completedWindows >= this.last.completedWindows &&
          OBSERVER_SITES.every((s) => current.counters[s] >= this.last!.counters[s]),
        "counter-regression"
      );
      if (current.sequence === this.last.sequence)
        check(
          equal(current.counters, this.last.counters) &&
            current.openAttempts === this.last.openAttempts &&
            current.metadataBytes === this.last.metadataBytes,
          "sequence-reset"
        );
    }
    this.sequence = current.sequence;
    this.last = structuredClone(current);
    return current;
  }
  private async request(op: string, fields: JsonObject = {}, extra: readonly string[] = []) {
    this.healthy();
    check(this.handle && !this.pending && this.buffer.length === 0, "request-state");
    const frame =
      JSON.stringify({
        version: 1,
        nonce: this.expected.option.nonce,
        requestId: ++this.requestId,
        identity: this.api,
        op,
        ...fields
      }) + "\n";
    check(Buffer.byteLength(frame) <= 4096, "request-frame");
    const reply = await this.bounded(
      () =>
        new Promise<unknown>((resolve, reject) => {
          this.pending = { resolve, reject };
          try {
            if (!this.handle!.write(frame)) reject(this.fail());
          } catch {
            reject(this.fail());
          }
        })
    );
    this.healthy();
    return this.statusReply(reply, extra);
  }
  async open(): Promise<ObserverStatus> {
    return this.operation(async () => {
      check(!this.opening && !this.handle, "reconnect");
      this.opening = true;
      await this.reconcile();
      const e = this.expected;
      this.handle = this.collectors.bridge(
        {
          command: "docker",
          daemon: e.daemon,
          deadline: e.option.deadline,
          args: [
            "exec",
            "-i",
            e.containerId,
            "node",
            "-e",
            NATIVE_BRIDGE,
            `/run/jarv1s/n3-${e.option.nonce}/observer.sock`,
            String(e.option.deadline)
          ]
        },
        {
          data: (chunk) => this.data(chunk),
          failure: () => {
            this.fail();
          },
          closed: (receipt) => {
            if (
              !this.closing ||
              !this.handle ||
              !equal(receipt.birth, this.birth) ||
              !equal(this.handle.birth, this.birth) ||
              Date.now() >= e.option.deadline ||
              receipt.exitCode !== 0 ||
              this.buffer.length > 0
            ) {
              this.fail();
              return;
            }
            this.disposed = true;
            this.closeResolve?.();
          }
        }
      );
      const b = this.handle.birth;
      this.birth = structuredClone(b);
      check(
        natural(b.pid) &&
          b.pid > 0 &&
          /^[0-9]{1,24}$/.test(b.startTicks) &&
          uuid.test(b.bootId) &&
          b.group === b.pid &&
          b.session === b.pid,
        "bridge-birth"
      );
      const status = await this.request("status");
      check(status.openAttempts === 0 && status.completedWindows === 0, "initial-state");
      return status;
    });
  }
  async status(): Promise<ObserverStatus> {
    return this.operation(async () => {
      await this.reconcile();
      return this.request("status");
    });
  }
  async beginWindow(actorUserId: string, threadId: string, mode: "terminal" | "positive") {
    return this.operation(async () => {
      check(
        !this.window &&
          uuid.test(actorUserId) &&
          uuid.test(threadId) &&
          ["terminal", "positive"].includes(mode),
        "begin"
      );
      await this.reconcile();
      const start = await this.request("status");
      check(start.openAttempts === 0, "globally-open");
      const result = await this.request(
        "begin",
        { actorUserId, threadId, surface: "drawer", mode },
        ["window"]
      );
      const number = Number((result as unknown as JsonObject).window);
      check(
        number === start.completedWindows + 1 &&
          result.completedWindows === start.completedWindows &&
          result.sequence === start.sequence,
        "window-number"
      );
      this.window = { actorUserId, threadId, mode, surface: "drawer", number, start };
      return number;
    });
  }
  async finishWindow(attestation: CompletionAttestation): Promise<WindowResult> {
    return this.operation(async () => {
      const w = this.window;
      check(
        w &&
          attestation.actorUserId === w.actorUserId &&
          attestation.threadId === w.threadId &&
          attestation.surface === w.surface &&
          uuid.test(attestation.turnId) &&
          attestation.complete === true &&
          attestation.http.finished === true &&
          attestation.http.status >= 200 &&
          attestation.http.status < 300 &&
          hex.test(attestation.http.receiptSha256) &&
          attestation.ui.finished === true &&
          hex.test(attestation.ui.receiptSha256),
        "completion-attestation"
      );
      await this.reconcile();
      let current = await this.request("status");
      while (current.openAttempts > 0) {
        await this.bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
        current = await this.request("status");
      }
      check(current.counters.turn - w.start.counters.turn === 1, "single-turn");
      await this.reconcile();
      const barrierReply = await this.request("barrier", { sequence: this.sequence }, ["barrier"]);
      const barrier = object((barrierReply as unknown as JsonObject).barrier);
      keys(barrier, ["sequence", "token"]);
      check(
        barrier.sequence === this.sequence &&
          typeof barrier.token === "string" &&
          uuid.test(barrier.token) &&
          barrierReply.openAttempts === 0 &&
          barrierReply.sequence === current.sequence,
        "barrier"
      );
      await this.reconcile();
      const end = await this.request(
        "end",
        {
          actorUserId: w.actorUserId,
          threadId: w.threadId,
          surface: w.surface,
          turnId: attestation.turnId,
          complete: attestation.complete,
          sequence: barrier.sequence,
          barrier: barrier.token
        },
        ["window", "turnId", "delta"]
      );
      const fields = end as unknown as JsonObject;
      const delta = object(fields.delta);
      keys(delta, OBSERVER_SITES);
      check(
        fields.window === w.number &&
          fields.turnId === attestation.turnId &&
          end.completedWindows === w.number &&
          end.openAttempts === 0 &&
          end.sequence === barrier.sequence &&
          OBSERVER_SITES.every((s) => delta[s] === end.counters[s] - w.start.counters[s]) &&
          delta.turn === 1 &&
          (w.mode === "positive" || OBSERVER_SITES.every((s) => s === "turn" || delta[s] === 0)),
        "window-delta"
      );
      this.window = undefined;
      return { turnId: attestation.turnId, delta: delta as Record<Site, number>, status: end };
    });
  }
  /** Proves only this bridge's closure. No app/API/container/producer teardown claim. */
  async close(): Promise<{ disposed: boolean; retained: OwnedBridge | undefined }> {
    if (this.disposed) return { disposed: true, retained: undefined };
    if (this.busy || !this.handle || this.closing) {
      this.fail();
      return { disposed: false, retained: this.handle };
    }
    this.closing = true;
    try {
      await this.bounded(
        () =>
          new Promise<void>((resolve) => {
            this.closeResolve = resolve;
            this.handle!.end();
          })
      );
    } catch {
      this.fail();
    }
    return { disposed: this.disposed, retained: this.retainedBridge };
  }
}
