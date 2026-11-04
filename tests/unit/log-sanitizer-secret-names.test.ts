/**
 * One list of secret field names, checked as object keys and as text (JSON, key=value and
 * key: value, either quote kind, values with spaces), on real pino output and real stderr.
 */
import Fastify, { type FastifyServerOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import {
  runApiStartup,
  shutdownOnSignal,
  createCrashHandler as createApiCrashHandler
} from "../../apps/api/src/process-lifecycle.js";
import { createCrashHandler as createWorkerCrashHandler } from "../../apps/worker/src/worker.js";
import { defaultOnPgBossError } from "../../packages/jobs/src/pg-boss.js";
import {
  isSecretName,
  sanitizeLogText,
  writeSanitizedFatal
} from "../../packages/shared/src/log-sanitizer.js";

const NAMES = [
  "password",
  "Password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apiKey",
  "api key",
  "API KEY",
  "api_key",
  "api-key",
  "api.key",
  "x-api-key",
  "privateKey",
  "private key",
  "private.key",
  "PRIVATE_KEY",
  "authorization",
  "cookie",
  "credential",
  "session id",
  "sessionId",
  "session_id",
  "bearer",
  "clientSecret",
  "client_secret",
  "accessKey",
  "access-key",
  "secretKey",
  "signing key",
  "encryption key",
  "DB_PASSWORD",
  "refreshToken"
];

function logger(extra: Record<string, unknown> = {}): {
  server: ReturnType<typeof Fastify>;
  output: () => string;
} {
  const chunks: string[] = [];
  const server = Fastify({
    logger: recordingLoggerOptions({
      level: "info",
      stream: { write: (chunk: string) => void chunks.push(chunk) },
      ...extra
    } as never) as FastifyServerOptions["logger"]
  });
  return { server, output: () => chunks.join("") };
}

function stderrOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Text spellings of one secret under `name`. */
function textForms(name: string): string[] {
  return [
    `{"${name}":"first SPACE-CANARY"}`,
    `{"${name}": "pa'ss-APOS-CANARY"}`,
    `{'${name}':'pa"ss SPACE-CANARY'}`,
    `${name}="two words SPACE-CANARY"`,
    `${name}: 'two words SPACE-CANARY'`,
    `${name}=BARE-CANARY`,
    `{\\"${name}\\":\\"esc SPACE-CANARY\\"}`,
    `{"${name}":"esc \\" quote SPACE-CANARY"}`,
    `${name}='it\\'s SPACE-CANARY'`
  ];
}

describe("the name list", () => {
  it.each(NAMES)("recognises %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(["author", "keyboard", "username", "name", "message", "count", "url"])(
    "leaves %s alone",
    (name) => {
      expect(isSecretName(name)).toBe(false);
    }
  );
});

describe("secret names as object keys, on real pino output", () => {
  it.each(NAMES)("%s", (name) => {
    const { server, output } = logger();
    server.log.warn({ [name]: "KEY-VALUE-CANARY" }, "keyed");
    server.log.child({ [name]: "CHILD-VALUE-CANARY" }).warn("child");
    expect(output()).not.toContain("KEY-VALUE-CANARY");
    expect(output()).not.toContain("CHILD-VALUE-CANARY");
  });
});

describe("secret names in text, on real pino output and stderr", () => {
  it.each(NAMES)("%s in a message, an error message and a nested value", (name) => {
    for (const text of textForms(name)) {
      const { server, output } = logger();
      server.log.warn({ nested: { note: text }, err: new Error(`failed ${text}`) }, text);
      expect(output(), text).not.toMatch(/CANARY/);
    }
  });

  it.each(NAMES)("%s through the job queue error handler", (name) => {
    for (const text of textForms(name)) {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      defaultOnPgBossError(new Error(text));
      expect(stderrOutput(stderr), text).not.toMatch(/CANARY/);
      stderr.mockRestore();
    }
  });

  it("keeps ordinary text readable", () => {
    expect(sanitizeLogText('{"author":"Bob","count":3} started in 12:30')).toBe(
      '{"author":"Bob","count":3} started in 12:30'
    );
  });
});

describe("values produced by caller serializers are masked too", () => {
  it("object, text and nested forms", () => {
    const { server, output } = logger({
      serializers: {
        thing: () => ({
          password: "SER-OBJECT-CANARY",
          note: '{"password":"first SER-TEXT-CANARY"}',
          deep: { "api key": "SER-DEEP-CANARY" }
        })
      }
    });
    server.log.warn({ thing: {} }, "ser");
    expect(output()).not.toMatch(/SER-[A-Z]+-CANARY/);
  });
});

describe("fatal output and process handlers write masked text to real stderr", () => {
  const hostile = `{"password":"first SPACE-CANARY"} and secret='a b SPACE-CANARY'`;

  it("the optional display message is masked", () => {
    const lines: string[] = [];
    writeSanitizedFatal("label", new Error("e"), (l) => void lines.push(l), hostile);
    expect(lines.join("")).not.toMatch(/CANARY/);
  });

  it("API startup failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runApiStartup(() => Promise.reject(new Error(hostile)), {
      exit: (() => undefined) as never
    });
    expect(stderrOutput(stderr)).not.toMatch(/CANARY/);
  });

  it("API shutdown failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await shutdownOnSignal(
      { close: (cb) => cb(new Error(hostile)) },
      { exit: (() => undefined) as never }
    );
    expect(stderrOutput(stderr)).not.toMatch(/CANARY/);
  });

  it("API crash handler through real pino", async () => {
    const { server, output } = logger();
    const exit = vi.fn();
    const handle = createApiCrashHandler(
      { log: server.log, close: (cb) => cb() },
      { exit: exit as never }
    );
    handle("uncaughtException", new Error(hostile));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(output()).not.toMatch(/CANARY/);
  });

  it("worker crash handler", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.fn();
    const handle = createWorkerCrashHandler(
      { shutdown: () => Promise.resolve() },
      { exit: exit as never }
    );
    handle("uncaughtException", new Error(hostile));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stderrOutput(stderr)).not.toMatch(/CANARY/);
  });
});
