/**
 * Every error writer in the API process, the worker process and the jobs package must pass its
 * text through the shared sanitizer. One test per entry point, each fed a canary secret, plus a
 * source scan that fails when a new raw writer appears.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCrashHandler as createApiCrashHandler } from "../../apps/api/src/process-lifecycle.js";
import {
  createShutdownHandler,
  bootstrap as workerBootstrap,
  createCrashHandler as createWorkerCrashHandler
} from "../../apps/worker/src/worker.js";
import {
  runApiStartup,
  shutdownOnSignal as apiShutdownOnSignal
} from "../../apps/api/src/process-lifecycle.js";
import { defaultOnPgBossError } from "../../packages/jobs/src/pg-boss.js";

const CANARY = "SECRET-CANARY";
const SECRET_MESSAGE = `connect failed postgres://u:${CANARY}@h/db`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error entry points never write a secret", () => {
  it("1. the job queue error handler", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(SECRET_MESSAGE));
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("pgboss.internal_error");
    expect(out).not.toContain(CANARY);
  });

  it("2. the worker crash handler", () => {
    const log = vi.fn();
    const exit = vi.fn();
    const handle = createWorkerCrashHandler(
      { shutdown: () => Promise.resolve() },
      { log, exit: exit as unknown as (code: number) => never }
    );
    handle("uncaughtException", new Error(SECRET_MESSAGE));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(CANARY);
  });

  it("3. the API crash handler", () => {
    const error = vi.fn();
    const handle = createApiCrashHandler(
      { log: { error }, close: (cb) => cb() },
      { exit: vi.fn() as unknown as (code: number) => never }
    );
    handle("uncaughtException", new Error(SECRET_MESSAGE));
    expect(error).toHaveBeenCalledTimes(1);
    expect(inspect(error.mock.calls[0], { depth: 10 })).not.toContain(CANARY);
  });

  it("4a. a worker startup failure", async () => {
    const log = vi.fn();
    const exit = vi.fn();
    await workerBootstrap({
      build: () => Promise.reject(new Error(SECRET_MESSAGE)),
      log,
      exit: exit as unknown as (code: number) => never
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(CANARY);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("4b. an API startup failure", async () => {
    const log = vi.fn();
    const exit = vi.fn();
    await runApiStartup(() => Promise.reject(new Error(SECRET_MESSAGE)), {
      log,
      exit: exit as unknown as (code: number) => never
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(CANARY);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("5a. a worker shutdown failure", async () => {
    const log = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdownHandler(
      { shutdown: () => Promise.reject(new Error(SECRET_MESSAGE)) },
      { log, exit: exit as unknown as (code: number) => never }
    );
    await shutdown();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(CANARY);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("5b. an API shutdown failure", async () => {
    const log = vi.fn();
    const exit = vi.fn();
    await apiShutdownOnSignal(
      { close: (cb) => cb(new Error(SECRET_MESSAGE)) },
      { log, exit: exit as unknown as (code: number) => never }
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(CANARY);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

/** Directories whose error output must be sanitized. */
const SCANNED_DIRS = ["apps/api/src", "apps/worker/src", "packages/jobs/src"];
const RAW_WRITER =
  /\b(?:console\.(?:log|info|warn|error|debug|trace)|process\.(?:stderr|stdout)\.write)\s*\(/g;
const SANITIZED_ARGUMENT = /\b(?:sanitizeLog\w*|writeSanitizedFatal)\s*\(/;

/** Text of a call's argument list, from just after the opening paren to its matching paren. */
function callArguments(text: string, open: number): string {
  let depth = 1;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return text.slice(open, i);
    }
  }
  return text.slice(open);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Return `file:line` for every console.* or stdout/stderr write whose own arguments are not
 * wrapped in a sanitizer call and that has no log-safe marker on its line or the line before.
 * A sanitizer call elsewhere nearby does not count.
 */
export function findRawErrorWriters(files: Array<{ path: string; text: string }>): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    for (const match of text.matchAll(RAW_WRITER)) {
      const index = match.index ?? 0;
      const args = callArguments(text, index + match[0].length);
      if (SANITIZED_ARGUMENT.test(args)) continue;
      const line = text.slice(0, index).split("\n").length;
      const nearby = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      if (/log-safe:/.test(nearby)) continue;
      offenders.push(`${path}:${line}`);
    }
  }
  return offenders;
}

describe("process loggers use the sanitized output stream", () => {
  it("builds the worker logger on the sanitizing destination", () => {
    const text = readFileSync(join(__dirname, "..", "..", "apps/worker/src/worker.ts"), "utf8");
    expect(text).toMatch(/pino\([^;]*createSanitizedLogDestination\(/s);
  });

  it("builds the API logger options on the sanitizing destination", () => {
    const text = readFileSync(
      join(__dirname, "..", "..", "apps/api/src/recording-logger-options.ts"),
      "utf8"
    );
    expect(text).toContain("createSanitizedLogDestination(");
  });
});

describe("source scan for raw error writers", () => {
  it("finds none in the API, worker and jobs sources", () => {
    const root = join(__dirname, "..", "..");
    const files = SCANNED_DIRS.flatMap((d) => sourceFiles(join(root, d))).map((path) => ({
      path: path.slice(root.length + 1),
      text: readFileSync(path, "utf8")
    }));
    expect(files.length).toBeGreaterThan(5);
    expect(findRawErrorWriters(files)).toEqual([]);
  });

  it("flags a new raw writer", () => {
    const planted = [
      { path: "x.ts", text: "function f(e: Error) {\n  console.error(e.message);\n}\n" },
      { path: "y.ts", text: "process.stderr.write(`${err.message}\\n`);" }
    ];
    expect(findRawErrorWriters(planted)).toEqual(["x.ts:2", "y.ts:1"]);
  });

  it("accepts a writer that sanitizes or is marked log-safe", () => {
    const ok = [
      { path: "a.ts", text: "console.error(sanitizeLogText(e.message));" },
      { path: "b.ts", text: "// log-safe: constant event name\nprocess.stderr.write(line);" }
    ];
    expect(findRawErrorWriters(ok)).toEqual([]);
  });

  it("flags a raw message even when an unrelated sanitizer call is nearby", () => {
    const text = [
      "const a = sanitizeLogText(other);",
      "console.error(err.message);",
      "sanitizeLogText(more);"
    ].join("\n");
    expect(findRawErrorWriters([{ path: "z.ts", text }])).toEqual(["z.ts:2"]);
  });

  it("covers every console method and stdout writes", () => {
    const planted = ["log", "info", "warn", "error", "debug", "trace"].map((m, i) => ({
      path: `c${i}.ts`,
      text: `console.${m}(err.message);`
    }));
    planted.push({ path: "o.ts", text: "process.stdout.write(err.message);" });
    expect(findRawErrorWriters(planted)).toHaveLength(7);
  });

  it("handles nested calls and quotes inside the arguments", () => {
    const ok = [
      { path: "n.ts", text: 'console.error(`x ${sanitizeLogText(String(e))} (a)`, ")");' }
    ];
    expect(findRawErrorWriters(ok)).toEqual([]);
  });
});
