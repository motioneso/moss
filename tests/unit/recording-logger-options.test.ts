import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";

function capture(): { lines: string[]; stream: { write(chunk: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (chunk: string) => void lines.push(chunk) } };
}

describe("recordingLoggerOptions sanitized output", () => {
  it("masks secrets before a line reaches the caller's stream", async () => {
    const { lines, stream } = capture();
    const server = Fastify({ logger: recordingLoggerOptions({ stream, level: "info" }) });
    server.log.warn(
      {
        err: new Error("db postgres://u:SECRET-CANARY@h/x"),
        header: "Authorization: Bearer xyz12345"
      },
      "failed with Cookie: sid=COOKIE-CANARY"
    );
    await server.close();
    const out = lines.join("");
    expect(out).toContain("failed with");
    expect(out).not.toMatch(/SECRET-CANARY|xyz12345|COOKIE-CANARY/);
  });

  it("keeps a logger of false as false", () => {
    expect(recordingLoggerOptions(false)).toBe(false);
  });

  it("keeps the caller's level and serializers", async () => {
    const { lines, stream } = capture();
    const options = recordingLoggerOptions({
      stream,
      level: "warn",
      serializers: { tag: (value: string) => `tag-${value}` }
    });
    const server = Fastify({ logger: options });
    server.log.info("below level");
    server.log.warn({ tag: "a" }, "at level");
    await server.close();
    const out = lines.join("");
    expect(out).not.toContain("below level");
    expect(out).toContain("tag-a");
  });

  it("still redacts the configured request paths", async () => {
    const { lines, stream } = capture();
    const server = Fastify({ logger: recordingLoggerOptions({ stream }) });
    server.log.warn({ req: { headers: { cookie: "sid=abc12345" } } }, "req");
    await server.close();
    expect(lines.join("")).not.toContain("abc12345");
  });

  it("adds an output stream when the caller gave none", () => {
    const options = recordingLoggerOptions(undefined);
    expect(options).toMatchObject({ stream: expect.anything() });
  });
});
