import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  createApiLogSink,
  recordingLoggerOptions
} from "../../apps/api/src/recording-logger-options.js";
import {
  createDiagnosticLogDestination,
  withLogOwner,
  type DiagnosticLogRow,
  type DiagnosticLogSink
} from "@moss/settings";
import { createSanitizingFormatters } from "@moss/shared";

// #3978 slice 2C: stdout and the stored copy are both built from sanitized text, owners come only
// from a bound uuid, and labels come only from the fixed lists.

const CANARY = "SECRET-CANARY-7731";
const OWNER = "00000000-0000-4000-8000-0000000000b1";

/** A pino logger built the way the worker builds its own (Fastify bundles pino). */
function makeLogger(base: Record<string, unknown>, stream: unknown) {
  return Fastify({
    logger: {
      level: "info",
      base,
      formatters: createSanitizingFormatters(),
      stream
    } as never
  }).log;
}

function harness(sinkOverride?: Partial<DiagnosticLogSink>) {
  const lines: string[] = [];
  const rows: DiagnosticLogRow[] = [];
  const sink: DiagnosticLogSink = {
    enqueue: (r) => void rows.push(r),
    flush: async () => {},
    close: async () => {},
    stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 }),
    ...sinkOverride
  };
  const logger = makeLogger(
    { process: "worker" },
    createDiagnosticLogDestination({
      process: "worker",
      target: { write: (c: string) => void lines.push(c) },
      sink
    })
  );
  return { lines, rows, logger };
}

describe("diagnostic log destination", () => {
  it("masks a secret in both the stream and the stored row", () => {
    const { lines, rows, logger } = harness();
    logger.warn(
      { header: `Authorization: Bearer ${CANARY}`, err: new Error(`postgres://u:${CANARY}@h/x`) },
      `failed with Cookie: sid=${CANARY}`
    );
    expect(lines.join("")).not.toContain(CANARY);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });

  it("keeps lines below warn out of the table but on the stream", () => {
    const { lines, rows, logger } = harness();
    logger.info("just info");
    logger.warn("a warning");
    expect(lines).toHaveLength(2);
    expect(rows.map((r) => r.message)).toEqual(["a warning"]);
    expect(rows[0]).toMatchObject({ level: 40, process: "worker" });
  });

  it("tags the owner from a bound uuid and leaves everything else unowned", () => {
    const { rows, logger } = harness();
    withLogOwner(logger, OWNER).warn("owned");
    logger.warn("unknown owner");
    withLogOwner(logger, "not-a-uuid").warn("guessed owner");
    withLogOwner(logger, "alice@example.test").warn("text owner");
    expect(rows.map((r) => r.ownerUserId)).toEqual([OWNER, null, null, null]);
  });

  it("does not infer an owner from message text or a context field", () => {
    const { rows, logger } = harness();
    logger.warn({ owner: OWNER, userId: OWNER }, `for user ${OWNER}`);
    expect(rows[0]!.ownerUserId).toBeNull();
  });

  it("keeps labels to the fixed lists", () => {
    const { rows, logger } = harness();
    logger
      .child({ module: "connectors" })
      .warn({ connectionKind: "google", eventCode: "auth-failed" }, "ok labels");
    logger
      .child({ module: "mail-for-alice@example.test" })
      .warn(
        { connectionKind: "alice-inbox", eventCode: "alice said no", component: "x" },
        "bad labels"
      );
    expect(rows[0]).toMatchObject({
      component: "connectors",
      connectionKind: "google",
      eventCode: "auth-failed"
    });
    expect(rows[1]).toMatchObject({ component: "worker", connectionKind: null, eventCode: null });
    expect(JSON.stringify(rows[1])).not.toContain("alice-inbox");
  });

  it("keeps the row within the message and context size limits", () => {
    const { rows, logger } = harness();
    logger.warn({ blob: "z".repeat(50_000) }, "big ".repeat(5000));
    const row = rows[0]!;
    expect(Buffer.byteLength(row.message)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(row.context))).toBeLessThanOrEqual(2048);
    expect(row.truncated).toBe(true);
  });

  it("keeps logging when the sink throws", () => {
    const { lines, logger } = harness({
      enqueue: () => {
        throw new Error("sink exploded");
      }
    });
    expect(() => logger.warn("still fine")).not.toThrow();
    expect(lines.join("")).toContain("still fine");
  });

  it("drops its stream copy once the stream backlog passes 256 KB but still stores", () => {
    const rows: DiagnosticLogRow[] = [];
    const written: string[] = [];
    const stalled = {
      writableLength: 300 * 1024,
      write: (c: string) => void written.push(c)
    };
    const logger = makeLogger(
      { process: "api" },
      createDiagnosticLogDestination({
        process: "api",
        target: stalled,
        sink: {
          enqueue: (r) => void rows.push(r),
          flush: async () => {},
          close: async () => {},
          stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
        }
      })
    );
    logger.warn("stalled");
    expect(written).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });
});

describe("api wiring", () => {
  it("builds no sink when logging is off", () => {
    expect(createApiLogSink(false, {} as never)).toBeNull();
    expect(recordingLoggerOptions(false, { sink: null })).toBe(false);
  });

  it("masks a request-time warning in the stream and the row, and ignores a sink fault", async () => {
    const lines: string[] = [];
    const rows: DiagnosticLogRow[] = [];
    const sink: DiagnosticLogSink = {
      enqueue: (r) => void rows.push(r),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
    };
    const server = Fastify({
      logger: recordingLoggerOptions(
        { stream: { write: (c: string) => void lines.push(c) }, level: "info" } as never,
        { sink }
      )
    });
    server.get("/w", async (request) => {
      request.log.warn(`Authorization: Bearer ${CANARY}`);
      return { ok: true };
    });
    const res = await server.inject("/w");
    await server.close();
    expect(res.statusCode).toBe(200);
    expect(lines.join("")).not.toContain(CANARY);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    expect(rows.some((r) => r.process === "api")).toBe(true);

    const broken: DiagnosticLogSink = {
      ...sink,
      enqueue: () => {
        throw new Error("sink down");
      }
    };
    const server2 = Fastify({
      logger: recordingLoggerOptions({ stream: { write: () => {} }, level: "info" } as never, {
        sink: broken
      })
    });
    server2.get("/w", async (request) => {
      request.log.warn("x");
      return { ok: true };
    });
    expect((await server2.inject("/w")).statusCode).toBe(200);
    await server2.close();
  });
});
