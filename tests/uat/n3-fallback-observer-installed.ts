import {
  IGNORE_SHA256,
  SOURCE_FILES,
  BUNDLE,
  INSTALLED_PATHS,
  singleFileTar,
  excludeFileMounts,
  authenticateProducerBeforeCopy
} from "./n3-fallback-observer-installed-evidence.js";
export {
  K,
  IGNORE_SHA256,
  SOURCE_FILES,
  BUNDLE,
  INSTALLED_PATHS
} from "./n3-fallback-observer-installed-evidence.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { InstalledReads, type ReadIO } from "./n3-fallback-observer-installed-reads.js";
import {
  N3ObserverConsumer,
  NATIVE_BRIDGE,
  validateProducer,
  type BridgeBirth,
  type BridgeEvents,
  type BridgeSpec,
  type ConsumerCollectors,
  type ExpectedBindings,
  type FileIdentity,
  type InstallationObservation,
  type OwnedBridge,
  type ProducerSnapshot,
  type SourceFreeze
} from "./n3-fallback-observer-runner.js";
import { n3ObserverEnv, type N3ObserverOption, type N3Prepared } from "./provisioner-options.js";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
const hex = /^[a-f0-9]{64}$/;
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
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = object(a),
      right = object(b);
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((k) => Object.hasOwn(right, k) && same(left[k], right[k]))
    );
  }
  return false;
};
export interface BuildObservation {
  attach(child: ChildProcess): void;
  readonly closed: Promise<void>;
}
export interface N3BuildEvidence {
  validateObserver(option: N3ObserverOption | undefined, prepared: N3Prepared | undefined): void;
  observeBuild(command: string, args: readonly string[], cwd: string): Promise<BuildObservation>;
  beforeInitialStart(input: { readonly projectName: string }): Promise<void>;
}
export interface InstalledIO extends ReadIO {
  readonly retain: (child: ChildProcess) => void;
}
type Authority = Omit<
  ExpectedBindings,
  "containerId" | "imageId" | "bundleSha256" | "files" | "buildCommand" | "buildReceiptSha256"
>;
interface BuildReceipt {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly source: SourceFreeze;
  readonly daemon: ExpectedBindings["daemon"];
  readonly birth: BridgeBirth;
  readonly imageId: string;
  readonly rawExitCode: 0;
  readonly signal: null;
  readonly closed: true;
}
interface Baseline {
  readonly id: string;
  readonly image: string;
  readonly files: Readonly<Record<string, string>>;
  readonly inspections: readonly string[];
  readonly copies: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly archiveBytes: number;
  }[];
}

/** No work, timers, filesystem reads or children occur during construction. */
export class InstalledCollector implements N3BuildEvidence {
  private readonly authority: Authority;
  private readonly io: Pick<InstalledIO, "spawn" | "now" | "retain">;
  private build?: BuildReceipt;
  private baseline?: Baseline;
  private validated = false;
  private preparing = false;
  private readonly reads: InstalledReads;
  private poisoned = false;
  private env?: NodeJS.ProcessEnv;
  private initialInfo?: Record<string, unknown>;
  private creation?: Record<string, unknown>;
  readonly retained = new Set<ChildProcess>();
  constructor(
    authority: Authority,
    readonly channelPath: string,
    io: Partial<InstalledIO> = {}
  ) {
    this.authority = structuredClone(authority);
    this.io = { spawn, now: Date.now, retain: () => {}, ...io };
    this.reads = new InstalledReads(
      {
        source: this.authority.source,
        daemon: this.authority.daemon,
        channel: this.authority.channel,
        channelPath,
        project: this.authority.project,
        imageReference: this.authority.imageReference,
        volumes: this.authority.volumes,
        nonce: this.authority.option.nonce,
        ignoreSha256: IGNORE_SHA256,
        sourceFiles: SOURCE_FILES
      },
      {
        deadline: this.authority.option.deadline,
        checkpoint: () => this.healthy(),
        refuse: () => this.fail(),
        retain: (child) => this.keep(child),
        releaseClosed: (child) => {
          this.healthy();
          this.retained.delete(child);
        },
        environment: () => this.env
      },
      io
    );
  }
  private healthy() {
    check(!this.poisoned && this.io.now() < this.authority.option.deadline);
  }
  private fail(): never {
    this.poisoned = true;
    return red();
  }
  private keep(child: ChildProcess) {
    this.retained.add(child);
    this.io.retain(child);
  }
  private async bounded<T>(pending: Promise<T>): Promise<T> {
    this.healthy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.poisoned = true;
            reject(new Error("N3 installed: RED"));
          }, this.authority.option.deadline - this.io.now());
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async source(): Promise<SourceFreeze> {
    const observed = await this.reads.source();
    check(same(observed, this.authority.source));
    return observed;
  }
  private async daemon(): Promise<ExpectedBindings["daemon"]> {
    const observed = await this.reads.daemon();
    check(same(observed, this.authority.daemon));
    return observed;
  }
  validateObserver(option: N3ObserverOption | undefined, prepared: N3Prepared | undefined) {
    try {
      this.healthy();
      check(!this.validated && prepared && same(option, this.authority.option));
      check(
        this.authority.producerSha256 === SOURCE_FILES["/app/tests/uat/lifecycle-records.ts"]![0]
      );
      check(
        this.authority.option.bootstrapSha256 ===
          SOURCE_FILES["/app/tests/uat/n3-fallback-observer-bootstrap.mjs"]![0]
      );
      check(
        this.authority.channel.type === "directory" &&
          this.authority.channel.mode === 0o700 &&
          Number.isSafeInteger(this.authority.channel.uid) &&
          this.authority.channel.inode > 0
      );
      prepared.checkDeadline();
      this.validated = true;
    } catch {
      this.fail();
    }
  }
  async observeBuild(
    command: string,
    args: readonly string[],
    cwd: string
  ): Promise<BuildObservation> {
    try {
      this.healthy();
      check(this.validated && !this.preparing && !this.build);
      this.preparing = true;
      this.env = Object.freeze({ ...process.env });
      check(cwd === this.authority.source.root.path && command === "docker");
      check(same(args, ["build", "-t", this.authority.imageReference, "-f", "Dockerfile", "."]));
      const source = await this.source(),
        daemon = await this.daemon();
      this.healthy();
      let attach: ((child: ChildProcess) => void) | undefined;
      const closed = new Promise<void>((resolve, reject) => {
        let attached = false;
        attach = (child) => {
          try {
            this.keep(child);
            this.healthy();
            check(!attached);
            attached = true;
            const birth = this.reads.childBirth(child);
            let code: number | null | undefined, signal: NodeJS.Signals | null | undefined;
            child.once("error", () => {
              this.poisoned = true;
              reject(new Error("N3 installed: RED"));
            });
            child.once("exit", (c, s) => {
              code = c;
              signal = s;
            });
            child.once("close", (c, s) => {
              void (async () => {
                this.healthy();
                check(code === 0 && signal === null && c === code && s === signal);
                check(child.pid === birth.pid);
                await this.source();
                await this.daemon();
                this.healthy();
                const imageId = await this.reads.originalImageId();
                check(/^sha256:[a-f0-9]{64}$/.test(imageId));
                this.healthy();
                this.build = Object.freeze({
                  command: [command, ...args],
                  cwd,
                  source,
                  daemon,
                  birth,
                  imageId,
                  rawExitCode: 0,
                  signal: null,
                  closed: true
                });
                this.retained.delete(child);
                resolve();
              })().catch(() => {
                this.poisoned = true;
                reject(new Error("N3 installed: RED"));
              });
            });
          } catch {
            this.poisoned = true;
            reject(new Error("N3 installed: RED"));
          }
        };
      });
      const bounded = this.bounded(closed);
      void bounded.catch(() => {});
      return { attach: (child) => attach!(child), closed: bounded };
    } catch {
      return this.fail();
    }
  }
  private async inspect(id: string) {
    check(hex.test(id));
    return object(await this.reads.containerInfo(id));
  }
  private async volumes(info: Record<string, unknown>) {
    const mounts = info.Mounts as Record<string, unknown>[];
    for (const [role, destination] of [
      ["jarv1s-cli-auth", "/data/cli-auth"],
      ["jarv1s-cli-socket", "/run/jarv1s"]
    ]) {
      const expected = this.authority.volumes.filter(
        (v) => v.role === role && v.destination === destination
      );
      check(expected.length === 1);
    }
    for (const v of this.authority.volumes) {
      const matches = mounts.filter((m) => m.Destination === v.destination);
      check(
        matches.length === 1 &&
          matches[0]!.Type === "volume" &&
          matches[0]!.Name === v.id &&
          v.id === `${this.authority.project}_${v.role}`
      );
      const observed = object(await this.reads.ownedVolumeInfo(v.id));
      const labels = object(observed.Labels);
      check(
        observed.Name === v.id &&
          observed.Driver === "local" &&
          labels["com.docker.compose.project"] === this.authority.project &&
          labels["com.docker.compose.volume"] === v.role
      );
    }
  }
  private async gate(id: string, final: boolean): Promise<Record<string, unknown>> {
    await this.source();
    await this.daemon();
    const info = await this.inspect(id),
      config = object(info.Config),
      state = object(info.State),
      labels = object(config.Labels);
    check(
      info.Id === id && typeof info.Image === "string" && /^sha256:[a-f0-9]{64}$/.test(info.Image)
    );
    check(
      config.Image === this.authority.imageReference &&
        labels["com.docker.compose.project"] === this.authority.project &&
        labels["com.docker.compose.service"] === "jarv1s"
    );
    check(
      state.Status === "created" &&
        state.Running === false &&
        state.Pid === 0 &&
        state.StartedAt === "0001-01-01T00:00:00Z"
    );
    check(typeof info.Created === "string" && Number.isFinite(Date.parse(info.Created)));
    check(
      this.creation &&
        info.Created === this.creation.created &&
        info.Name === `/${String(this.creation.name).replace(/^\//, "")}`
    );
    const creationLabels = object(this.creation.labels);
    for (const [key, value] of Object.entries(creationLabels)) check(labels[key] === value);
    excludeFileMounts(info);
    await this.volumes(info);
    const image = await this.reads.originalImageId();
    check(image === info.Image && image === this.build?.imageId);
    check(
      Array.isArray(config.Env) &&
        config.Env.length <= 4096 &&
        config.Env.every((v) => typeof v === "string")
    );
    for (const line of n3ObserverEnv(this.authority.option, undefined, {})) {
      const key = line.slice(0, line.indexOf("=") + 1);
      check(config.Env.filter((v) => (v as string).startsWith(key)).join() === line);
    }
    check((await this.reads.emptyDiffBytes(id)).length === 0);
    // The last asynchronous read is a fresh exact-container inspect, not an earlier snapshot.
    const last = await this.inspect(id);
    const stable = (value: Record<string, unknown>) => {
      const host = object(value.HostConfig);
      return { ...value, Mounts: undefined, HostConfig: { ...host, Tmpfs: undefined } };
    };
    check(same(stable(last), stable(info)));
    excludeFileMounts(last);
    const lastMounts = last.Mounts as Record<string, unknown>[];
    for (const v of this.authority.volumes) {
      const found = lastMounts.filter((m) => m.Destination === v.destination);
      check(found.length === 1 && found[0]!.Type === "volume" && found[0]!.Name === v.id);
    }
    if (final) check(same(stable(last), stable(this.initialInfo!)));
    this.healthy();
    return last;
  }
  async beforeInitialStart({ projectName }: { readonly projectName: string }): Promise<void> {
    try {
      this.healthy();
      check(this.build && !this.baseline && projectName === this.authority.project);
      const id = await this.reads.originalContainerId();
      check(hex.test(id));
      this.inventoryBeforeCopy(id);
      this.initialInfo = await this.gate(id, false);
      const files: Record<string, string> = {},
        copies: { path: string; sha256: string; archiveBytes: number }[] = [];
      let total = 0;
      for (const path of INSTALLED_PATHS) {
        const archive = await this.reads.copyInstalledFile(id, path);
        total += archive.length;
        check(total <= 80 * 1024 * 1024);
        const bytes = singleFileTar(archive, path),
          sha256 = hash(bytes);
        if (path !== BUNDLE) {
          const expected = SOURCE_FILES[path]!;
          check(bytes.length === expected[1] && sha256 === expected[0]);
          const source = this.reads.sourceBytes(path);
          check(source.length === expected[1] && hash(source) === sha256);
        }
        files[path] = sha256;
        copies.push({ path, sha256, archiveBytes: archive.length });
      }
      check(files["/app/tests/uat/lifecycle-records.ts"] === this.authority.producerSha256);
      const initialDigest = digest(this.initialInfo);
      const final = await this.gate(id, true);
      this.baseline = Object.freeze({
        id,
        image: String(final.Image),
        files: Object.freeze(files),
        inspections: [initialDigest, digest(final)],
        copies
      });
      this.healthy();
    } catch {
      this.fail();
    }
  }
  private expected(): ExpectedBindings {
    this.healthy();
    check(this.build && this.baseline);
    return {
      ...this.authority,
      containerId: this.baseline.id,
      imageId: this.baseline.image,
      bundleSha256: this.baseline.files[BUNDLE]!,
      files: this.baseline.files,
      buildCommand: this.build.command,
      buildReceiptSha256: digest(this.build)
    };
  }
  // Bounded reads do not follow a replacement symlink or allocate from a supplied size.
  private async producer(deadline: number): Promise<ProducerSnapshot> {
    this.healthy();
    check(deadline === this.authority.option.deadline);
    const snapshot = this.reads.producerSnapshot();
    validateProducer(this.expected(), snapshot);
    return snapshot;
  }
  // Authenticate the existing P chain before any new cp; no unknown bundle pins are invented.
  private inventoryBeforeCopy(id: string): void {
    check(this.build);
    const snapshot = this.reads.producerSnapshot();
    this.creation = authenticateProducerBeforeCopy(
      { ...this.authority, containerId: id, imageId: this.build.imageId },
      snapshot
    );
    this.healthy();
  }
  private async installation(deadline: number): Promise<InstallationObservation> {
    try {
      this.healthy();
      check(deadline === this.authority.option.deadline);
      const e = this.expected(),
        info = await this.inspect(e.containerId);
      check(
        info.Id === e.containerId &&
          info.Image === e.imageId &&
          object(info.Config).Image === e.imageReference &&
          object(info.State).Running === true
      );
      excludeFileMounts(info);
      await this.volumes(info);
      const files: Record<string, string> = {};
      for (const path of INSTALLED_PATHS) {
        const raw = (await this.reads.installedSha256(e.containerId, path)).toString();
        check(raw === `${e.files[path]}  ${path}\n`);
        files[path] = raw.slice(0, 64);
      }
      const api = object(await this.reads.apiMetadata(e.containerId));
      const db = (await this.reads.dbMetadata(e.containerId)).toString().trim();
      check(db === "owned-compose-postgres" && same(e.dbBoundary, { endpoint: db }));
      const source = await this.source(),
        daemon = await this.daemon();
      this.healthy();
      return {
        containerId: e.containerId,
        imageId: e.imageId,
        imageReference: e.imageReference,
        source,
        daemon,
        files,
        bootstrapSha256: files["/app/tests/uat/n3-fallback-observer-bootstrap.mjs"]!,
        bundleSha256: files[BUNDLE]!,
        volumes: e.volumes,
        dbBoundary: { endpoint: db },
        apis: api.apis as InstallationObservation["apis"],
        socketDirectory: api.socketDirectory as FileIdentity,
        socket: api.socket as FileIdentity,
        build: {
          command: this.build!.command,
          exitCode: 0,
          rawExitCode: this.build!.rawExitCode,
          completed: this.build!.closed,
          source: this.build!.source,
          imageId: e.imageId,
          bundleSha256: e.bundleSha256,
          bootstrapSha256: e.option.bootstrapSha256,
          receiptSha256: digest(this.build)
        }
      };
    } catch {
      return this.fail();
    }
  }
  private bridge(spec: BridgeSpec, events: BridgeEvents): OwnedBridge {
    try {
      this.healthy();
      const e = this.expected();
      check(
        spec.command === "docker" &&
          spec.deadline === e.option.deadline &&
          same(spec.daemon, e.daemon)
      );
      check(
        same(spec.args, [
          "exec",
          "-i",
          e.containerId,
          "node",
          "-e",
          NATIVE_BRIDGE,
          `/run/jarv1s/n3-${e.option.nonce}/observer.sock`,
          String(e.option.deadline)
        ])
      );
      const child = this.io.spawn("docker", [...spec.args], {
        cwd: e.source.root.path,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.keep(child);
      const birth = this.reads.childBirth(child);
      let code: number | null | undefined,
        signal: NodeJS.Signals | null | undefined,
        total = 0;
      const timer = setTimeout(() => {
        this.poisoned = true;
        events.failure();
      }, e.option.deadline - this.io.now());
      child.stdout!.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > 65536) {
          this.poisoned = true;
          events.failure();
        } else events.data(chunk);
      });
      child.stderr!.on("data", () => {
        this.poisoned = true;
        events.failure();
      });
      child.once("error", () => {
        this.poisoned = true;
        events.failure();
      });
      child.once("exit", (c, s) => {
        code = c;
        signal = s;
      });
      child.once("close", (c, s) => {
        clearTimeout(timer);
        if (
          code !== 0 ||
          signal !== null ||
          c !== code ||
          s !== signal ||
          this.io.now() >= e.option.deadline ||
          this.poisoned
        ) {
          this.poisoned = true;
          return events.failure();
        }
        this.retained.delete(child);
        events.closed({ birth, exitCode: 0 });
      });
      return {
        birth,
        write: (frame) => {
          this.healthy();
          check(Buffer.byteLength(frame) <= 4096);
          try {
            return child.stdin!.write(frame);
          } catch {
            return this.fail();
          }
        },
        end: () => {
          this.healthy();
          try {
            child.stdin!.end();
          } catch {
            this.fail();
          }
        }
      };
    } catch {
      return this.fail();
    }
  }
  receipts(): Readonly<{ build: BuildReceipt; baseline: Baseline }> {
    this.healthy();
    check(this.build && this.baseline);
    return structuredClone({ build: this.build, baseline: this.baseline });
  }
  compose(): {
    readonly expected: ExpectedBindings;
    readonly collectors: ConsumerCollectors;
    readonly consumer: N3ObserverConsumer;
  } {
    const expected = this.expected();
    const collectors: ConsumerCollectors = {
      producer: async (d) => {
        try {
          return await this.producer(d);
        } catch {
          return this.fail();
        }
      },
      installation: (d) => this.installation(d),
      bridge: (s, e) => this.bridge(s, e)
    };
    return { expected, collectors, consumer: new N3ObserverConsumer(expected, collectors) };
  }
}
