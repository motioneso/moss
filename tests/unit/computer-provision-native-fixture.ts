// Disclosed OS trust projection for native tests, loaded before the unchanged production CJS.
// No publisher/consumer function is substituted. Docker remains a recording Unix GET fixture.
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

export async function prepareNativeFixture(configPath: string, held?: string) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const nativeUid = process.getuid!();
  const io = createRequire(configPath)("node:fs/promises") as typeof fs;
  const project = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T =>
    Object.assign(stat, {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
    });
  const originalStat = io.lstat;
  io.lstat = (async (...args: Parameters<typeof fs.lstat>) =>
    project(await originalStat(...args))) as typeof fs.lstat;
  const originalOpen = io.open;
  io.open = async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    const file = await originalOpen(
      path.endsWith("/uid_map")
        ? join(dirname(configPath), "uid-map")
        : path === process.execPath
          ? config.supervisorArtifactPath
          : args[0],
      args[1],
      args[2]
    );
    const stat = file.stat.bind(file);
    file.stat = (async (...args: Parameters<typeof file.stat>) =>
      project(await stat(...args))) as typeof file.stat;
    const chown = file.chown.bind(file);
    file.chown = (uid, gid) => chown(uid === 0 ? nativeUid : uid, gid);
    if (
      (held === "file" && path.endsWith("/supervisor.json") && Number(args[1]) & 0o100) ||
      (held === "directory" && path === config.output.path)
    ) {
      file.sync = () => {
        process.send!("held");
        return new Promise(() => {});
      };
    }
    return file;
  };
  const originalLink = io.readlink;
  io.readlink = (async (path: Parameters<typeof fs.readlink>[0], ...args: unknown[]) => {
    if (String(path).startsWith("/proc/1/ns/"))
      return config.supervisor.namespaces[String(path).split("/").at(-1)!];
    return originalLink(path, ...(args as []));
  }) as typeof fs.readlink;
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
  if (held) {
    const timer = global.setTimeout;
    global.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) =>
      timer(fn, ms === 60000 ? 1000 : ms, ...args)) as typeof setTimeout;
  }
}
