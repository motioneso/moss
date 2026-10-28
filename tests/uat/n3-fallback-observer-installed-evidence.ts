import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  ExpectedBindings,
  FileIdentity,
  ProducerSnapshot
} from "./n3-fallback-observer-runner.js";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
const red = (): never => {
  throw new Error("N3 installed: RED");
};
function check(v: unknown, _code?: string): asserts v {
  if (!v) red();
}
function object(v: unknown): Record<string, unknown> {
  check(v && Object.getPrototypeOf(v) === Object.prototype);
  return v as Record<string, unknown>;
}
const json = (v: Buffer) => {
  try {
    return JSON.parse(v.toString()) as unknown;
  } catch {
    return red();
  }
};
export type ProducerBindings = Pick<
  ExpectedBindings,
  | "channel"
  | "producerSha256"
  | "producer"
  | "source"
  | "daemon"
  | "lifecycleNonce"
  | "attempt"
  | "project"
  | "port"
  | "compose"
  | "imageId"
  | "imageReference"
  | "containerId"
  | "volumes"
>;
const rounded = (n: number) => Math.ceil(n / 512) * 512;
export const K = "e2b66b672d625221ddd7139d31046372d94d2e8d";
export const IGNORE_SHA256 = "c212ecfadfe09b4edf283ba9844246b0595cb89ccafacd8371059103069eb938";
// Literal immutable K payload ceilings are installed below, never learned from Docker output.
export const SOURCE_FILES: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  "/app/tests/uat/n3-fallback-observer-bootstrap.mjs": [
    "cb5e0aad361cd18305d511752bfd05fb40362f4673176225f04d1ef435afd97d",
    19140
  ],
  "/app/tests/uat/lifecycle-records.ts": [
    "aaeed62a44bfd45c1767f7a0ecdb8198227562c22a913187fe2550430d4251e0",
    26903
  ],
  "/app/packages/chat/src/live/chat-session-manager.ts": [
    "e8687560858dc953a64ba7017a9aff9175588408f3ec3435fb6e8c08e7c8becc",
    19872
  ],
  "/app/packages/chat/src/live/chat-session-ports.ts": [
    "0195bd5bcd288289b82cc1010463cd99c7049ff98df2729e450cfcf3aa076114",
    19496
  ],
  "/app/packages/chat/src/live/pre-model-turn.ts": [
    "113ceb8cc90d8005d5d28017a7d197158bd02e01a168b4d0141422958ed6d140",
    11174
  ],
  "/app/packages/chat/src/reminders/features.ts": [
    "91ca420a38f8fc9bdf9003953e2f26429a5c480dd335248aabd4c9f84d922158",
    11733
  ],
  "/app/packages/chat/src/scheduled-reads/generation.ts": [
    "b6d4883b3abba7103d07549be68045cdb0bf6b8d77e3c618f725434e42d1979b",
    5278
  ],
  "/app/packages/chat/src/scheduled-reads/request.ts": [
    "b9f0cde8124905180fcec82ab2665def136bf98038ee4db9b8958eab7e9f0174",
    6607
  ],
  "/app/packages/chat/src/live/chat-attempt-observer.ts": [
    "9a21cd24d0a1888159c0df855deb1116313c009791db928fa3f536dd520d8af1",
    6251
  ],
  "/app/packages/chat/src/live/chat-session-turn.ts": [
    "d8e4461a87d3785bea18e98bd687843a54ea7401dc69160249eb0c1abce5df84",
    26118
  ],
  "/app/packages/chat/src/live/chat-session-launch.ts": [
    "38e75a015cd7a415071cc09e9747c10274ff15344933c8f3c82e067be7e330a2",
    13664
  ],
  "/app/packages/chat/src/live/classifier-gate-lifecycle.ts": [
    "c4483827a5330ace9dac901fedba8b77d600eae9f312bde447d4c9203fd7290c",
    12558
  ],
  "/app/packages/chat/src/live/classifier-gate-shadow.ts": [
    "ed0dc5f536d4372718039f6e6606b94414eed4d611d232a4565e1972022d6308",
    20867
  ]
});
export const BUNDLE = "/app/dist/server.js";
export const INSTALLED_PATHS = Object.freeze([...Object.keys(SOURCE_FILES), BUNDLE]);
const capFor = (path: string) =>
  path === BUNDLE ? 64 * 1024 * 1024 : (SOURCE_FILES[path]?.[1] ?? red());

/** Docker cp FILE - emits a basename, never a caller-selected archive path. */
export function singleFileTar(tar: Buffer, path: string): Buffer {
  const cap = capFor(path);
  check(INSTALLED_PATHS.includes(path) && tar.length >= 1536 && tar.length % 512 === 0);
  check(tar.length <= 512 + rounded(cap) + 16384);
  const header = tar.subarray(0, 512);
  const field = (start: number, size: number) => {
    const raw = header.subarray(start, start + size);
    const end = raw.indexOf(0);
    check(end < 0 || raw.subarray(end).every((v) => v === 0));
    return raw.subarray(0, end < 0 ? size : end).toString("ascii");
  };
  const octal = (start: number, size: number) => {
    const raw = header.subarray(start, start + size).toString("ascii");
    check(/^[0-7]+[\0 ]*$/.test(raw));
    const result = Number.parseInt(raw, 8);
    check(Number.isSafeInteger(result) && result >= 0);
    return result;
  };
  check(field(0, 100) === basename(path) && !field(345, 155) && !field(157, 100));
  check(header[156] === 0 || header[156] === 48);
  check(field(257, 6) === "ustar" && header.subarray(263, 265).toString() === "00");
  const checksum = octal(148, 8);
  check(checksum === header.reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0));
  const size = octal(124, 12);
  for (const [start, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
    [136, 12]
  ] as const)
    octal(start, length);
  const end = 512 + rounded(size);
  check(size <= cap && end + 1024 <= tar.length && tar.length - end <= 16384);
  check(tar.subarray(512 + size, end).every((v) => v === 0));
  check(tar.subarray(end).every((v) => v === 0));
  return tar.subarray(512, 512 + size);
}

function canonical(value: unknown): string {
  check(typeof value === "string" && value.startsWith("/") && !value.includes("\0"));
  check(
    value === "/" ||
      value
        .split("/")
        .slice(1)
        .every((v) => v && v !== "." && v !== "..")
  );
  return value;
}
/** Independent of expected volume checks: every mount type must pass both gates. */
export function excludeFileMounts(info: Record<string, unknown>): void {
  check(Array.isArray(info.Mounts) && info.Mounts.length <= 256);
  const seen = new Set<string>();
  for (const raw of info.Mounts) {
    const m = object(raw),
      destination = canonical(m.Destination);
    check(typeof m.Type === "string" && m.Type.length > 0 && !seen.has(destination));
    seen.add(destination);
    check(
      !INSTALLED_PATHS.some(
        (p) => destination === "/" || p === destination || p.startsWith(destination + "/")
      )
    );
  }
  const host = object(info.HostConfig),
    tmpfs = object(host.Tmpfs ?? {});
  check(Object.keys(tmpfs).length <= 256);
  for (const [destination, options] of Object.entries(tmpfs)) {
    canonical(destination);
    check(typeof options === "string");
    check(
      info.Mounts.some((raw) => {
        const m = object(raw);
        return m.Type === "tmpfs" && m.Destination === destination;
      })
    );
  }
  check(host.Binds === null || host.Binds === undefined || Array.isArray(host.Binds));
  if (Array.isArray(host.Binds)) {
    check(host.Binds.length <= 256);
    const configured = new Set<string>();
    for (const binding of host.Binds) {
      check(typeof binding === "string");
      const parts = binding.split(":");
      check(parts.length === 2 || parts.length === 3);
      const destination = canonical(parts[1]);
      check(parts[0] && !configured.has(destination));
      configured.add(destination);
      check(info.Mounts.some((raw) => object(raw).Destination === destination));
    }
  }
  check(host.Mounts === undefined || host.Mounts === null || Array.isArray(host.Mounts));
  if (Array.isArray(host.Mounts)) {
    check(host.Mounts.length <= 256);
    const configured = new Set<string>();
    for (const raw of host.Mounts) {
      const mount = object(raw),
        destination = canonical(mount.Target);
      check(typeof mount.Type === "string" && !configured.has(destination));
      configured.add(destination);
      check(
        info.Mounts.some(
          (raw) => object(raw).Destination === destination && object(raw).Type === mount.Type
        )
      );
    }
  }
  for (const raw of info.Mounts) {
    const m = object(raw);
    if (m.Type === "tmpfs") check(Object.hasOwn(tmpfs, String(m.Destination)));
    if (m.Type === "volume") check(typeof m.Name === "string" && typeof m.Source === "string");
    if (m.Type === "bind") check(typeof m.Source === "string" && m.Source.startsWith("/"));
  }
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
function keys(value: Record<string, unknown>, names: readonly string[]) {
  check(
    Object.keys(value).length === names.length && names.every((k) => Object.hasOwn(value, k)),
    "keys"
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
function validatePreCopyProducer(
  e: ProducerBindings,
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
    const r = object(json(Buffer.from(file.raw)));
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
export function authenticateProducerBeforeCopy(
  e: ProducerBindings,
  snapshot: ProducerSnapshot
): Record<string, unknown> {
  validatePreCopyProducer(e, snapshot);
  const latest = object(json(Buffer.from(snapshot.records.at(-1)!.raw)));
  check(Array.isArray(latest.inventory));
  const app = latest.inventory
    .map(object)
    .filter((r) => r.kind === "container" && r.id === e.containerId);
  check(app.length === 1);
  return structuredClone(object(app[0]!.creation));
}
