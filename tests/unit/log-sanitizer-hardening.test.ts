/**
 * Hostile-input checks, asserted on the real output of a pino logger (through the sanitizing
 * destination) and on real stderr writes, not only on the sanitizer function.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import { createCrashHandler as createApiCrashHandler } from "../../apps/api/src/process-lifecycle.js";
import { createCrashHandler as createWorkerCrashHandler } from "../../apps/worker/src/worker.js";
import { defaultOnPgBossError } from "../../packages/jobs/src/pg-boss.js";
import { sanitizeLogText, sanitizeLogValue } from "../../packages/shared/src/log-sanitizer.js";

function realLogger(): { log: ReturnType<typeof Fastify>["log"]; output: () => string } {
  const lines: string[] = [];
  const server = Fastify({
    logger: recordingLoggerOptions({
      level: "info",
      stream: { write: (chunk: string) => void lines.push(chunk) }
    } as never)
  });
  return { log: server.log, output: () => lines.join("") };
}

function stderrOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** An error whose message getter throws, with a secret on another field. */
function hostileError(): Error {
  const err = new Error("placeholder");
  Object.defineProperty(err, "message", {
    get() {
      throw new Error("getter exploded HOSTILE-CANARY");
    }
  });
  Object.assign(err, { detail: "postgres://u:HOSTILE-CANARY@h/db" });
  return err;
}

describe("1. crash handlers survive a hostile error", () => {
  it("API handler writes nothing raw, still shuts down and exits 1", async () => {
    const { log, output } = realLogger();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const close = vi.fn((cb: (err?: Error) => void) => cb());
    const exit = vi.fn();
    const handle = createApiCrashHandler(
      { log, close },
      { exit: exit as unknown as (code: number) => never }
    );
    expect(() => handle("uncaughtException", hostileError())).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(close).toHaveBeenCalledTimes(1);
    expect(output() + stderrOutput(stderr)).not.toContain("HOSTILE-CANARY");
  });

  it("API handler survives a logger that throws", async () => {
    const exit = vi.fn();
    const handle = createApiCrashHandler(
      {
        log: {
          error: () => {
            throw new Error("logger broke");
          }
        },
        close: (cb) => cb()
      },
      { exit: exit as unknown as (code: number) => never }
    );
    expect(() => handle("unhandledRejection", new Error("x"))).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("worker handler writes nothing raw and still exits 1", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.fn();
    const handle = createWorkerCrashHandler(
      { shutdown: () => Promise.resolve() },
      { exit: exit as unknown as (code: number) => never }
    );
    expect(() => handle("uncaughtException", hostileError())).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stderrOutput(stderr)).not.toContain("HOSTILE-CANARY");
  });
});

describe("2. oversized input holding a URL password", () => {
  const longPassword = `${"p".repeat(3000)}LONG-CANARY`;

  it("pino message and context", () => {
    const { log, output } = realLogger();
    log.warn(
      { url: `https://bob:${longPassword}@host/x` },
      `connect https://bob:${longPassword}@host/x`
    );
    expect(output()).not.toMatch(/pppp|LONG-CANARY/);
  });

  it("a password longer than the per-string cap never starts to print", () => {
    const { log, output } = realLogger();
    log.warn(`connect https://bob:${"p".repeat(100_000)}@host/x`);
    log.warn({ url: `https://bob:${"p".repeat(100_000)}@host/x` }, "ctx");
    expect(output()).not.toMatch(/pppp/);
  });

  it("a cut inside the authority drops its start", () => {
    const { log, output } = realLogger();
    log.warn(`${"a".repeat(16370)} https://bob:${"p".repeat(100_000)}@host/x`);
    expect(output()).not.toMatch(/pppp/);
  });

  it("a 2 KB cut inside the authority drops its start", () => {
    const { log, output } = realLogger();
    log.warn(`${"a".repeat(2040)} https://bob:${"p".repeat(500)}@host`);
    expect(output()).not.toMatch(/pppp/);
  });

  it("real stderr from the job queue error handler", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(`${"a".repeat(16370)} https://bob:${"p".repeat(100_000)}@host`));
    expect(stderrOutput(stderr)).not.toMatch(/pppp/);
  });
});

describe("3. single-quoted header values", () => {
  it("pino output masks Cookie and Authorization", () => {
    const { log, output } = realLogger();
    log.warn(
      { raw: "Cookie:'sid=SQ-CANARY1' and Authorization:'Basic SQ-CANARY2'" },
      "Set-Cookie:'refresh=SQ-CANARY3; Path=/'"
    );
    expect(output()).not.toMatch(/SQ-CANARY/);
    expect(output()).toContain("Cookie");
  });

  it("real stderr masks them too", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error("Cookie:'sid=SQ-CANARY1' Authorization:'Basic SQ-CANARY2'"));
    expect(stderrOutput(stderr)).not.toMatch(/SQ-CANARY/);
  });
});

describe("4. binary values", () => {
  it("a Buffer and a typed array never print as number arrays", () => {
    const { log, output } = realLogger();
    const secret = "Authorization: Basic dXNlcjpwdw==";
    log.warn({ buf: Buffer.from(secret), arr: new TextEncoder().encode(secret) }, "binary");
    const out = output();
    expect(out).toContain("[binary");
    expect(out).not.toMatch(/65,117,116|"0":65/);
    expect(out).not.toContain("dXNlcjpwdw");
  });

  it("an ArrayBuffer is masked as binary", () => {
    expect(sanitizeLogValue({ a: new ArrayBuffer(8) })).toEqual({ a: "[binary 8 bytes]" });
  });
});

describe("5. work bounds under a time ceiling", () => {
  const CEILING_MS = 400;

  function timed(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }

  it.each([
    ["a- repeated 16384 times", "a-".repeat(16384)],
    ["a- repeated 32768 times", "a-".repeat(32768)],
    ["scheme markers", "https://".repeat(20_000)],
    ["scheme markers with colons", "x://a:".repeat(20_000)],
    ["header names", "Cookie ".repeat(20_000)],
    ["key prefixes", "sk-".repeat(40_000)],
    ["spaces after a header name", `Authorization${" ".repeat(100_000)}`]
  ])("%s", (_name, text) => {
    const { log } = realLogger();
    expect(timed(() => sanitizeLogText(text))).toBeLessThan(CEILING_MS);
    expect(timed(() => log.warn(text))).toBeLessThan(CEILING_MS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(timed(() => defaultOnPgBossError(new Error(text)))).toBeLessThan(CEILING_MS);
    stderr.mockRestore();
  });

  it("a shared sub-object is not expanded again and again", () => {
    let node: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 5; level++) {
      const next: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) next[`k${i}`] = node;
      node = next;
    }
    const { log, output } = realLogger();
    expect(timed(() => log.warn({ node }, "dag"))).toBeLessThan(CEILING_MS);
    expect(output().length).toBeLessThan(200_000);
  });
});
