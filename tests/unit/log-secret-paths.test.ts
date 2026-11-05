import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createDiagnosticLogDestination, type DiagnosticLogRow } from "@moss/settings";
import { createSanitizingFormatters } from "@moss/shared";

// #3978 slice 2D: a secret inside a logged error never reaches the stored row or the process
// output.

const SECRET = "sk-uat3978-planted-secret-token-0001";

function run(processName: "api" | "worker") {
  const rows: DiagnosticLogRow[] = [];
  const output: string[] = [];
  const stream = createDiagnosticLogDestination({
    process: processName,
    target: {
      write: (line: string) => {
        output.push(line);
        return true;
      }
    },
    sink: {
      enqueue: (r) => void rows.push(r),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
    }
  });
  const logger = Fastify({
    logger: {
      level: "info",
      base: { process: processName },
      formatters: createSanitizingFormatters(),
      stream
    } as never
  }).log;
  logger.warn({ err: new Error(`Unknown connector key id: ${SECRET}`) }, "request error");
  return JSON.stringify({ rows, output });
}

describe.each(["api", "worker"] as const)("%s destination", (processName) => {
  it("keeps a planted secret out of the stored row and the output", () => {
    expect(run(processName)).not.toContain(SECRET);
  });
});
