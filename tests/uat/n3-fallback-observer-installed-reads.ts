import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  opendirSync,
  realpathSync
} from "node:fs";
import { join } from "node:path";
import { buildUatComposeArgs } from "./compose-args.js";
import type {
  BridgeBirth,
  ExpectedBindings,
  FileIdentity,
  ProducerSnapshot,
  SourceFreeze
} from "./n3-fallback-observer-runner.js";

export interface ReadIO {
  readonly spawn: typeof spawn;
  readonly open: typeof openSync;
  readonly close: typeof closeSync;
  readonly fstat: typeof fstatSync;
  readonly read: typeof readSync;
  readonly lstat: typeof lstatSync;
  readonly opendir: typeof opendirSync;
  readonly realpath: typeof realpathSync;
  readonly now: () => number;
}
export interface ReadBoundary {
  readonly deadline: number;
  readonly checkpoint: () => void;
  readonly refuse: () => never;
  readonly retain: (child: ChildProcess) => void;
  readonly releaseClosed: (child: ChildProcess) => void;
  readonly environment: () => Readonly<NodeJS.ProcessEnv> | undefined;
}
export interface ReadPins {
  readonly source: SourceFreeze;
  readonly daemon: ExpectedBindings["daemon"];
  readonly channel: FileIdentity;
  readonly channelPath: string;
  readonly project: string;
  readonly imageReference: string;
  readonly volumes: ExpectedBindings["volumes"];
  readonly nonce: string;
  readonly ignoreSha256: string;
  readonly sourceFiles: Readonly<Record<string, readonly [string, number]>>;
}
const metadataCap = 256 * 1024;
const bundle = "/app/dist/server.js";
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
const rounded = (v: number) => Math.ceil(v / 512) * 512;
const dockerKeys = [
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION"
];

export const DB_READER = String.raw`
const roles = ['BOOTSTRAP', 'MIGRATION', 'APP', 'AUTH', 'WORKER'];
for (const role of roles) {
  const u = new URL(process.env['MOSS_' + role + '_DATABASE_URL'] ?? process.env['JARVIS_' + role + '_DATABASE_URL']);
  if (u.hostname !== 'postgres' || u.port !== '5432' || u.pathname !== '/jarv1s') process.exit(1);
}
console.log('owned-compose-postgres');
`;
export const API_READER = String.raw`
const fs = require('node:fs'), path = require('node:path');
function bounded(p, cap) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const data = Buffer.alloc(cap + 1);
    let size = 0;
    while (size < data.length) {
      const count = fs.readSync(fd, data, size, data.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > cap) process.exit(1);
    return data.subarray(0, size).toString();
  } finally {
    fs.closeSync(fd);
  }
}
const nonce = process.argv[1], containerId = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(containerId)) process.exit(1);
const bootId = bounded('/proc/sys/kernel/random/boot_id', 128).trim();
const directory = fs.opendirSync('/proc');
const apis = [];
let count = 0;
try {
  for (let entry; (entry = directory.readSync()) !== null;) {
    if (++count > 65536) process.exit(1);
    const pid = entry.name;
    if (!/^[0-9]+$/.test(pid)) continue;
    try {
      const argv = bounded('/proc/' + pid + '/cmdline', 65536).split('\0');
      const cwd = fs.realpathSync('/proc/' + pid + '/cwd');
      if (!argv[1] || fs.realpathSync(path.resolve(cwd, argv[1])) !== '/app/dist/server.js') continue;
      const raw = bounded('/proc/' + pid + '/stat', 16384);
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      apis.push({pid: Number(pid), startTicks: fields[19], bootId, containerId, resolvedEntry: '/app/dist/server.js'});
      if (apis.length > 1) process.exit(1);
    } catch (e) {
      if (!['ENOENT', 'EACCES', 'ESRCH'].includes(e.code)) process.exit(1);
    }
  }
} finally {
  directory.closeSync();
}
function identity(p, type) {
  const s = fs.lstatSync(p);
  if (fs.realpathSync(p) !== p || !(type === 'socket' ? s.isSocket() : s.isDirectory())) process.exit(1);
  return {device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 511, type};
}
const dir = '/run/jarv1s/n3-' + nonce;
if (apis.length !== 1) process.exit(1);
console.log(JSON.stringify({apis, socketDirectory: identity(dir, 'directory'), socket: identity(dir + '/observer.sock', 'socket')}));
`;

/** Only closed read operations are public; construction merely stores dependencies. */
export class InstalledReads {
  private readonly io: ReadIO;
  private busy = false;
  constructor(
    private readonly pins: ReadPins,
    private readonly boundary: ReadBoundary,
    io: Partial<ReadIO> = {}
  ) {
    this.io = {
      spawn,
      open: openSync,
      close: closeSync,
      fstat: fstatSync,
      read: readSync,
      lstat: lstatSync,
      opendir: opendirSync,
      realpath: realpathSync,
      now: Date.now,
      ...io
    };
  }
  private check(value: unknown): asserts value {
    if (!value) this.boundary.refuse();
    this.boundary.checkpoint();
  }
  private id(id: string): string {
    this.check(/^[a-f0-9]{64}$/.test(id));
    return id;
  }
  private cap(path: string): number {
    const cap = path === bundle ? 64 * 1024 * 1024 : this.pins.sourceFiles[path]?.[1];
    this.check(Number.isSafeInteger(cap) && Number(cap) >= 0);
    return cap!;
  }
  private json(bytes: Buffer): unknown {
    try {
      return JSON.parse(bytes.toString()) as unknown;
    } catch {
      return this.boundary.refuse();
    }
  }
  private file(path: string, cap: number, regular: boolean): Buffer {
    this.boundary.checkpoint();
    this.check(Number.isSafeInteger(cap) && cap >= 0);
    const before = this.io.lstat(path);
    this.check(this.io.realpath(path) === path && before.isFile());
    if (regular) this.check(before.size <= cap);
    const fd = this.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = this.io.fstat(fd);
      this.check(
        opened.isFile() &&
          opened.dev === before.dev &&
          opened.ino === before.ino &&
          opened.size === before.size
      );
      const data = Buffer.alloc((regular ? before.size : cap) + 1);
      let size = 0;
      while (size < data.length) {
        this.boundary.checkpoint();
        const count = this.io.read(fd, data, size, data.length - size, null);
        if (count === 0) break;
        size += count;
      }
      const after = this.io.fstat(fd),
        current = this.io.lstat(path);
      this.check(size <= cap && (!regular || size === before.size));
      this.check(
        after.size === before.size &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          current.dev === before.dev &&
          current.ino === before.ino &&
          current.size === before.size
      );
      this.check(this.io.realpath(path) === path);
      return data.subarray(0, size);
    } catch {
      return this.boundary.refuse();
    } finally {
      this.io.close(fd);
    }
  }
  childBirth(child: ChildProcess): BridgeBirth {
    this.check(Number.isSafeInteger(child.pid) && Number(child.pid) > 0);
    const pid = child.pid!;
    const raw = this.file(`/proc/${pid}/stat`, 16384, false).toString();
    this.check(raw.startsWith(`${pid} (`) && raw.lastIndexOf(")") > 0);
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const birth = {
      pid,
      startTicks: fields[19]!,
      group: Number(fields[2]),
      session: Number(fields[3]),
      bootId: this.file("/proc/sys/kernel/random/boot_id", 128, false).toString().trim()
    };
    this.check(
      /^[0-9]{1,24}$/.test(birth.startTicks) &&
        Number.isSafeInteger(birth.group) &&
        birth.group > 0 &&
        Number.isSafeInteger(birth.session) &&
        birth.session > 0 &&
        /^[a-f0-9-]{36}$/.test(birth.bootId)
    );
    return Object.freeze(birth);
  }
  private async capture(
    command: "git" | "docker",
    args: readonly string[],
    cap = metadataCap
  ): Promise<Buffer> {
    this.boundary.checkpoint();
    this.check(!this.busy);
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = new Promise<Buffer>((resolve, reject) => {
        const child = this.io.spawn(command, [...args], {
          cwd: this.pins.source.root.path,
          env: this.boundary.environment(),
          stdio: ["ignore", "pipe", "pipe"]
        });
        this.boundary.retain(child);
        let total = 0,
          errors = 0;
        let code: number | null | undefined, signal: NodeJS.Signals | null | undefined;
        const chunks: Buffer[] = [];
        const refuse = () => {
          try {
            this.boundary.refuse();
          } catch {
            reject(new Error("N3 installed: RED"));
          }
        };
        child.stdout!.on("data", (raw: Buffer) => {
          total += raw.length;
          if (total > cap) refuse();
          else chunks.push(raw);
        });
        child.stderr!.on("data", (raw: Buffer) => {
          errors += raw.length;
          if (errors > metadataCap) refuse();
        });
        child.once("error", refuse);
        child.once("exit", (c, s) => {
          code = c;
          signal = s;
        });
        child.once("close", (c, s) => {
          try {
            this.check(code === 0 && signal === null && c === code && s === signal);
            this.boundary.releaseClosed(child);
            resolve(Buffer.concat(chunks));
          } catch {
            refuse();
          }
        });
        try {
          this.childBirth(child);
        } catch {
          refuse();
        }
      });
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            try {
              this.boundary.refuse();
            } catch {
              reject(new Error("N3 installed: RED"));
            }
          },
          Math.min(2147483647, this.boundary.deadline - this.io.now())
        );
      });
      const result = await Promise.race([pending, expiry]);
      this.boundary.checkpoint();
      return result;
    } catch {
      return this.boundary.refuse();
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
  async source(): Promise<SourceFreeze> {
    const root = this.pins.source.root.path;
    this.check(this.io.realpath(root) === root);
    const stat = this.io.lstat(root);
    this.check(stat.isDirectory());
    const git = async (...args: string[]) => (await this.capture("git", args)).toString().trim();
    const commit = await git("rev-parse", "HEAD"),
      tree = await git("rev-parse", "HEAD^{tree}");
    this.check(/^[a-f0-9]{40}$/.test(commit) && /^[a-f0-9]{40}$/.test(tree));
    this.check(!(await git("status", "--porcelain", "--untracked-files=normal")));
    this.check((await git("rev-parse", "--show-toplevel")) === root);
    const buildFiles = ["Dockerfile", ".dockerignore"].map((path) => ({
      path: join(root, path),
      sha256: hash(this.file(join(root, path), metadataCap, true))
    }));
    this.check(buildFiles[1]!.sha256 === this.pins.ignoreSha256);
    return {
      commit,
      tree,
      inputFingerprint: digest({ commit, tree, buildFiles }),
      root: { path: root, device: stat.dev, inode: stat.ino }
    };
  }
  async daemon(): Promise<ExpectedBindings["daemon"]> {
    const env = this.boundary.environment();
    this.check(env && dockerKeys.every((k) => process.env[k] === env[k]));
    const context = (await this.capture("docker", ["context", "show"])).toString().trim();
    this.check(
      context.length > 0 && context.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)
    );
    const endpoint = this.json(
      await this.capture("docker", [
        "context",
        "inspect",
        context,
        "--format",
        "{{json .Endpoints.docker.Host}}"
      ])
    );
    const daemonId = this.json(await this.capture("docker", ["info", "--format", "{{json .ID}}"]));
    this.check(
      typeof endpoint === "string" &&
        typeof daemonId === "string" &&
        endpoint.length > 0 &&
        daemonId.length > 0
    );
    return { context, endpoint, daemonId };
  }
  sourceBytes(installedKey: string): Buffer {
    this.check(
      Object.hasOwn(this.pins.sourceFiles, installedKey) && installedKey.startsWith("/app/")
    );
    return this.file(
      join(this.pins.source.root.path, installedKey.slice(5)),
      this.cap(installedKey),
      true
    );
  }
  private identity(path: string, type: FileIdentity["type"]): FileIdentity {
    this.boundary.checkpoint();
    const stat = this.io.lstat(path);
    this.check(
      this.io.realpath(path) === path && (type === "directory" ? stat.isDirectory() : stat.isFile())
    );
    return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777, type };
  }
  producerSnapshot(): ProducerSnapshot {
    const channel = this.identity(this.pins.channelPath, "directory");
    const keys = ["device", "inode", "uid", "mode", "type"] as const;
    this.check(
      [channel, this.pins.channel].every(
        (value) =>
          Reflect.ownKeys(value).length === keys.length &&
          keys.every(
            (key) =>
              Object.hasOwn(value, key) &&
              typeof value[key] === (key === "type" ? "string" : "number")
          )
      ) && keys.every((key) => channel[key] === this.pins.channel[key])
    );
    const directory = this.io.opendir(this.pins.channelPath);
    const names: string[] = [];
    try {
      for (let entry; (entry = directory.readSync()) !== null; ) {
        this.check(names.length < 4096 && /^[0-9]{6}\.json$/.test(entry.name));
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    const records = names.sort().map((name) => {
      const path = join(this.pins.channelPath, name),
        stat = this.identity(path, "file");
      const raw = this.file(path, metadataCap, true).toString();
      this.check(digest(stat) === digest(this.identity(path, "file")));
      return { name, stat, raw };
    });
    const producerSha256 = hash(this.sourceBytes("/app/tests/uat/lifecycle-records.ts"));
    this.check(digest(channel) === digest(this.identity(this.pins.channelPath, "directory")));
    return { channel, producerSha256, records };
  }
  async originalContainerId(): Promise<string> {
    return this.id(
      (
        await this.capture(
          "docker",
          buildUatComposeArgs(this.pins.project, ["ps", "-a", "-q", "jarv1s"])
        )
      )
        .toString()
        .trim()
    );
  }
  async containerInfo(id: string): Promise<unknown> {
    return this.json(
      await this.capture("docker", ["container", "inspect", this.id(id), "--format", "{{json .}}"])
    );
  }
  async originalImageId(): Promise<string> {
    return (
      await this.capture("docker", [
        "image",
        "inspect",
        this.pins.imageReference,
        "--format",
        "{{.Id}}"
      ])
    )
      .toString()
      .trim();
  }
  async ownedVolumeInfo(id: string): Promise<unknown> {
    this.check(this.pins.volumes.some((v) => v.id === id));
    return this.json(
      await this.capture("docker", ["volume", "inspect", id, "--format", "{{json .}}"])
    );
  }
  emptyDiffBytes(id: string): Promise<Buffer> {
    return this.capture("docker", ["diff", this.id(id)]);
  }
  copyInstalledFile(id: string, key: string): Promise<Buffer> {
    const cap = this.cap(key);
    return this.capture("docker", ["cp", `${this.id(id)}:${key}`, "-"], 512 + rounded(cap) + 16384);
  }
  installedSha256(id: string, key: string): Promise<Buffer> {
    this.cap(key);
    return this.capture("docker", ["exec", this.id(id), "sha256sum", key]);
  }
  async apiMetadata(id: string): Promise<unknown> {
    return this.json(
      await this.capture("docker", [
        "exec",
        this.id(id),
        "node",
        "-e",
        API_READER,
        this.pins.nonce,
        id
      ])
    );
  }
  dbMetadata(id: string): Promise<Buffer> {
    return this.capture("docker", ["exec", this.id(id), "node", "-e", DB_READER]);
  }
}
