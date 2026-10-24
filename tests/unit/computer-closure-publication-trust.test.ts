import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { closurePublicationFixture } from "./computer-closure-publication-fixture.js";
import { parseClosurePublicationRequest } from "../../scripts/computer-closure-publication/request.js";
import { revalidateClosurePublication } from "../../scripts/computer-closure-publication/config.js";
import {
  loadClosureInputs,
  parseClosureConfiguration
} from "../../scripts/computer-closure/config.js";
import { loadPinnedClosureCapture } from "../../scripts/computer-closure/capture.js";
import { inspectRoots } from "../../scripts/computer-host/config.js";
import { parseSupervisorConfiguration, sha256 } from "../../scripts/computer-watchdog/trust.js";
import { parseSigningInstallation } from "../../scripts/computer-signing/installation.js";
import {
  PublicationClock,
  publishClosureConfiguration
} from "../../scripts/computer-closure-publication/run.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => closurePublicationFixture((close) => cleanups.push(close));

describe("isolated staged publisher trust and persistence controls", () => {
  it.each(["output", "receipt"] as const)(
    "requires dedicated0700 %s independently of identity/ancestry",
    async (key) => {
      const t = await fixture();
      await fs.chmod(t.request[key].path, 0o750);
      Object.assign(t.request, { [key]: await t.pin(t.request[key].path) });
      await t.save();
      expect(() => parseClosurePublicationRequest(t.request)).toThrow();
    }
  );
  it.each([
    "child",
    "ancestor",
    "equal",
    "capture",
    "signer",
    "input",
    "receipt-child",
    "receipt-ancestor"
  ])("refuses output separation %s with valid installed/capture authority", async (kind) => {
    const t = await fixture();
    const supervisor = JSON.parse(await fs.readFile(t.request.supervisorPath, "utf8"));
    let path = t.request.output.path;
    if (kind === "child") {
      path = join(supervisor.data.path, "publisher");
      await fs.mkdir(path, { mode: 0o700 });
    }
    if (kind === "ancestor") {
      const data = join(path, "nested-data");
      await fs.mkdir(data, { mode: 0o700 });
      supervisor.data = await t.pin(data);
      await t.resign(supervisor);
    }
    if (kind === "equal") path = supervisor.data.path;
    if (kind === "capture") path = supervisor.capture.path;
    if (kind === "signer") path = dirname(t.request.installationPath);
    if (kind === "input") path = dirname(t.path);
    if (kind === "receipt-child") {
      path = join(t.request.receipt.path, "output");
      await fs.mkdir(path, { mode: 0o700 });
    }
    if (kind === "receipt-ancestor") {
      const receipt = join(path, "receipt");
      await fs.mkdir(receipt, { mode: 0o700 });
      Object.assign(t.request, { receipt: await t.pin(receipt) });
    }
    Object.assign(t.request, { output: await t.pin(path) });
    await t.save();
    expect(parseClosurePublicationRequest(t.request).output.path).toBe(path);
    const s = parseSupervisorConfiguration(supervisor);
    const capture = await loadPinnedClosureCapture(
      { supervisor: s, ...t.request },
      await inspectRoots(s.host)
    );
    expect(capture.processes.desktop).toEqual(t.f.desktop);
    // Reverse containment of data is not blocked by the existing consumer destination check.
    if (kind === "ancestor") {
      const installation = parseSigningInstallation(
        JSON.parse(await fs.readFile(t.request.installationPath, "utf8"))
      );
      const config = parseClosureConfiguration({
        supervisor: s,
        processes: capture.processes,
        artifactSha256: t.request.closureArtifactSha256,
        netNamespace: t.request.netNamespace,
        receipt: t.request.receipt,
        signingKeyPath: installation.signingKeyPath,
        publicKeySha256: t.request.publicKeySha256,
        installationPath: t.request.installationPath,
        installationSha256: t.request.installationSha256,
        captureSha256: t.request.captureSha256
      });
      await expect(
        loadClosureInputs(config, join(path, "closure.json"), t.artifact)
      ).resolves.toBeDefined();
    }
    await expect(t.load()).rejects.toThrow();
  });
  it.each(["symlink", "hardlink", "fifo", "mode", "oversize"])(
    "refuses unsafe private request %s before output",
    async (kind) => {
      const t = await fixture();
      if (kind === "mode") await fs.chmod(t.path, 0o640);
      else if (kind === "oversize") await fs.writeFile(t.path, "x".repeat(16385));
      else {
        await fs.rename(t.path, t.path + ".retained");
        if (kind === "symlink") await fs.symlink(t.path + ".retained", t.path);
        if (kind === "hardlink") await fs.link(t.path + ".retained", t.path);
        if (kind === "fifo") expect(spawnSync("mkfifo", [t.path]).status).toBe(0);
      }
      // Use an independently retained approved hash, avoiding a blocking FIFO read in fixture hash().
      const { loadClosurePublication } =
        await import("../../scripts/computer-closure-publication/config.js");
      await expect(loadClosurePublication(t.path, "a".repeat(64), t.publisher)).rejects.toThrow();
      expect(await fs.readdir(t.request.output.path)).toEqual([]);
    }
  );
  it.each(["publisher", "node", "root", "journal-inode", "journal-prefix"])(
    "revalidates original %s after load",
    async (kind) => {
      const t = await fixture();
      const loaded = await t.load();
      if (kind === "publisher") await fs.appendFile(t.publisher, "changed");
      if (kind === "node") {
        const trust = await import("../../scripts/computer-watchdog/trust.js");
        const read = vi.mocked(trust.boundedFile).getMockImplementation()!;
        vi.spyOn(trust, "boundedFile").mockImplementation((path, limit) =>
          path === process.execPath
            ? Promise.resolve(Buffer.from("changed-node"))
            : read(path, limit)
        );
      }
      if (kind === "root") {
        await fs.rename(t.request.output.path, t.request.output.path + ".retained");
        await fs.mkdir(t.request.output.path, { mode: 0o700 });
      }
      const journal = join(t.f.deployment.configuration.monitor.path, "observation.jsonl");
      if (kind === "journal-inode") {
        const bytes = await fs.readFile(journal);
        await fs.rename(journal, journal + ".retained");
        await fs.writeFile(journal, bytes, { mode: 0o600 });
      }
      if (kind === "journal-prefix") await fs.writeFile(journal, "changed\n");
      await expect(revalidateClosurePublication(loaded)).rejects.toThrow();
    }
  );
  it("retains exclusive partial output when file sync fails and refuses retry", async () => {
    const t = await fixture();
    const loaded = await t.load();
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith("/closure.json") && Number(args[1]) & 0o100)
        vi.spyOn(file, "sync").mockRejectedValue(new Error("disclosed sync fault"));
      return file;
    });
    const clock = () =>
      new PublicationClock(
        0,
        () => false,
        () => 1
      );
    expect(await publishClosureConfiguration(loaded, clock())).toBe(2);
    const path = join(t.request.output.path, "closure.json");
    const before = await fs.readFile(path);
    expect(sha256(before)).toBe(sha256(Buffer.from(JSON.stringify(loaded.closure.configuration))));
    expect(await publishClosureConfiguration(loaded, clock())).toBe(2);
    expect(await fs.readFile(path)).toEqual(before);
  });
  it("preserves last observed time across the actual final continuation's check", () => {
    let at = 10;
    const clock = new PublicationClock(
      0,
      () => false,
      () => at
    );
    clock.check();
    at = 9;
    expect(() => clock.check()).toThrow();
    for (const initial of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        new PublicationClock(
          initial,
          () => false,
          () => 10
        ).check()
      ).toThrow();
  });
});
