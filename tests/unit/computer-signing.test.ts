import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";
import { ProvisionPublication } from "../../scripts/computer-provision/publication.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import {
  loadClosureDeployment,
  revalidateClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { installClosureSigner } from "../../scripts/computer-signing/run.js";
import { parseSigningConfiguration } from "../../scripts/computer-signing/config.js";
import { parseSigningInstallation } from "../../scripts/computer-signing/installation.js";
import { closureFixture, deadClosureProcess } from "./computer-closure-fixture.js";
import { projectSigningTrust, signingFixture } from "./computer-signing-fixture.js";
import type { WatchdogProcessIdentity } from "../../scripts/computer-watchdog/policy.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../../scripts/computer-watchdog/trust.js", async (original) => ({
  ...(await original<typeof trust>())
}));
const cleanups: (() => unknown | Promise<unknown>)[] = [];
let identities: WatchdogProcessIdentity[];
beforeAll(async () => {
  identities = [];
  for (let i = 0; i < 5; i++) identities.push(await deadClosureProcess());
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const base = await closureFixture(identities);
  cleanups.push(() => base.close());
  cleanups.push(projectSigningTrust());
  const source = structuredClone(base.deployment.configuration);
  const config = { ...source, supervisor: { ...source.supervisor } };
  for (const root of [
    config.supervisor.data,
    config.supervisor.dockerData,
    config.supervisor.monitor,
    config.receipt
  ])
    root.uid = 0;
  const artifact = join(base.root, "verifier.cjs");
  await fs.writeFile(artifact, "/* disclosed verifier code fixture */", { mode: 0o600 });
  config.artifactSha256 = trust.sha256(await fs.readFile(artifact));
  const signing = await signingFixture(base.root, config.supervisor, config.netNamespace, artifact);
  const save = () =>
    fs.writeFile(base.deployment.config.path, JSON.stringify(config), { mode: 0o600 });
  const consume = async () => {
    const { installationPath, installationSha256, installation } = await signing.read();
    config.installationPath = installationPath;
    config.installationSha256 = installationSha256;
    config.signingKeyPath = installation.signingKeyPath;
    config.publicKeySha256 = installation.publicKeySha256;
    await save();
    return load();
  };
  const load = () => loadClosureDeployment(base.deployment.config.path, artifact);
  return { base, config, artifact, signing, save, consume, load };
}

describe("actual signer publisher to mandatory closure loader; disclosed OS root/runtime/PID1 projections", () => {
  it("publishes private native Ed25519 signer and exact manifest consumed after recorded processes exit", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    const deployment = await t.consume();
    await expect(revalidateClosureDeployment(deployment)).resolves.toBeUndefined();
    const manifest = await t.signing.read();
    const key = createPrivateKey(await fs.readFile(manifest.installation.signingKeyPath));
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(trust.sha256(createPublicKey(key).export({ type: "spki", format: "der" }))).toBe(
      manifest.installation.publicKeySha256
    );
    expect(deployment.installationFile.hash).toBe(manifest.installationSha256);
    expect((await fs.lstat(manifest.installation.signingKeyPath)).mode & 0o7777).toBe(0o600);
    expect(await fs.readFile(manifest.installationPath, "utf8")).not.toContain("PRIVATE KEY");
    expect(await fs.readdir(t.signing.outputPath)).toEqual([
      "closure-key.pem",
      "installation.json"
    ]);
    expect(t.base.host.calls).toEqual([]);
    expect(await fs.readdir(t.base.host.config.stateDir)).not.toContain("daemon.lock");
  });
  it("actual publisher and mandatory loader accept projected UID1000 guest home/socket roots", async () => {
    const t = await fixture();
    const stat = vi.mocked(fs.lstat).getMockImplementation()!;
    const guest = [t.config.supervisor.host.homeDir, t.config.supervisor.host.guestSocketDir];
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const value = await stat(...args);
      if (guest.includes(String(args[0]))) value.uid = typeof value.uid === "bigint" ? 1000n : 1000;
      return value;
    });
    expect(await t.signing.install()).toBe(0);
    const deployment = await t.consume();
    expect(
      deployment.roots.filter((root) => guest.includes(root.path)).map((root) => root.uid)
    ).toEqual([1000, 1000]);
    await expect(revalidateClosureDeployment(deployment)).resolves.toBeUndefined();
  });
  it("actual publisher and mandatory loader reject foreign host ancestry", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    await t.consume();
    const stat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const value = await stat(...args);
      if (String(args[0]) === dirname(t.config.supervisor.host.homeDir))
        value.uid = typeof value.uid === "bigint" ? 123n : 123;
      return value;
    });
    await expect(t.signing.load()).rejects.toThrow();
    await expect(t.load()).rejects.toThrow();
  });
  it("signer refuses changed host root before any publication", async () => {
    const t = await fixture();
    const signing = await t.signing.load();
    const path = t.config.supervisor.host.homeDir;
    await fs.rename(path, path + ".old");
    await fs.mkdir(path, { mode: 0o700 });
    expect(
      await installClosureSigner(signing, {
        startedAtMs: 0,
        now: () => 1,
        interrupted: () => false
      })
    ).toBe(2);
    expect(await fs.readdir(t.signing.outputPath)).toEqual([]);
  });
  it("mandatory actual consumer refuses changed host root after successful load", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    const closure = await t.consume();
    const path = t.config.supervisor.host.homeDir;
    await fs.rename(path, path + ".old");
    await fs.mkdir(path, { mode: 0o700 });
    await expect(revalidateClosureDeployment(closure)).rejects.toThrow();
  });
  it.each(["symlink", "fifo", "mode", "identity"])(
    "refuses unsafe %s output root",
    async (mode) => {
      const t = await fixture();
      const path = t.signing.outputPath;
      if (mode === "mode") await fs.chmod(path, 0o750);
      else {
        await fs.rename(path, path + ".old");
        if (mode === "symlink") await fs.symlink(path + ".old", path);
        if (mode === "fifo") {
          const child = spawn("mkfifo", [path]);
          await once(child, "exit");
        }
        if (mode === "identity") await fs.mkdir(path, { mode: 0o700 });
      }
      await expect(t.signing.load()).rejects.toThrow();
    }
  );
  it("retains completed publication and refuses a second key rather than overwriting", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    const key = await fs.readFile(join(t.signing.outputPath, "closure-key.pem"));
    expect(await t.signing.install()).toBe(2);
    expect(await fs.readFile(join(t.signing.outputPath, "closure-key.pem"))).toEqual(key);
  });
  it.each([
    "installer",
    "verifier",
    "node",
    "net",
    "pid",
    "lifetime",
    "output-overlap",
    "request-inode"
  ])("refuses changed %s request provenance", async (mode) => {
    const t = await fixture();
    const deployment = await t.signing.load();
    if (mode === "installer") await fs.writeFile(t.signing.artifactPath, "changed");
    if (mode === "verifier") await fs.writeFile(t.artifact, "changed");
    if (mode === "node") t.signing.request.nodeSha256 = "0".repeat(64);
    if (mode === "net") t.signing.request.netNamespace = "net:[1]";
    if (mode === "pid")
      t.signing.request.supervisor.namespaces = {
        ...t.signing.request.supervisor.namespaces,
        pid: "pid:[1]"
      };
    if (mode === "lifetime")
      Object.assign(t.signing.request.supervisor, { lifetime: t.config.supervisor.lifetime });
    if (mode === "output-overlap") t.signing.request.output = t.config.supervisor.monitor;
    if (mode === "request-inode") {
      const bytes = await fs.readFile(t.signing.path);
      await fs.rename(t.signing.path, t.signing.path + ".old");
      await fs.writeFile(t.signing.path, bytes, { mode: 0o600 });
    } else await t.signing.save();
    if (mode === "request-inode")
      expect(
        await installClosureSigner(deployment, {
          startedAtMs: 0,
          now: () => 1,
          interrupted: () => false
        })
      ).toBe(2);
    else await expect(t.signing.load()).rejects.toThrow();
    expect(await fs.readdir(t.signing.outputPath)).toEqual([]);
  });
  it.each([
    "installation-hash",
    "installation-absent",
    "template",
    "artifact-path",
    "node",
    "net",
    "key",
    "public-key",
    "output-overlap"
  ])("mandatory actual consumer refuses %s binding", async (mode) => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    await t.consume();
    const published = await t.signing.read();
    const manifest = { ...published, installation: { ...published.installation } };
    if (mode === "installation-hash") t.config.installationSha256 = "0".repeat(64);
    if (mode === "installation-absent")
      delete (t.config as Partial<typeof t.config>).installationPath;
    if (mode === "template")
      t.config.supervisor.runner = { ...t.config.supervisor.runner, startTicks: "1" };
    if (mode === "artifact-path") manifest.installation.artifactPath = t.signing.artifactPath;
    if (mode === "node") manifest.installation.nodeSha256 = "0".repeat(64);
    if (mode === "net")
      manifest.installation.namespaces = { ...manifest.installation.namespaces, net: "net:[1]" };
    if (mode === "key") t.config.signingKeyPath = t.base.deployment.configuration.signingKeyPath;
    if (mode === "public-key") manifest.installation.publicKeySha256 = "0".repeat(64);
    if (mode === "output-overlap") t.config.receipt = manifest.installation.output;
    if (["artifact-path", "node", "net", "public-key"].includes(mode)) {
      const bytes = Buffer.from(JSON.stringify(manifest.installation));
      await fs.writeFile(manifest.installationPath, bytes);
      t.config.installationSha256 = trust.sha256(bytes);
    }
    await t.save();
    await expect(t.load()).rejects.toThrow();
  });
  it("mandatory actual consumer refuses installation output containing receipt root", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    await t.consume();
    const path = join(t.signing.outputPath, "receipts");
    await fs.mkdir(path, { mode: 0o700 });
    const { dev, ino, uid, gid, mode } = await fs.lstat(path);
    t.config.receipt = { path, dev, ino, uid, gid, mode };
    await t.save();
    await expect(t.load()).rejects.toThrow();
  });
  it("refuses same-byte installation inode replacement after successful load", async () => {
    const t = await fixture();
    expect(await t.signing.install()).toBe(0);
    const deployment = await t.consume();
    const path = t.signing.installationPath;
    const bytes = await fs.readFile(path);
    await fs.rename(path, path + ".old");
    await fs.writeFile(path, bytes, { mode: 0o600 });
    await expect(revalidateClosureDeployment(deployment)).rejects.toThrow();
  });
  it.each(["key-file", "manifest-file", "directory", "file-close", "directory-close"])(
    "retains partial output after failed %s durability",
    async (mode) => {
      const t = await fixture();
      const original = vi.mocked(fs.open).getMockImplementation()!;
      let keyWritten = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        const path = String(args[0]);
        const writing = typeof args[1] === "number" && Boolean(args[1] & 0o100);
        if (writing && path.endsWith("/closure-key.pem")) keyWritten = true;
        if (mode === "key-file" && writing && path.endsWith("/closure-key.pem"))
          vi.spyOn(file, "sync").mockRejectedValue(new Error("file persistence fixture"));
        if (mode === "manifest-file" && writing && path.endsWith("/installation.json"))
          vi.spyOn(file, "sync").mockRejectedValue(new Error("manifest persistence fixture"));
        if (mode === "directory" && path === t.signing.outputPath)
          vi.spyOn(file, "sync").mockRejectedValue(new Error("directory persistence fixture"));
        if (
          (mode === "file-close" && writing && path.endsWith("/closure-key.pem")) ||
          (mode === "directory-close" && keyWritten && path === t.signing.outputPath)
        ) {
          const close = file.close.bind(file);
          vi.spyOn(file, "close").mockImplementation(async () => {
            await close();
            throw new Error("close fixture");
          });
        }
        return file;
      });
      expect(await t.signing.install()).toBe(2);
      const names = await fs.readdir(t.signing.outputPath);
      expect(names).toContain("closure-key.pem");
      if (mode === "manifest-file") expect(names).toContain("installation.json");
    }
  );
  it.each(["equality", "signal", "changed-output"])(
    "refuses %s arriving after actual manifest directory fsync",
    async (mode) => {
      const t = await fixture();
      let at = 1;
      let interrupted = false;
      let manifestWritten = false;
      const original = vi.mocked(fs.open).getMockImplementation()!;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        if (
          String(args[0]).endsWith("/installation.json") &&
          typeof args[1] === "number" &&
          Boolean(args[1] & 0o100)
        )
          manifestWritten = true;
        if (String(args[0]) === t.signing.outputPath) {
          const sync = file.sync.bind(file);
          vi.spyOn(file, "sync").mockImplementation(async () => {
            await sync();
            if (!manifestWritten) return;
            if (mode === "equality") at = 60000;
            if (mode === "signal") interrupted = true;
            if (mode === "changed-output")
              await fs.writeFile(join(t.signing.outputPath, "closure-key.pem"), "changed");
          });
        }
        return file;
      });
      expect(
        await t.signing.install({ startedAtMs: 0, now: () => at, interrupted: () => interrupted })
      ).toBe(2);
      expect(await fs.readdir(t.signing.outputPath)).toEqual([
        "closure-key.pem",
        "installation.json"
      ]);
    }
  );
  it.each(["symlink", "hardlink", "fifo", "oversize", "mode"])(
    "refuses unsafe %s request",
    async (mode) => {
      const t = await fixture();
      const path = t.signing.path;
      const bytes = await fs.readFile(path);
      await fs.rename(path, path + ".old");
      if (mode === "symlink") await fs.symlink(path + ".old", path);
      if (mode === "hardlink") await fs.link(path + ".old", path);
      if (mode === "fifo") {
        const child = spawn("mkfifo", [path]);
        await once(child, "exit");
      }
      if (mode === "oversize") await fs.writeFile(path, Buffer.alloc(16385), { mode: 0o600 });
      if (mode === "mode") await fs.writeFile(path, bytes, { mode: 0o640 });
      await expect(t.signing.load()).rejects.toThrow();
    }
  );
  it.each(["closure-key.pem", "installation.json"] as const)(
    "canonical publisher rejects wrong byte representation for %s",
    async (name) => {
      const t = await fixture();
      await expect(
        ProvisionPublication.create(
          t.signing.request.output,
          name,
          name === "closure-key.pem" ? {} : Buffer.from("{}"),
          0o600,
          t.signing.request.output.gid,
          async () => {},
          () => {}
        )
      ).rejects.toThrow();
    }
  );
  it("canonical publisher bounds private PEM to4096bytes", async () => {
    const t = await fixture();
    await expect(
      ProvisionPublication.create(
        t.signing.request.output,
        "closure-key.pem",
        Buffer.alloc(4097),
        0o600,
        t.signing.request.output.gid,
        async () => {},
        () => {}
      )
    ).rejects.toThrow();
    expect(await fs.readdir(t.signing.outputPath)).toEqual([]);
  });
  it("requires closed request and installation schemas", async () => {
    const t = await fixture();
    expect(() => parseSigningConfiguration({ ...t.signing.request, extra: true })).toThrow();
    expect(await t.signing.install()).toBe(0);
    const { installation } = await t.signing.read();
    for (const change of [
      { extra: true },
      { version: 2 },
      { kind: "self-attested" },
      { signingKeyPath: "/key.pem" },
      { publicKeySha256: "bad" }
    ])
      expect(() => parseSigningInstallation({ ...installation, ...change })).toThrow();
  });
  it.each(["success", "file", "directory", "equality", "signal"])(
    "native production signer and actual loader with disclosed OS/Node projections: %s",
    async (kind) => {
      const t = await fixture();
      const bundle = t.signing.artifactPath;
      const preload = join(t.base.root, "signing-input/preload.cjs");
      for (const [entry, outfile] of [
        ["scripts/computer-signing.ts", bundle],
        ["tests/unit/computer-signing-native-fixture.ts", preload]
      ]) {
        const result = await build({
          entryPoints: [entry!],
          outfile,
          bundle: true,
          platform: "node",
          target: "node24",
          format: "cjs",
          metafile: true,
          logLevel: "silent"
        });
        expect(
          Object.values(result.metafile!.outputs).every((output) =>
            output.imports.every((i) => i.external && i.path.startsWith("node:"))
          )
        ).toBe(true);
      }
      t.signing.request.artifactSha256 = trust.sha256(await fs.readFile(bundle));
      await t.signing.save();
      await fs.writeFile(
        join(t.base.root, "signing-input/node-bytes"),
        "disclosed native Node hash projection",
        { mode: 0o600 }
      );
      const code = `require(${JSON.stringify(preload)}).prepareSigningNative(process.argv[2],${JSON.stringify(kind)}).then(()=>require(process.argv[1]));`;
      const argv = ["-e", code, bundle, t.signing.path];
      const startedAtNs = process.hrtime.bigint();
      const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      cleanups.push(async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (data) => {
        stdout += String(data);
      });
      child.stderr!.on("data", (data) => {
        stderr += String(data);
      });
      const messages: { type: string; timerStartedAtNs?: string; value?: number }[] = [];
      child.on("message", (message) => messages.push(message as (typeof messages)[number]));
      const exited = once(child, "exit");
      const safety = setTimeout(() => child.kill("SIGKILL"), 10000);
      const signalTimers: ReturnType<typeof setTimeout>[] = [];
      const signals: { signal: NodeJS.Signals; atNs: string; sent: boolean }[] = [];
      const send = (signal: NodeJS.Signals) =>
        signals.push({
          signal,
          atNs: process.hrtime.bigint().toString(),
          sent: child.kill(signal)
        });
      const held = kind === "file" || kind === "directory";
      if (held) {
        const event = await Promise.race([once(child, "message"), exited]);
        expect(event[0]?.type).toBe("held");
        send("SIGTERM");
        signalTimers.push(
          setTimeout(() => send("SIGINT"), 700),
          setTimeout(() => send("SIGTERM"), 1400)
        );
      }
      const [exit, signal] = await exited;
      const finishedAtNs = process.hrtime.bigint();
      clearTimeout(safety);
      for (const timer of signalTimers) clearTimeout(timer);
      const elapsedMs =
        held && messages[0]?.timerStartedAtNs
          ? Number(finishedAtNs - BigInt(messages[0].timerStartedAtNs)) / 1e6
          : null;
      const capture = process.env.COMPUTER_SIGNING_TEST_RECEIPTS;
      if (capture) {
        await fs.mkdir(capture, { recursive: true });
        await fs.writeFile(
          join(capture, `native-${kind}.json`),
          JSON.stringify({
            fixture:
              "OS ownership/runtime/PID1 and Node bytes; final callback wrapper injects equality or signal; no installed trust",
            startedAtNs: startedAtNs.toString(),
            finishedAtNs: finishedAtNs.toString(),
            argv: [process.execPath, ...argv],
            nativeUid: (await fs.readFile("/proc/self/status", "utf8")).match(
              /^Uid:\s+(\d+)/m
            )?.[1],
            node: process.version,
            pid: child.pid,
            artifactSha256: t.signing.request.artifactSha256,
            preloadSha256: trust.sha256(await fs.readFile(preload)),
            exit,
            signal,
            stdout,
            stderr,
            messages,
            signals,
            elapsedMs,
            scaledDeadlineMs: held ? 2000 : null
          })
        );
        await fs.copyFile(bundle, join(capture, "signing.cjs"));
      }
      expect(exit).toBe(kind === "success" ? 0 : 2);
      expect(signal).toBeNull();
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      if (held) {
        expect(signals.map((event) => event.signal)).toEqual(["SIGTERM", "SIGINT", "SIGTERM"]);
        expect(signals.every((event) => event.sent)).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(1995);
        expect(elapsedMs).toBeLessThan(2800);
      }
      if (kind === "equality" || kind === "signal")
        expect(messages).toContainEqual({ type: "final-callback", value: 0, kind });
      if (kind === "success") await expect(t.consume()).resolves.toBeDefined();
      expect(await fs.readdir(t.base.host.config.stateDir)).not.toContain("daemon.lock");
      expect(t.base.host.calls).toEqual([]);
    },
    15000
  );
  it("native builtin-only signer refuses actual nonroot silently", async () => {
    const t = await fixture();
    const bundle = t.signing.artifactPath;
    await build({
      entryPoints: ["scripts/computer-signing.ts"],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      logLevel: "silent"
    });
    const child = spawnSync(process.execPath, [bundle, t.signing.path], {
      encoding: "utf8",
      timeout: 3000
    });
    expect(child.status).toBe(2);
    expect(child.signal).toBeNull();
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });
});
