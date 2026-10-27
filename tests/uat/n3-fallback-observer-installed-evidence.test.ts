import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  opendirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { InstalledReads, type ReadPins } from "./n3-fallback-observer-installed-reads.js";
import { lifecycleFixture } from "./provisioner-lifecycle-fixture.js";
import type { ProducerSnapshot, FileIdentity } from "./n3-fallback-observer-runner.js";
import {
  K,
  IGNORE_SHA256,
  SOURCE_FILES,
  INSTALLED_PATHS,
  BUNDLE,
  singleFileTar,
  excludeFileMounts,
  authenticateProducerBeforeCopy,
  type ProducerBindings
} from "./n3-fallback-observer-installed-evidence.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const stat = (path: string, type: FileIdentity["type"]): FileIdentity => {
  const s = lstatSync(path);
  return { type, device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 0o777 };
};
describe("producer channel identity regression:", () => {
  const fields = ["device", "inode", "uid", "mode", "type"] as const;
  type Change = (channel: FileIdentity) => void;
  const invalid: [string, Change][] = fields.flatMap((field): [string, Change][] => [
    [
      `changed ${field}`,
      (channel) => {
        Reflect.set(channel, field, field === "type" ? "file" : Number(channel[field]) + 1);
      }
    ],
    [
      `wrong type ${field}`,
      (channel) => {
        Reflect.set(
          channel,
          field,
          field === "type" ? Object(channel[field]) : String(channel[field])
        );
      }
    ],
    [
      `missing ${field}`,
      (channel) => {
        Reflect.deleteProperty(channel, field);
      }
    ],
    [
      `inherited ${field}`,
      (channel) => {
        Object.setPrototypeOf(channel, { [field]: channel[field] });
        Reflect.deleteProperty(channel, field);
      }
    ]
  ]);
  invalid.push(
    [
      "extra enumerable key",
      (channel) => {
        Reflect.set(channel, "extra", 1);
      }
    ],
    [
      "extra non-enumerable key",
      (channel) => {
        Object.defineProperty(channel, "extra", { value: 1 });
      }
    ],
    [
      "extra symbol key",
      (channel) => {
        Reflect.set(channel, Symbol("extra"), 1);
      }
    ]
  );
  const cases: [string, boolean, Change][] = [
    ["type-first ordinary snapshot", true, () => {}],
    ["device-first ordinary snapshot", true, () => {}],
    [
      "exact non-enumerable own field",
      true,
      (channel) => {
        Object.defineProperty(channel, "uid", { enumerable: false });
      }
    ],
    ...invalid.map(([name, change]): [string, boolean, Change] => [name, false, change])
  ];
  it.each(cases)("%s", (name, accepted, change) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "n3-channel-identity-"));
    try {
      const channelPath = join(fixtureRoot, "channel"),
        sourcePath = join(fixtureRoot, "tests/uat/lifecycle-records.ts"),
        raw = '{"fixture":"reader enumeration only; not authenticated P"}',
        producer = Buffer.from("passive fixture producer\n");
      mkdirSync(channelPath, { mode: 0o700 });
      mkdirSync(join(fixtureRoot, "tests/uat"), { recursive: true, mode: 0o700 });
      writeFileSync(sourcePath, producer, { mode: 0o600 });
      writeFileSync(join(channelPath, "000001.json"), raw, { mode: 0o600 });
      const s = lstatSync(channelPath);
      const channel: FileIdentity =
        name === "type-first ordinary snapshot"
          ? { type: "directory", device: s.dev, inode: s.ino, uid: s.uid, mode: 0o700 }
          : { device: s.dev, inode: s.ino, uid: s.uid, mode: 0o700, type: "directory" };
      change(channel);
      const pins: ReadPins = {
        source: {
          root: {
            path: fixtureRoot,
            device: lstatSync(fixtureRoot).dev,
            inode: lstatSync(fixtureRoot).ino
          },
          commit: "1".repeat(40),
          tree: "2".repeat(40),
          inputFingerprint: "3".repeat(64)
        },
        daemon: { context: "fixture", endpoint: "fixture", daemonId: "fixture" },
        channel,
        channelPath,
        project: "fixture",
        imageReference: "fixture",
        volumes: [],
        nonce: "4".repeat(64),
        ignoreSha256: "5".repeat(64),
        sourceFiles: { "/app/tests/uat/lifecycle-records.ts": [hash(producer), producer.length] }
      };
      const spawn = vi.fn(() => {
          throw new Error("forbidden spawn");
        }),
        opendir = vi.fn(opendirSync),
        refuse = vi.fn((): never => {
          throw new Error("N3 installed: RED");
        }),
        checkpoint = vi.fn();
      const reads = new InstalledReads(
        pins,
        {
          deadline: 1000,
          checkpoint,
          refuse,
          retain: () => {
            throw new Error("forbidden retain");
          },
          releaseClosed: () => {
            throw new Error("forbidden release");
          },
          environment: () => undefined
        },
        { spawn, opendir, now: () => 0 }
      );
      if (accepted) {
        expect(reads.producerSnapshot()).toEqual({
          channel: { device: s.dev, inode: s.ino, uid: s.uid, mode: 0o700, type: "directory" },
          producerSha256: hash(producer),
          records: [
            { name: "000001.json", stat: stat(join(channelPath, "000001.json"), "file"), raw }
          ]
        });
        expect(opendir).toHaveBeenCalledTimes(1);
        expect(opendir).toHaveBeenCalledWith(channelPath);
        expect(refuse).not.toHaveBeenCalled();
      } else {
        expect(() => reads.producerSnapshot()).toThrow(/^N3 installed: RED$/);
        expect(refuse).toHaveBeenCalledTimes(1);
        expect(opendir).not.toHaveBeenCalled();
      }
      expect(checkpoint).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
function tar(bytes: Buffer, type = "0", name = "server.js"): Buffer {
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
  const sum = out.subarray(0, 512).reduce((a, b) => a + b, 0);
  out.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
}
function context(data: Buffer) {
  const rules = data
    .toString()
    .split("\n")
    .filter((v) => v && !v.startsWith("#"))
    .map((raw) => {
      const include = raw.startsWith("!"),
        pattern = include ? raw.slice(1) : raw;
      if (
        !pattern ||
        pattern !== pattern.trim() ||
        pattern.startsWith("/") ||
        pattern.endsWith("/") ||
        /[?[\]\\]/.test(pattern) ||
        (pattern.includes("**") && (!pattern.startsWith("**/") || pattern.slice(3).includes("**")))
      )
        throw new Error("unsupported context grammar");
      const deep = pattern.startsWith("**/"),
        body = deep ? pattern.slice(3) : pattern;
      const regex = [...body]
        .map((c) => (c === "*" ? "[^/]*" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return { include, expression: new RegExp("^" + (deep ? "(?:[^/]+/)*" : "") + regex + "$") };
    });
  return (path: string) => {
    const parts = path.split("/");
    if (parts.some((v) => !v || v === "." || v === "..")) throw new Error("invalid path");
    let included = true;
    for (const rule of rules)
      if (parts.some((_, i) => rule.expression.test(parts.slice(0, i + 1).join("/"))))
        included = rule.include;
    return included;
  };
}
describe("immutable installed source/context contract", () => {
  it("binds the exact fourteen keys to K, normal final Git blobs and frozen generation inputs", () => {
    const required = [
      "tests/uat/n3-fallback-observer-bootstrap.mjs",
      "tests/uat/lifecycle-records.ts",
      "packages/chat/src/live/chat-session-manager.ts",
      "packages/chat/src/live/chat-session-ports.ts",
      "packages/chat/src/live/pre-model-turn.ts",
      "packages/chat/src/reminders/features.ts",
      "packages/chat/src/scheduled-reads/generation.ts",
      "packages/chat/src/scheduled-reads/request.ts",
      "packages/chat/src/live/chat-attempt-observer.ts",
      "packages/chat/src/live/chat-session-turn.ts",
      "packages/chat/src/live/chat-session-launch.ts",
      "packages/chat/src/live/classifier-gate-lifecycle.ts",
      "packages/chat/src/live/classifier-gate-shadow.ts"
    ];
    expect(INSTALLED_PATHS).toEqual([...required.map((p) => "/app/" + p), BUNDLE]);
    expect(new Set(INSTALLED_PATHS).size).toBe(14);
    expect(git("status", "--porcelain=v1", "--untracked-files=normal").toString()).toBe("");
    const head = git("rev-parse", "HEAD").toString().trim();
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    expect(
      git("rev-parse", head + "^{tree}")
        .toString()
        .trim()
    ).toMatch(/^[a-f0-9]{40}$/);
    const ignore = git("show", K + ":.dockerignore"),
      include = context(ignore);
    expect(Object.keys(SOURCE_FILES)).toHaveLength(13);
    expect(BUNDLE).toBe("/app/dist/server.js");
    const sourceSizes: number[] = [];
    expect(hash(ignore)).toBe(IGNORE_SHA256);
    expect(git("show", head + ":.dockerignore")).toEqual(ignore);
    expect(existsSync(join(root, "Dockerfile.dockerignore"))).toBe(false);
    expect(git("ls-tree", K, "--", "Dockerfile.dockerignore").length).toBe(0);
    for (const path of required) {
      const bytes = git("show", K + ":" + path),
        key = "/app/" + path;
      expect(SOURCE_FILES[key]).toEqual([hash(bytes), bytes.length]);
      sourceSizes.push(bytes.length);
      expect(git("show", head + ":" + path)).toEqual(bytes);
      expect(git("ls-tree", head, "--", path).toString()).toMatch(/^100644 blob /);
      expect(lstatSync(join(root, path)).isFile()).toBe(true);
      expect(readFileSync(join(root, path))).toEqual(bytes);
      for (let n = 1; n <= path.split("/").length; n++)
        expect(include(path.split("/").slice(0, n).join("/"))).toBe(true);
    }
    expect(sourceSizes).toEqual([
      19140, 26974, 24380, 20498, 11174, 11833, 5278, 6607, 6251, 29613, 13677, 12686, 20867
    ]);
    expect(sourceSizes.reduce((sum, size) => sum + size, 0)).toBe(208978);
    const rounded = sourceSizes.map((size) => Math.ceil(size / 512) * 512);
    expect(rounded.reduce((sum, size) => sum + size, 0)).toBe(211968);
    const ceilings = [...rounded, 67108864].map((size) => 512 + size + 16384);
    expect(ceilings).toHaveLength(14);
    const maximum = ceilings.reduce((sum, size) => sum + size, 0);
    expect(Number.isSafeInteger(maximum)).toBe(true);
    expect(maximum).toBe(67557376);
    expect(maximum).toBeLessThan(83886080);
    expect(83886080 - maximum).toBe(16328704);
    console.info("aggregate maximum=67557376 limit=83886080", maximum);
    for (const path of ["Dockerfile", "package.json", "scripts/build-app.ts"])
      expect(git("show", head + ":" + path)).toEqual(git("show", K + ":" + path));
    expect(git("show", K + ":Dockerfile").toString()).toContain("COPY . .");
    expect(git("show", K + ":Dockerfile").toString()).toContain("FROM build AS runtime");
    expect(git("show", K + ":Dockerfile").toString()).toContain("RUN pnpm build:api");
    expect(JSON.parse(git("show", K + ":package.json").toString()).scripts["build:api"]).toBe(
      "tsx scripts/build-app.ts api"
    );
    expect(git("show", K + ":scripts/build-app.ts").toString()).toContain(
      'api: { entry: "apps/api/src/server.ts", outfile: "dist/server.js" }'
    );
    expect(include("dist/server.js")).toBe(false);
  });
  it("uses unchanged membership assertion for exact in-memory exception removal and restoration", () => {
    const original = git("show", K + ":.dockerignore"),
      line = "!tests/uat/lifecycle-records.ts\n";
    const text = original.toString();
    expect(text.split(line)).toHaveLength(2);
    expect(text).toContain("tests/uat/*.ts\n" + line);
    const removed = Buffer.from(text.replace(line, ""));
    const restored = Buffer.from(
      removed.toString().replace("tests/uat/*.ts\n", "tests/uat/*.ts\n" + line)
    );
    const assertion = (data: Buffer) =>
      expect(
        context(data)("tests/uat/lifecycle-records.ts"),
        "required producer source is included"
      ).toBe(true);
    assertion(original);
    expect(() => assertion(removed)).toThrow("required producer source is included");
    assertion(restored);
    expect(hash(original)).toBe(IGNORE_SHA256);
    expect(hash(removed)).not.toBe(IGNORE_SHA256);
    expect(hash(restored)).toBe(IGNORE_SHA256);
    const before = context(removed),
      after = context(original);
    const tracked = git("ls-tree", "-rz", "--full-tree", K)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((v) => v.split("\t")[1]!);
    expect(tracked.filter((p) => before(p) !== after(p))).toEqual([
      "tests/uat/lifecycle-records.ts"
    ]);
    for (const p of [
      "tests/uat/provisioner.ts",
      "tests/uat/provisioner.test.ts",
      "tests/uat/provisioner-options.ts",
      "tests/uat/n3-fallback-observer-runner.ts",
      "tests/uat/n3-fallback-observer-runner.test.ts",
      "tests/uat/n3-fallback-observer-installed.ts",
      "tests/uat/n3-fallback-observer-installed-reads.ts",
      "tests/uat/n3-fallback-observer-installed-evidence.ts",
      "tests/uat/n3-fallback-observer-installed.test.ts",
      "tests/uat/n3-fallback-observer-installed-evidence.test.ts",
      "tests/uat/n3-fallback-observer-bootstrap.test.ts",
      "tests/uat/lifecycle-records.test.ts",
      "tests/uat/specs/3529-scheduled-read-terminal-real.uat.spec.ts",
      "tests/unit/chat-attempt-observer.test.ts",
      "tests/uat/lifecycle-records.ts.bak",
      "tests/uat/lifecycle-records.tsx",
      "tests/uat/lifecycle-records.ts.local",
      "tests/uat/lifecycle-records-extra.ts",
      "tests/uat/xlifecycle-records.ts",
      "tests/uat/nested/lifecycle-records.ts",
      "other/tests/uat/lifecycle-records.ts",
      "data/private",
      "infra/env.production.local",
      ".env",
      "outputs/a",
      "node_modules/a",
      "packages/chat/dist/a"
    ])
      expect(after(p), p).toBe(before(p));
    for (const p of [
      "tests/fixtures/job-search/example.json",
      "tests/fixtures/espn/example.json",
      "tests/uat/seed/cli.ts",
      "docs/WHATS_NEW.md"
    ])
      expect(after(p), p).toBe(true);
    expect(() => context(Buffer.from("bad?\n"))).toThrow("unsupported context grammar");
  });
});
describe("pure evidence public interface", () => {
  const bytes = Buffer.from("generated bundle");
  it("accepts exactly one regular requested member", () =>
    expect(singleFileTar(tar(bytes), BUNDLE)).toEqual(bytes));
  it.each(["1", "2", "3", "4", "5", "6", "x", "g", "L", "K", "S"])(
    "rejects tar type %s despite matching payload",
    (type) => expect(() => singleFileTar(tar(bytes, type), BUNDLE)).toThrow()
  );
  it.each(["/server.js", "../server.js", "a/../server.js", "a//server.js", "other.js"])(
    "rejects name %s",
    (name) => expect(() => singleFileTar(tar(bytes, "0", name), BUNDLE)).toThrow()
  );
  it.each([
    "checksum",
    "size",
    "truncated",
    "padding",
    "duplicate",
    "extra",
    "directory",
    "trailing",
    "prefix",
    "linkname"
  ])("rejects malformed %s archive", (kind) => {
    let out = tar(bytes);
    if (kind === "checksum") out[0] = 88;
    if (kind === "size") {
      out.write("99999999999\0", 124, 12);
      checksum(out);
    }
    if (kind === "truncated") out = out.subarray(0, out.length - 512);
    if (kind === "padding") out[512 + bytes.length] = 1;
    if (["duplicate", "extra", "directory", "trailing"].includes(kind))
      out = Buffer.concat([
        out.subarray(0, out.length - 1024),
        tar(bytes, kind === "directory" ? "5" : "0", kind === "extra" ? "other.js" : "server.js")
      ]);
    if (kind === "prefix") {
      out.write("parent", 345);
      checksum(out);
    }
    if (kind === "linkname") {
      out.write("elsewhere", 157);
      checksum(out);
    }
    expect(() => singleFileTar(out, BUNDLE), kind).toThrow();
  });
  it("refuses payload/allowlist/ceiling overflow", () => {
    const key = INSTALLED_PATHS[0]!,
      cap = SOURCE_FILES[key]![1];
    expect(() =>
      singleFileTar(tar(Buffer.alloc(cap + 1), "0", key.split("/").at(-1)), key)
    ).toThrow();
    expect(() => singleFileTar(tar(bytes), "/app/other.js")).toThrow();
  });
  it("bounds each bundle payload and validates every byte of archive terminator allowance", () => {
    expect(() => singleFileTar(tar(Buffer.alloc(64 * 1024 * 1024 + 1)), BUNDLE)).toThrow();
    const valid = tar(bytes),
      end = valid.length - 1024;
    const limit = Buffer.concat([valid.subarray(0, end), Buffer.alloc(16384)]);
    expect(singleFileTar(limit, BUNDLE)).toEqual(bytes);
    expect(() => singleFileTar(Buffer.concat([limit, Buffer.alloc(512)]), BUNDLE)).toThrow();
    limit[limit.length - 1] = 1;
    expect(() => singleFileTar(limit, BUNDLE)).toThrow();
  });
  const inspect = (destination: unknown, type = "bind") => ({
    Mounts: [{ Destination: destination, Type: type, Source: "/owned", Name: "owned" }],
    HostConfig: { Tmpfs: type === "tmpfs" ? { [String(destination)]: "" } : {} }
  });
  it.each(["bind", "volume", "tmpfs", "other"])("rejects file/ancestor coverage for %s", (type) => {
    for (const destination of [INSTALLED_PATHS[0], "/app", "/", "/app/packages/chat/src/live"])
      expect(() => excludeFileMounts(inspect(destination, type)), String(destination)).toThrow();
  });
  it.each(["", "app", "/app/", "/app//x", "/app/./x", "/app/../x", "/bad\0x", null, 1])(
    "refuses ambiguous destination %j",
    (destination) => expect(() => excludeFileMounts(inspect(destination))).toThrow()
  );
  it("accepts sibling prefixes while refusing duplicates/incomplete host mount declarations", () => {
    expect(() => excludeFileMounts(inspect("/application"))).not.toThrow();
    const duplicate = inspect("/okay");
    duplicate.Mounts.push({ ...duplicate.Mounts[0]! });
    expect(() => excludeFileMounts(duplicate)).toThrow();
    expect(() =>
      excludeFileMounts({ Mounts: [], HostConfig: { Tmpfs: { "/app": "" } } })
    ).toThrow();
    expect(() =>
      excludeFileMounts({ Mounts: [], HostConfig: { Binds: ["/owned:/app"], Tmpfs: {} } })
    ).toThrow();
    expect(() => excludeFileMounts({ Mounts: null, HostConfig: { Tmpfs: {} } })).toThrow();
  });
  it("authenticates actual P records without bundle pins and rejects re-signed semantic substitutions", async () => {
    const f = lifecycleFixture();
    try {
      const record = await f.recorder();
      await record("attempt-created", f.attempt);
      f.state.built = true;
      await record("image-built", f.attempt);
      f.state.appPresent = true;
      f.state.volumesPresent = true;
      await record("resources-created", f.attempt);
      const first = f.records()[0];
      const e: ProducerBindings = {
        channel: stat(f.dir, "directory"),
        producerSha256: hash(readFileSync(join(root, "tests/uat/lifecycle-records.ts"))),
        producer: first.producer,
        source: first.source,
        daemon: {
          context: "default",
          endpoint: "unix:///var/run/docker.sock",
          daemonId: f.state.daemon
        },
        lifecycleNonce: f.env.JARVIS_UAT_LIFECYCLE_NONCE,
        attempt: 1,
        project: f.attempt.projectName,
        port: f.attempt.webPort,
        compose: first.attempt.compose,
        imageId: f.imageId,
        imageReference: f.reference,
        containerId: f.id,
        volumes: f.volumes.slice(0, 2).map((v) => ({
          id: v.id,
          role: v.labels["com.docker.compose.volume"],
          destination: "/owned"
        }))
      };
      const snapshot: ProducerSnapshot = {
        channel: e.channel,
        producerSha256: e.producerSha256,
        records: readdirSync(f.dir)
          .sort()
          .map((name) => ({
            name,
            stat: stat(join(f.dir, name), "file"),
            raw: readFileSync(join(f.dir, name), "utf8")
          }))
      };
      expect(authenticateProducerBeforeCopy(e, snapshot).id).toBe(f.id);
      for (const field of [
        "nonce",
        "source",
        "daemon",
        "producer",
        "attempt",
        "image",
        "inventory",
        "complete",
        "phase",
        "residuals",
        "errors"
      ]) {
        const bad = structuredClone(snapshot);
        let previous: string | null = null;
        for (const [i, file] of bad.records.entries()) {
          const body = JSON.parse(file.raw);
          delete body.digest;
          if (i === 2)
            body[field] =
              field === "complete"
                ? true
                : field === "inventory"
                  ? []
                  : field === "errors" || field === "residuals"
                    ? ["bad"]
                    : null;
          body.previousDigest = previous;
          const full = { ...body, digest: digest(body) };
          previous = full.digest;
          (file as { raw: string }).raw = JSON.stringify(full);
        }
        expect(() => authenticateProducerBeforeCopy(e, bad), field).toThrow();
      }
      const bad = structuredClone(snapshot);
      (bad.records[0] as { raw: string }).raw = "SECRET_SENTINEL";
      expect(() => authenticateProducerBeforeCopy(e, bad)).toThrow(/^N3 installed: RED$/);
    } finally {
      f.dispose();
    }
  });
});
