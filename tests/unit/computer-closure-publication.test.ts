import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { closurePublicationFixture } from "./computer-closure-publication-fixture.js";
import {
  loadClosureDeployment,
  revalidateClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { readClosureRecords } from "../../scripts/computer-closure/records.js";
import {
  loadClosurePublication,
  revalidateClosurePublication
} from "../../scripts/computer-closure-publication/config.js";
import {
  parseClosurePublicationRequest,
  publicationArguments
} from "../../scripts/computer-closure-publication/request.js";
import {
  PublicationClock,
  publishClosureConfiguration
} from "../../scripts/computer-closure-publication/run.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => closurePublicationFixture((close) => cleanups.push(close));

describe("staged closure publication; external approval and runtime qualification remain separate", () => {
  it("publishes actual capture -> signer -> config -> mandatory loader after append/disable/owned-lock release", async () => {
    const t = await fixture();
    await t.stop();
    vi.spyOn(trust, "processIdentity").mockRejectedValue(
      new Error("historical liveness forbidden")
    );
    const original = await fs.readFile(t.capturePath);
    expect(await t.publish()).toBe(0);
    const path = join(t.request.output.path, "closure.json");
    const loaded = await loadClosureDeployment(path, t.artifact);
    await expect(revalidateClosureDeployment(loaded)).resolves.toBeUndefined();
    expect(loaded.configuration.processes).toEqual({
      watchdog: t.f.watchdog,
      desktop: t.f.desktop,
      gateway: t.f.gateway
    });
    expect((await readClosureRecords(loaded)).lockPresent).toBe(false);
    expect(await fs.readFile(t.capturePath)).toEqual(original);
    expect((await fs.lstat(path)).mode & 0o7777).toBe(0o600);
    expect(await fs.readdir(t.request.output.path)).toEqual(["closure.json"]);
    expect(t.f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("requires external raw request hash before parsing and retains raw supervisor authority", async () => {
    const t = await fixture();
    const parse = vi.spyOn(JSON, "parse");
    await expect(loadClosurePublication(t.path, "0".repeat(64), t.publisher)).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    await fs.appendFile(t.request.supervisorPath, "\n");
    await expect(t.load()).rejects.toThrow();
  });
  it.each([
    "artifactSha256",
    "supervisorSha256",
    "closureArtifactSha256",
    "nodeSha256",
    "installationSha256",
    "publicKeySha256",
    "captureSha256",
    "netNamespace",
    "cgroupNamespace"
  ] as const)("refuses wrong independently pinned %s before output", async (key) => {
    const t = await fixture();
    Object.assign(t.request, {
      [key]:
        key === "netNamespace"
          ? "net:[1]"
          : key === "cgroupNamespace"
            ? "cgroup:[1]"
            : "0".repeat(64)
    });
    await t.save();
    await expect(t.load()).rejects.toThrow();
    expect(await fs.readdir(t.request.output.path)).toEqual([]);
  });
  it.each(["input", "supervisor", "installation", "key", "capture"])(
    "retains original %s inode even for identical replacement bytes",
    async (kind) => {
      const t = await fixture();
      const deployment = await t.load();
      const file = {
        input: deployment.input,
        supervisor: deployment.supervisorFile,
        installation: deployment.closure.installationFile,
        key: deployment.closure.keyFile,
        capture: deployment.closure.capture.file
      }[kind]!;
      await fs.rename(file.path, file.path + ".retained");
      await fs.writeFile(file.path, file.bytes, { mode: 0o600 });
      await expect(revalidateClosurePublication(deployment)).rejects.toThrow();
    }
  );
  it("refuses retry without overwriting a completed config", async () => {
    const t = await fixture();
    expect(await t.publish()).toBe(0);
    const path = join(t.request.output.path, "closure.json");
    const before = await fs.readFile(path);
    expect(await t.publish()).toBe(2);
    expect(await fs.readFile(path)).toEqual(before);
  });
  it.each(["equality", "rollback", "negative", "unsafe", "signal"])(
    "refuses %s on the same original clock",
    async (kind) => {
      const t = await fixture();
      const now =
        kind === "equality"
          ? 60000
          : kind === "rollback"
            ? -1
            : kind === "negative"
              ? -10
              : kind === "unsafe"
                ? NaN
                : 1;
      const clock = new PublicationClock(
        0,
        () => kind === "signal",
        () => now
      );
      expect(await publishClosureConfiguration(await t.load(), clock)).toBe(2);
      expect(await fs.readdir(t.request.output.path)).toEqual([]);
    }
  );
  it.each(
    [
      [],
      ["/request"],
      ["/request", "a".repeat(64), "extra"],
      ["relative", "a".repeat(64)],
      ["/request", "A".repeat(64)],
      ["/request", ""]
    ].map((argv) => ({ argv }))
  )("refuses malformed argv $argv", ({ argv }) => {
    expect(() => publicationArguments(argv)).toThrow();
  });
  it("accepts exactly the explicit request path and external hash", () => {
    const argv = ["/request", "a".repeat(64)];
    expect(publicationArguments(argv)).toEqual(argv);
  });
  it("rejects open schema, unsafe root mode and missing hashes", async () => {
    const t = await fixture();
    expect(() => parseClosurePublicationRequest({ ...t.request, extra: 1 })).toThrow();
    expect(() =>
      parseClosurePublicationRequest({
        ...t.request,
        output: { ...t.request.output, mode: 0o40750 }
      })
    ).toThrow();
    const value = { ...t.request };
    Reflect.deleteProperty(value, "captureSha256");
    expect(() => parseClosurePublicationRequest(value)).toThrow();
  });
});
