import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { build } from "esbuild";
import { closurePublicationFixture } from "./computer-closure-publication-fixture.js";
import {
  loadClosureDeployment,
  revalidateClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { sha256 } from "../../scripts/computer-watchdog/trust.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("actual staged publisher CJS and native final continuation under disclosed OS/Node projections", () => {
  it.each([
    "success",
    "file",
    "directory",
    "file-close",
    "directory-close",
    "equality",
    "signal",
    "rollback"
  ])(
    "native %s",
    async (kind) => {
      const t = await closurePublicationFixture((close) => cleanups.push(close));
      await t.stop();
      const preload = join(t.f.root, "input/preload.cjs");
      for (const [entry, outfile] of [
        ["scripts/computer-closure-publication.ts", t.publisher],
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
          Object.values(result.metafile!.outputs).every((o) =>
            o.imports.every((i) => i.external && i.path.startsWith("node:"))
          )
        ).toBe(true);
      }
      Object.assign(t.request, { artifactSha256: sha256(await fs.readFile(t.publisher)) });
      await t.save();
      await fs.writeFile(join(t.f.root, "input/node-bytes"), "disclosed native Node hash fixture", {
        mode: 0o600
      });
      const code = `require(${JSON.stringify(preload)}).prepareSigningNative(process.argv[2],${JSON.stringify(kind)},"closure.json").then(()=>require(process.argv[1]));`;
      const child = spawn(process.execPath, ["-e", code, t.publisher, t.path, await t.hash()], {
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      });
      const messages: { type: string; timerStartedAtNs?: string; value?: number; kind?: string }[] =
        [];
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (data) => {
        stdout += String(data);
      });
      child.stderr!.on("data", (data) => {
        stderr += String(data);
      });
      child.on("message", (message) => messages.push(message as (typeof messages)[number]));
      const exited = once(child, "exit");
      const backstop = setTimeout(() => child.kill("SIGKILL"), 10000);
      const signals: { signal: NodeJS.Signals; sent: boolean; atNs: string }[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const held = ["file", "directory", "file-close", "directory-close"].includes(kind);
      try {
        if (held) {
          const event = await Promise.race([once(child, "message"), exited]);
          expect(event[0]?.type).toBe("held");
          const send = (signal: NodeJS.Signals) =>
            signals.push({
              signal,
              sent: child.kill(signal),
              atNs: process.hrtime.bigint().toString()
            });
          send("SIGTERM");
          timers.push(
            setTimeout(() => send("SIGINT"), 700),
            setTimeout(() => send("SIGTERM"), 1400)
          );
        }
        const [exit, signal] = await exited;
        const finishedAtNs = process.hrtime.bigint();
        const elapsedMs =
          held && messages[0]?.timerStartedAtNs
            ? Number(finishedAtNs - BigInt(messages[0].timerStartedAtNs)) / 1e6
            : null;
        if (process.env.COMPUTER_PUBLICATION_TEST_RECEIPTS) {
          await fs.mkdir(process.env.COMPUTER_PUBLICATION_TEST_RECEIPTS, { recursive: true });
          await fs.writeFile(
            join(process.env.COMPUTER_PUBLICATION_TEST_RECEIPTS, `native-${kind}.json`),
            JSON.stringify({
              kind,
              exit,
              signal,
              stdout,
              stderr,
              messages,
              signals,
              elapsedMs,
              node: process.version,
              artifactSha256: t.request.artifactSha256,
              preloadSha256: sha256(await fs.readFile(preload)),
              projections:
                "ownership/runtime/PID1/Node bytes; final callback equality/signal/rollback injection; original 60s scaled to2s for held I/O"
            })
          );
        }
        expect(exit).toBe(kind === "success" ? 0 : 2);
        expect(signal).toBeNull();
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        if (held) {
          expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGINT", "SIGTERM"]);
          expect(signals.every((s) => s.sent)).toBe(true);
          expect(elapsedMs).toBeGreaterThanOrEqual(1995);
          expect(elapsedMs).toBeLessThan(2900);
        }
        if (["equality", "signal", "rollback"].includes(kind))
          expect(messages).toContainEqual({ type: "final-callback", value: 0, kind });
        if (kind === "success") {
          const loaded = await loadClosureDeployment(
            join(t.request.output.path, "closure.json"),
            t.artifact
          );
          await expect(revalidateClosureDeployment(loaded)).resolves.toBeUndefined();
        }
      } finally {
        clearTimeout(backstop);
        for (const timer of timers) clearTimeout(timer);
      }
    },
    15000
  );
  it("actual nonroot Node22 execution silently refuses before publication", async () => {
    const t = await closurePublicationFixture((close) => cleanups.push(close));
    await build({
      entryPoints: ["scripts/computer-closure-publication.ts"],
      outfile: t.publisher,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      logLevel: "silent"
    });
    const child = spawnSync(process.execPath, [t.publisher, t.path, await t.hash()], {
      encoding: "utf8",
      timeout: 3000
    });
    expect(child.status).toBe(2);
    expect(child.signal).toBeNull();
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
    expect(await fs.readdir(t.request.output.path)).toEqual([]);
  });
});
