// OS projections only. The unchanged production CJS owns its real lock, journal, capture and timer.
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";

export async function prepareNativeCapture(configPath: string, held: string) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const fixture = JSON.parse(
    await fs.readFile(join(dirname(configPath), "capture-os.json"), "utf8")
  );
  const io = createRequire(configPath)("node:fs/promises") as typeof fs;
  const nativeUid = process.getuid!(),
    nativeGid = process.getgid!();
  const project = <T extends { uid: number | bigint; gid: number | bigint; mode: number | bigint }>(
    s: T
  ): T =>
    Object.assign(s, {
      uid: typeof s.uid === "bigint" ? 0n : 0,
      gid: typeof s.gid === "bigint" ? 1000n : 1000,
      mode: typeof s.mode === "bigint" ? s.mode & ~0o022n : s.mode & ~0o022
    });
  const map = (path: fs.PathLike) =>
    String(path).startsWith("/sys/fs/cgroup") ? fixture.cgRoot + String(path).slice(14) : path;
  const chownPath = io.chown;
  io.chown = (path, uid, gid) =>
    chownPath(path, uid === 0 ? nativeUid : uid, gid === 1000 ? nativeGid : gid);
  const stat = io.lstat;
  io.lstat = (async (...args: Parameters<typeof fs.lstat>) =>
    project(await stat(map(args[0]), ...(args.slice(1) as [])))) as typeof fs.lstat;
  const realpath = io.realpath;
  io.realpath = (async (...args: Parameters<typeof fs.realpath>) =>
    String(args[0]).startsWith("/sys/fs/cgroup")
      ? String(args[0])
      : realpath(...args)) as typeof fs.realpath;
  const statfs = io.statfs;
  io.statfs = (async (...args: Parameters<typeof fs.statfs>) => {
    const result = await statfs(...args);
    if (String(args[0]) === "/sys/fs/cgroup") result.type = 0x63677270n;
    return result;
  }) as typeof fs.statfs;
  let timerStartedAtNs = "";
  const timer = global.setTimeout;
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms === 5000 && !timerStartedAtNs) timerStartedAtNs = process.hrtime.bigint().toString();
    return timer(fn, ms, ...args);
  }) as typeof setTimeout;
  const open = io.open;
  io.open = async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    let actual = map(args[0]);
    if (path.endsWith("/uid_map")) actual = fixture.uidMap;
    if (path === "/proc/self/fdinfo/0") actual = fixture.ownInfo;
    if (path === `/proc/${config.runner.pid}/fdinfo/0`) actual = fixture.heartbeatInfo;
    if (path === process.execPath) actual = fixture.artifact;
    const proc = /^\/proc\/(\d+)\/cgroup$/.exec(path);
    if (proc) actual = fixture.membershipFiles[proc[1]!] ?? fixture.hostGroup;
    const file = await open(actual, args[1], args[2]);
    const originalStat = file.stat.bind(file);
    file.stat = (async (...args: Parameters<typeof file.stat>) =>
      project(await originalStat(...args))) as typeof file.stat;
    const chown = file.chown.bind(file);
    file.chown = (uid, gid) => chown(uid === 0 ? nativeUid : uid, gid === 1000 ? nativeGid : gid);
    if (
      (held === "file" && path.endsWith("/capture.json") && Number(args[1]) & 0o100) ||
      (held === "directory" && path === config.capture.path)
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
  const link = io.readlink;
  io.readlink = (async (path: Parameters<typeof io.readlink>[0], ...args: unknown[]) => {
    const value = String(path);
    if (value.startsWith("/proc/1/ns/"))
      return { ...config.namespaces, ...fixture.namespaces }[value.split("/").at(-1)!];
    if (
      [
        "/proc/self/fd/1",
        "/proc/self/fd/2",
        `/proc/${process.pid}/fd/1`,
        `/proc/${process.pid}/fd/2`
      ].includes(value)
    )
      return "/dev/null";
    if (["/proc/self/fd/0", `/proc/${config.runner.pid}/fd/0`].includes(value))
      return "pipe:[123456]";
    return link(path, ...(args as []));
  }) as typeof io.readlink;
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
}
