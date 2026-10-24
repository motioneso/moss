import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { captureFixture } from "./computer-capture-fixture.js";
import { signingFixture } from "./computer-signing-fixture.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import {
  loadClosureDeployment,
  parseClosureConfiguration,
  revalidateClosureDeployment
} from "../../scripts/computer-closure/config.js";
import {
  assertCaptureJournal,
  loadClosureCapture
} from "../../scripts/computer-closure/capture.js";
import { closureFile } from "../../scripts/computer-closure/files.js";
import { readClosureRecords } from "../../scripts/computer-closure/records.js";
import type { ClosureConfiguration } from "../../scripts/computer-closure/config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Actual capture -> actual signer -> mandatory loader. Inherited OS/root/runtime/Node/cgroup projections. */
async function fixture() {
  const f = await captureFixture((close) => cleanups.push(close));
  await f.run();
  const path = join(f.capture, "capture.json");
  const capture = JSON.parse(await fs.readFile(path, "utf8"));
  const artifact = join(f.root, "input/closure.cjs");
  await fs.writeFile(artifact, "/* disclosed verifier artifact projection */", { mode: 0o600 });
  const receiptPath = join(f.root, "receipt");
  await fs.mkdir(receiptPath, { mode: 0o700 });
  const { dev, ino, uid, gid, mode } = await f.io.lstat(receiptPath);
  const signing = await signingFixture(
    f.root,
    f.deployment.configuration,
    capture.provenance.namespaces.net,
    artifact
  );
  expect(await signing.install()).toBe(0);
  const installed = await signing.read();
  const config = {
    supervisor: f.deployment.configuration,
    processes: { watchdog: f.watchdog, desktop: f.desktop, gateway: f.gateway },
    artifactSha256: trust.sha256(await fs.readFile(artifact)),
    captureSha256: trust.sha256(await fs.readFile(path)),
    installationPath: installed.installationPath,
    installationSha256: installed.installationSha256,
    signingKeyPath: installed.installation.signingKeyPath,
    publicKeySha256: installed.installation.publicKeySha256,
    netNamespace: capture.provenance.namespaces.net,
    receipt: { path: receiptPath, dev, ino, uid, gid, mode }
  } satisfies ClosureConfiguration;
  const configPath = join(f.root, "input/closure.json");
  const save = () => fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  const repin = async () => {
    await fs.writeFile(path, JSON.stringify(capture));
    config.captureSha256 = trust.sha256(await fs.readFile(path));
    await save();
  };
  const stop = async () => {
    const original = f.store.state;
    await fs.writeFile(
      join(f.host.stateDir, "stop.json"),
      JSON.stringify({
        schemaVersion: 1,
        reason: "operator-stop",
        instanceId: f.host.instanceId,
        roots: f.deployment.roots,
        state: original
      }),
      { mode: 0o600 }
    );
    await f.store.save({ ...original, enabled: false, generation: original.generation + 1 });
    await f.journal.collector(f.descendant);
    await f.journal.stop(f.startedAtMs + 1, "operator-stop", f.descendant);
    await f.store.close();
  };
  return {
    f,
    path,
    capture,
    config,
    save,
    repin,
    stop,
    load: () => loadClosureDeployment(configPath, artifact)
  };
}

describe("mandatory sampled capture binding; no installed or descendant-complete qualification", () => {
  it("consumes actual published capture and signer after journal append, state transition and lock disappearance", async () => {
    const t = await fixture();
    const before = await fs.readFile(t.path);
    await t.stop();
    vi.spyOn(trust, "processIdentity").mockRejectedValue(
      new Error("post-stop live lookup forbidden")
    );
    const deployment = await t.load();
    expect(deployment.capture.file.hash).toBe(t.config.captureSha256);
    const records = await readClosureRecords(deployment);
    expect(records.lockPresent).toBe(false);
    expect(records.state.enabled).toBe(false);
    expect(records.collectors).toContainEqual(t.f.descendant);
    expect(records.files.at(-1)!.bytes.length).toBeGreaterThan(deployment.capture.journal.size);
    expect(await fs.readFile(t.path)).toEqual(before);
    await expect(revalidateClosureDeployment(deployment)).resolves.toBeUndefined();
    expect(t.f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["hash", "missing-hash", "missing-root", "missing-lifetime"])(
    "requires %s in actual configuration",
    async (key) => {
      const t = await fixture();
      if (key === "hash") t.config.captureSha256 = "0".repeat(64);
      if (key === "missing-hash") Reflect.deleteProperty(t.config, "captureSha256");
      if (key === "missing-root") Reflect.deleteProperty(t.config.supervisor, "capture");
      if (key === "missing-lifetime") Reflect.deleteProperty(t.config.supervisor, "lifetime");
      // Canonical parsed supervisor is frozen: missing-root/lifetime use a serializable clone.
      const value = structuredClone(t.config);
      if (key === "missing-root") Reflect.deleteProperty(value.supervisor, "capture");
      if (key === "missing-lifetime") Reflect.deleteProperty(value.supervisor, "lifetime");
      if (key !== "hash") expect(() => parseClosureConfiguration(value)).toThrow();
      else {
        await t.save();
        await expect(t.load()).rejects.toThrow();
      }
    }
  );

  const mutations: Record<string, (value: Awaited<ReturnType<typeof fixture>>["capture"]) => void> =
    {
      "envelope-extra": (v) => {
        v.extra = true;
      },
      version: (v) => {
        v.version = 2;
      },
      kind: (v) => {
        v.kind = "other";
      },
      coverage: (v) => {
        v.coverage = "complete";
      },
      run: (v) => {
        v.runId = "60000000-0000-4000-8000-000000000006";
      },
      binding: (v) => {
        v.binding.requestGeneration++;
      },
      "binding-extra": (v) => {
        v.binding.extra = true;
      },
      runner: (v) => {
        v.runner.startTicks = "1";
      },
      watchdog: (v) => {
        v.watchdog.processGroupId++;
      },
      "init-pid": (v) => {
        v.inits[0].pid++;
      },
      "init-start": (v) => {
        v.inits[0].identity.startTicks = "1";
      },
      "init-group": (v) => {
        v.inits[0].identity.processGroupId++;
      },
      "init-full-id": (v) => {
        v.inits[0].id = "c".repeat(64);
      },
      "init-date": (v) => {
        v.inits[0].startedAt = "invalid";
      },
      "init-extra": (v) => {
        v.inits[0].identity.extra = 1;
      },
      "duplicate-role": (v) => {
        v.inits[1] = v.inits[0];
      },
      "missing-role": (v) => {
        v.inits.pop();
      },
      boot: (v) => {
        v.provenance.bootId = "60000000-0000-4000-8000-000000000006";
      },
      pid: (v) => {
        v.provenance.namespaces.pid = "pid:[1]";
      },
      mnt: (v) => {
        v.provenance.namespaces.mnt = "mnt:[1]";
      },
      user: (v) => {
        v.provenance.namespaces.user = "user:[1]";
      },
      net: (v) => {
        v.provenance.namespaces.net = "net:[1]";
      },
      cgroup: (v) => {
        v.provenance.namespaces.cgroup = "cgroup:[1]";
        v.groups.namespaces.cgroup = "cgroup:[1]";
      },
      "group-net": (v) => {
        v.groups.namespaces.net = "net:[1]";
      },
      roots: (v) => {
        v.provenance.roots[0].ino++;
      },
      "negative-time": (v) => {
        v.measuredAtMs = -1;
      },
      "reversed-time": (v) => {
        v.finishedAtMs = v.measuredAtMs - 1;
      },
      "unsafe-time": (v) => {
        v.finishedAtMs = Number.MAX_SAFE_INTEGER + 1;
      },
      "journal-shape": (v) => {
        v.journal.extra = true;
      },
      "journal-zero-inode": (v) => {
        v.journal.ino = 0;
      },
      "journal-size": (v) => {
        v.journal.size = 4097;
      },
      "journal-hash": (v) => {
        v.journal.hash = "invalid";
      }
    };
  it.each(Object.keys(mutations))("rejects repinned malformed or mismatched %s", async (key) => {
    const t = await fixture();
    mutations[key]!(t.capture);
    await t.repin();
    await expect(t.load()).rejects.toThrow();
  });

  it.each(["inode", "bytes"])(
    "revalidates original capture %s after successful load",
    async (key) => {
      const t = await fixture();
      const deployment = await t.load();
      if (key === "inode") {
        const bytes = await fs.readFile(t.path);
        await fs.rename(t.path, t.path + ".old");
        await fs.writeFile(t.path, bytes, { mode: 0o600 });
      } else await fs.appendFile(t.path, " ");
      await expect(revalidateClosureDeployment(deployment)).rejects.toThrow();
    }
  );
  it.each(["symlink", "hardlink", "fifo", "oversize", "mode"])(
    "refuses unsafe capture %s",
    async (key) => {
      const t = await fixture();
      await fs.rename(t.path, t.path + ".old");
      if (key === "symlink") await fs.symlink(t.path + ".old", t.path);
      if (key === "hardlink") await fs.link(t.path + ".old", t.path);
      if (key === "fifo") expect(spawnSync("mkfifo", ["-m", "600", t.path]).status).toBe(0);
      if (key === "oversize") await fs.writeFile(t.path, "x".repeat(65537), { mode: 0o600 });
      if (key === "mode")
        await fs.copyFile(t.path + ".old", t.path).then(() => fs.chmod(t.path, 0o644));
      await expect(t.load()).rejects.toThrow();
    }
  );
  it.each(["inode", "dev", "prefix-hash", "prefix-size", "before-start", "equality"])(
    "binds retained journal %s",
    async (key) => {
      const t = await fixture();
      const journalPath = join(t.f.config.monitor.path, "observation.jsonl");
      await t.stop();
      let journal = await closureFile(journalPath, 512 * 1024);
      if (key === "inode") {
        await fs.rename(journalPath, journalPath + ".old");
        await fs.writeFile(journalPath, journal.bytes, { mode: 0o600 });
        journal = await closureFile(journalPath, 512 * 1024);
      }
      if (key === "dev") t.capture.journal.dev++;
      if (key === "prefix-hash") t.capture.journal.hash = "0".repeat(64);
      if (key === "prefix-size") t.capture.journal.size++;
      if (key === "before-start") {
        t.capture.measuredAtMs = t.f.startedAtMs - 1;
      }
      if (key === "equality") {
        t.capture.finishedAtMs = t.f.startedAtMs + 5000;
      }
      await t.repin();
      const capture = await loadClosureCapture(t.config, t.f.deployment.roots);
      expect(() => assertCaptureJournal(capture, journal)).toThrow();
      await expect(readClosureRecords(await t.load())).rejects.toThrow();
    }
  );
});
