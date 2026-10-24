import * as fs from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import { loadSigningDeployment } from "../../scripts/computer-signing/config.js";
import { installClosureSigner } from "../../scripts/computer-signing/run.js";
import { parseSigningInstallation } from "../../scripts/computer-signing/installation.js";
import { computerMonotonicMs } from "../../scripts/computer-watchdog/linux.js";
import type { SupervisorConfiguration } from "../../scripts/computer-watchdog/trust.js";
import type { RootIdentity } from "../../scripts/computer-host/config.js";

/** OS ownership/runtime/PID1 and Node bytes are projected; publisher crypto and file I/O run. */
export function projectSigningTrust() {
  const uid = process.getuid!();
  const execArgv = process.execArgv;
  process.execArgv = [];
  const project = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T =>
    Object.assign(stat, {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
    });
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) =>
    project(await lstat(...args))
  );
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementation(async (...args: Parameters<typeof file.stat>) =>
      project(await stat(...args))
    );
    const chown = file.chown.bind(file);
    vi.spyOn(file, "chown").mockImplementation((owner, group) =>
      chown(owner === 0 ? uid : owner, group)
    );
    return file;
  });
  const readlink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation((path, ...args) =>
    readlink(
      String(path).startsWith("/proc/1/ns/")
        ? String(path).replace("/proc/1/", "/proc/self/")
        : path,
      ...args
    )
  );
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  projectSigningNode();
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ])
    vi.stubEnv(key, undefined);
  return () => {
    process.execArgv = execArgv;
    vi.unstubAllEnvs();
  };
}

/** Small Node byte projection avoids repeatedly allocating128MiB; production hashing still runs. */
export function projectSigningNode() {
  const read = trust.boundedFile;
  vi.spyOn(trust, "boundedFile").mockImplementation((path, limit) =>
    path === process.execPath
      ? Promise.resolve(Buffer.from("disclosed native Node hash projection"))
      : read(path, limit)
  );
}

export async function signingFixture(
  root: string,
  supervisor: SupervisorConfiguration,
  netNamespace: string,
  closureArtifactPath: string
) {
  const inputDir = join(root, "signing-input");
  const outputPath = join(root, "signing-output");
  await fs.mkdir(inputDir, { mode: 0o700 });
  await fs.mkdir(outputPath, { mode: 0o700 });
  const { dev, ino, uid, gid, mode } = await fs.lstat(outputPath);
  const output: RootIdentity = { path: outputPath, dev, ino, uid, gid, mode };
  const artifactPath = join(inputDir, "installer.cjs");
  await fs.writeFile(artifactPath, "/* disclosed installer code fixture */", { mode: 0o600 });
  const { lifetime: _lifetime, ...template } = supervisor;
  const request = {
    artifactSha256: trust.sha256(await fs.readFile(artifactPath)),
    supervisor: template,
    closureArtifactPath,
    closureArtifactSha256: trust.sha256(await fs.readFile(closureArtifactPath)),
    nodeSha256: trust.sha256(await trust.boundedFile(process.execPath, 128 * 1024 ** 2)),
    netNamespace,
    output
  };
  const path = join(inputDir, "request.json");
  const save = () => fs.writeFile(path, JSON.stringify(request), { mode: 0o600 });
  await save();
  const load = () => loadSigningDeployment(path, artifactPath);
  const install = async (options: Partial<Parameters<typeof installClosureSigner>[1]> = {}) =>
    installClosureSigner(await load(), {
      startedAtMs: computerMonotonicMs(),
      interrupted: () => false,
      ...options
    });
  const installationPath = join(outputPath, "installation.json");
  const read = async () => {
    const bytes = await fs.readFile(installationPath);
    return {
      installationPath,
      installationSha256: trust.sha256(bytes),
      installation: parseSigningInstallation(JSON.parse(bytes.toString("utf8")))
    };
  };
  return { request, path, save, load, install, read, artifactPath, outputPath, installationPath };
}
