/**
 * Checks on real Fastify/pino output and real stderr writes for secret-bearing key names, URL
 * passwords with odd characters, request logging, caller formatters and work bounds.
 */
import Fastify, { type FastifyServerOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import { defaultOnPgBossError } from "../../packages/jobs/src/pg-boss.js";
import { sanitizeLogValue } from "../../packages/shared/src/log-sanitizer.js";

function logger(extra: Record<string, unknown> = {}): {
  server: ReturnType<typeof Fastify>;
  output: () => string;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const server = Fastify({
    logger: recordingLoggerOptions({
      level: "info",
      stream: { write: (chunk: string) => void chunks.push(chunk) },
      ...extra
    } as never) as FastifyServerOptions["logger"]
  });
  return {
    server,
    output: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

function stderrOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1a. a URL password holding an apostrophe", () => {
  const url = "https://bob:pa'ss-APOS-CANARY@host/db";

  it("is masked in pino output", () => {
    const { server, output } = logger();
    server.log.warn({ url }, `connect ${url}`);
    expect(output()).not.toContain("APOS-CANARY");
    expect(output()).not.toContain("pa'ss");
  });

  it("is masked in stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(`failed ${url}`));
    expect(stderrOutput(stderr)).not.toContain("APOS-CANARY");
  });

  it("is masked when the URL is in a JSON string with an escaped quote", () => {
    const { server, output } = logger();
    server.log.warn({ url: 'https://bob:pa"ss-QUOTE-CANARY@host/db' }, "x");
    expect(output()).not.toContain("QUOTE-CANARY");
  });
});

describe("1b. a very long URL password", () => {
  it("shows no start through the job queue error handler", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(`connect https://bob:${"p".repeat(100_000)}@host/x`));
    expect(stderrOutput(stderr)).not.toMatch(/pppp/);
  });

  it("shows no start through pino", () => {
    const { server, output } = logger();
    server.log.warn(`connect https://bob:${"p".repeat(100_000)}@host/x`);
    expect(output()).not.toMatch(/pppp/);
  });

  it("an input past the hard ceiling is dropped unread", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(`connect https://bob:${"p".repeat(2_000_000)}@host/x`));
    expect(stderrOutput(stderr)).not.toMatch(/pppp/);
  });
});

describe("2. secret-looking key names", () => {
  const urlKey = "https://bob:KEY-URL-CANARY@host/db";
  const apiKey = "sk-ant-KEYNAME1234567890";

  it("are masked in pino context", () => {
    const { server, output } = logger();
    server.log.warn({ [urlKey]: 1, [apiKey]: 2 }, "keys");
    expect(output()).not.toContain("KEY-URL-CANARY");
    expect(output()).not.toContain("KEYNAME1234567890");
  });

  it("are masked in child logger bindings", () => {
    const { server, output } = logger();
    server.log.child({ [urlKey]: 1, [apiKey]: 2 }).warn("child");
    expect(output()).not.toContain("KEY-URL-CANARY");
    expect(output()).not.toContain("KEYNAME1234567890");
  });

  it("a very long key is cut", () => {
    const { server, output } = logger();
    server.log.warn({ [`https://bob:${"p".repeat(5000)}@h`]: 1 }, "long key");
    expect(output()).not.toMatch(/pppp/);
  });
});

describe("3. serializers, Dates and caller formatters", () => {
  it("a normal request log keeps method, url and status, and a Date stays a date", async () => {
    const { server, lines } = logger();
    server.get("/hello", async (req) => {
      req.log.info({ when: new Date("2026-01-02T03:04:05.000Z") }, "handled");
      return { ok: true };
    });
    await server.inject({ method: "GET", url: "/hello" });
    const all = lines();
    const incoming = all.find((l) => l.msg === "incoming request");
    const completed = all.find((l) => l.msg === "request completed");
    const handled = all.find((l) => l.msg === "handled");
    expect(incoming?.req).toMatchObject({ method: "GET", url: "/hello" });
    expect(completed?.res).toMatchObject({ statusCode: 200 });
    expect(handled?.when).toBe("2026-01-02T03:04:05.000Z");
  });

  it("keeps a caller-configured log formatter", () => {
    const { server, lines } = logger({
      formatters: { log: (o: Record<string, unknown>) => ({ ...o, added: "by-caller" }) }
    });
    server.log.warn({ a: 1 }, "composed");
    const line = lines().find((l) => l.msg === "composed");
    expect(line).toMatchObject({ a: 1, added: "by-caller" });
  });

  it("keeps a caller-configured serializer", () => {
    const { server, lines } = logger({ serializers: { thing: () => "SERIALIZED" } });
    server.log.warn({ thing: { x: 1 } }, "ser");
    expect(lines().find((l) => l.msg === "ser")?.thing).toBe("SERIALIZED");
  });

  it("an error under err keeps its message and is still masked", () => {
    const { server, lines } = logger();
    server.log.error({ err: new Error("failed postgres://u:ERR-CANARY@h/db") }, "boom");
    const line = lines().find((l) => l.msg === "boom");
    expect(JSON.stringify(line)).toContain("failed");
    expect(JSON.stringify(line)).not.toContain("ERR-CANARY");
  });
});

describe("4. work bounds and binary sizes", () => {
  const CEILING_MS = 400;

  it.each([10_000, 100_000, 1_000_000])("an object with %i fields", (count) => {
    const big: Record<string, number> = {};
    for (let i = 0; i < count; i++) big[`f${i}`] = i;
    const { server, output } = logger();
    const start = performance.now();
    server.log.warn({ big }, "wide");
    expect(performance.now() - start).toBeLessThan(CEILING_MS);
    expect(output().length).toBeLessThan(20_000);
  });

  it("an object past the node budget is not listed", () => {
    const wide: Record<string, unknown>[] = [];
    for (let i = 0; i < 3000; i++) {
      const o: Record<string, number> = {};
      for (let j = 0; j < 50; j++) o[`k${j}`] = j;
      wide.push(o);
    }
    const start = performance.now();
    sanitizeLogValue({ a: wide, b: wide, c: wide });
    expect(performance.now() - start).toBeLessThan(CEILING_MS);
  });

  it("reports the true size of binary values", () => {
    expect(sanitizeLogValue({ b: Buffer.from("abc").toJSON() })).toEqual({
      b: "[binary 3 bytes]"
    });
    expect(sanitizeLogValue({ s: new SharedArrayBuffer(8) })).toEqual({ s: "[binary 8 bytes]" });
    expect(sanitizeLogValue({ u: new Uint8Array(5) })).toEqual({ u: "[binary 5 bytes]" });
  });
});
