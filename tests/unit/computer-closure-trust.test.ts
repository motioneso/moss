import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import { join } from "node:path";
import {
  loadClosureDeployment,
  revalidateClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { closureFixture, deadClosureProcess } from "./computer-closure-fixture.js";
import type { WatchdogProcessIdentity } from "../../scripts/computer-watchdog/policy.js";
import { signingFixture, projectSigningNode } from "./computer-signing-fixture.js";
import { inspectRoots } from "../../scripts/computer-host/config.js";
import { constructedClosureCapture } from "./computer-closure-capture-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../../scripts/computer-watchdog/trust.js", async (original) => ({
  ...(await original<typeof trust>())
}));
const cleanups: (() => Promise<unknown>)[] = [];
let identities: WatchdogProcessIdentity[];
beforeAll(async () => {
  identities = [];
  for (let i = 0; i < 5; i++) identities.push(await deadClosureProcess());
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real parser/path/key/file logic; disclosed root ownership, runtime and inherited namespace fixtures. */
async function trustedFixture() {
  const f = await closureFixture(identities);
  const nativeUid = process.getuid!();
  cleanups.push(() => f.close());
  vi.spyOn(trust, "assertSupervisorRuntime").mockImplementation(() => {});
  vi.spyOn(trust, "assertNamespaceAnchors").mockResolvedValue();
  vi.spyOn(process, "getuid").mockReturnValue(0);
  projectSigningNode();
  const metadata = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T =>
    Object.assign(stat, {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
    });
  const originalStat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) =>
    metadata(await originalStat(...args))
  );
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementation(async (...args: Parameters<typeof file.stat>) =>
      metadata(await stat(...args))
    );
    const chown = file.chown.bind(file);
    vi.spyOn(file, "chown").mockImplementation((uid, gid) =>
      chown(uid === 0 ? nativeUid : uid, gid)
    );
    return file;
  });
  const originalLink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation(async (path, ...args) =>
    String(path).startsWith("/proc/1/ns/")
      ? originalLink(String(path).replace("/proc/1/", "/proc/self/"), ...args)
      : originalLink(path, ...args)
  );
  const cloned = structuredClone(f.deployment.configuration);
  const config = { ...cloned, supervisor: { ...cloned.supervisor } };
  for (const root of [
    config.supervisor.data,
    config.supervisor.dockerData,
    config.supervisor.monitor,
    config.supervisor.capture!,
    config.receipt
  ])
    root.uid = 0;
  config.captureSha256 = (
    await constructedClosureCapture(
      config,
      await inspectRoots(config.supervisor.host),
      f.journalPath
    )
  ).file.hash;
  const artifact = join(f.root, "verifier.cjs");
  await fs.writeFile(artifact, "/* disclosed artifact fixture */", { mode: 0o600 });
  config.artifactSha256 = trust.sha256(await fs.readFile(artifact));
  const signing = await signingFixture(f.root, config.supervisor, config.netNamespace, artifact);
  expect(await signing.install()).toBe(0);
  const { installationPath, installationSha256, installation } = await signing.read();
  config.installationPath = installationPath;
  config.installationSha256 = installationSha256;
  config.signingKeyPath = installation.signingKeyPath;
  config.publicKeySha256 = installation.publicKeySha256;
  const save = () => fs.writeFile(f.deployment.config.path, JSON.stringify(config));
  await save();
  return {
    f,
    config,
    save,
    artifact,
    signing,
    load: () => loadClosureDeployment(f.deployment.config.path, artifact)
  };
}

describe("post-stop closure trust loader, no installed trust qualification", () => {
  it("loads after all recorded processes exited and revalidates exact artifact/key/config/roots", async () => {
    const t = await trustedFixture();
    const deployment = await t.load();
    await expect(revalidateClosureDeployment(deployment)).resolves.toBeUndefined();
    await fs.writeFile(t.artifact, "changed artifact");
    await expect(revalidateClosureDeployment(deployment)).rejects.toThrow();
  });
  it.each(["signer", "net", "receipt-overlap", "monitor-mode", "host-overlap", "exposed-key"])(
    "refuses %s trust ambiguity",
    async (mode) => {
      const t = await trustedFixture();
      await expect(t.load()).resolves.toBeDefined();
      if (mode === "signer") t.config.publicKeySha256 = "0".repeat(64);
      if (mode === "net") t.config.netNamespace = "net:[1]";
      if (mode === "receipt-overlap") t.config.receipt = { ...t.config.supervisor.monitor };
      if (mode === "monitor-mode") {
        await fs.chmod(t.config.supervisor.monitor.path, 0o750);
        t.config.supervisor.monitor.mode = (await fs.lstat(t.config.supervisor.monitor.path)).mode;
      }
      if (mode === "host-overlap") t.config.supervisor.monitor = { ...t.config.supervisor.data };
      if (mode === "exposed-key") {
        const path = join(t.config.supervisor.data.path, "key.pem");
        await fs.copyFile(t.config.signingKeyPath, path);
        await fs.chmod(path, 0o600);
        t.config.signingKeyPath = path;
      }
      await t.save();
      await expect(t.load()).rejects.toThrow();
    }
  );
  it("refuses same-byte artifact inode replacement", async () => {
    const t = await trustedFixture();
    const deployment = await t.load();
    const bytes = await fs.readFile(t.artifact);
    await fs.rename(t.artifact, t.artifact + ".old");
    await fs.writeFile(t.artifact, bytes, { mode: 0o600 });
    await expect(revalidateClosureDeployment(deployment)).rejects.toThrow();
  });
});
