// Disclosed OS ownership/runtime/PID1 and Node-byte projections for unchanged production CJS.
// Actual publisher, crypto, mandatory loader (parent), fsync and final completion callback run.
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

export async function prepareSigningNative(configPath: string, kind: string) {
  const request = JSON.parse(await fs.readFile(configPath, "utf8"));
  const nativeUid = process.getuid!();
  const io = createRequire(configPath)("node:fs/promises") as typeof fs;
  const project = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T =>
    Object.assign(stat, {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
    });
  const lstat = io.lstat;
  io.lstat = (async (...args: Parameters<typeof fs.lstat>) =>
    project(await lstat(...args))) as typeof fs.lstat;
  let timerStartedAtNs = "";
  let keyWritten = false;
  const open = io.open;
  io.open = async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    const file = await open(
      path === process.execPath ? join(dirname(configPath), "node-bytes") : args[0],
      args[1],
      args[2]
    );
    const stat = file.stat.bind(file);
    file.stat = (async (...args: Parameters<typeof file.stat>) =>
      project(await stat(...args))) as typeof file.stat;
    const chown = file.chown.bind(file);
    file.chown = (uid, gid) => chown(uid === 0 ? nativeUid : uid, gid);
    const writingKey = path.endsWith("/closure-key.pem") && Boolean(Number(args[1]) & 0o100);
    if (writingKey) keyWritten = true;
    if (
      (kind === "file" && writingKey) ||
      (kind === "directory" && keyWritten && path === request.output.path)
    ) {
      file.sync = () => {
        process.send!({
          type: "held",
          timerStartedAtNs,
          heldAtNs: process.hrtime.bigint().toString()
        });
        return new Promise(() => {});
      };
    }
    return file;
  };
  const readlink = io.readlink;
  io.readlink = ((path: Parameters<typeof fs.readlink>[0], ...args: []) =>
    readlink(
      String(path).startsWith("/proc/1/ns/")
        ? String(path).replace("/proc/1/", "/proc/self/")
        : path,
      ...args
    )) as typeof fs.readlink;
  process.getuid = () => 0;
  process.geteuid = () => 0;
  process.execArgv = [];
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ])
    delete process.env[key];
  const held = kind === "file" || kind === "directory";
  const timer = global.setTimeout;
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms === 60000) timerStartedAtNs = process.hrtime.bigint().toString();
    return timer(fn, held && ms === 60000 ? 2000 : ms, ...args);
  }) as typeof setTimeout;
  if (kind === "equality" || kind === "signal") {
    const hrtime = process.hrtime.bigint;
    let startedAt: bigint | undefined;
    let expired = false;
    process.hrtime.bigint = () => {
      startedAt ??= hrtime();
      return expired ? startedAt + 60_000_000_000n : hrtime();
    };
    const then = Promise.prototype.then;
    Promise.prototype.then = function (this: Promise<unknown>, fulfilled, rejected) {
      if (fulfilled?.toString().includes("process.exit(success ? 0 : 2)")) {
        const callback = fulfilled;
        fulfilled = (value) => {
          process.send!({ type: "final-callback", value, kind });
          if (kind === "equality") expired = true;
          else process.emit("SIGTERM");
          return callback(value);
        };
      }
      return then.call(this, fulfilled, rejected);
    } as typeof Promise.prototype.then;
  }
}
