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
 * Every way to name a console method or a stdout/stderr write: dotted (`console.error`),
 * bracketed (`console["error"]`) and `process.stderr.write` in either style. A match that is not
 * called on the spot (an alias, a bind, a destructure) is an offender by itself.
 */
const QUOTE = String.raw`["'\x60]`;
const WRITER_REFERENCE = new RegExp(
  String.raw`\bconsole\s*(?:\.\s*\w+|\[\s*${QUOTE}\w+${QUOTE}\s*\])` +
    String.raw`|\bprocess\s*(?:\.\s*|\[\s*${QUOTE})(?:stderr|stdout)(?:${QUOTE}\s*\])?` +
    String.raw`\s*(?:\.\s*write\b|\[\s*${QUOTE}write${QUOTE}\s*\])`,
  "g"
);
/** `console` used as a value (passed, aliased or destructured) rather than with a member. */
const BARE_CONSOLE = /\bconsole\b(?!\s*(?:\.|\[))/g;
/** `process.stderr` or `process.stdout` used as a value, so a later `.write` is out of sight. */
const BARE_STREAM = new RegExp(
  String.raw`\bprocess\s*(?:\.\s*(?:stderr|stdout)|\[\s*${QUOTE}(?:stderr|stdout)${QUOTE}\s*\])` +
    String.raw`(?!\s*(?:\.\s*write\b|\[\s*${QUOTE}write${QUOTE}\s*\]))(?![\w$])`,
  "g"
);
const SANITIZER_CALL = /^(?:sanitizeLog\w*|writeSanitizedFatal)\s*\(/;

/** Index just past the quote or template literal that starts at `i`. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i]!;
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "\\") j += 2;
    else if (quote === "`" && ch === "$" && text[j + 1] === "{") j = skipTemplateExpr(text, j + 2);
    else if (ch === quote) return j + 1;
    else j++;
  }
  return text.length;
}

/** Index just past the `}` that closes a template expression whose body starts at `i`. */
function skipTemplateExpr(text: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === '"' || ch === "'" || ch === "`") j = skipQuoted(text, j);
    else {
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return j + 1;
      j++;
    }
  }
  return text.length;
}

/** Split a call's arguments at top-level commas. `end` is the index of the closing paren. */
function splitArguments(text: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let start = open;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push(text.slice(start, i));
        return { args, end: i };
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  args.push(text.slice(start));
  return { args, end: text.length };
}

/** True when the whole argument is a call to a sanitizer. */
function isSanitizerCall(arg: string): boolean {
  const match = SANITIZER_CALL.exec(arg);
  if (!match) return false;
  return splitArguments(arg, match[0].length).end === arg.length - 1;
}

/** Expression texts inside a template literal, or null when `arg` is not one whole template. */
function templateExpressions(arg: string): string[] | null {
  if (arg[0] !== "`" || skipQuoted(arg, 0) !== arg.length) return null;
  const out: string[] = [];
  let j = 1;
  while (j < arg.length - 1) {
    if (arg[j] === "\\") j += 2;
    else if (arg[j] === "$" && arg[j + 1] === "{") {
      const end = skipTemplateExpr(arg, j + 2);
      out.push(arg.slice(j + 2, end - 1).trim());
      j = end;
    } else j++;
  }
  return out;
}

/**
 * An argument is safe when it is a plain string literal, a whole call to a sanitizer, or a
 * template whose every interpolation is itself a sanitizer call. Text that merely mentions a
 * sanitizer inside a string does not count.
 */
function isSafeArgument(raw: string): boolean {
  const arg = raw.trim();
  if (arg === "") return true;
  if (/^(["'])(?:\\.|(?!\1)[^\\])*\1$/s.test(arg)) return true;
  const expressions = templateExpressions(arg);
  if (expressions) return expressions.every(isSanitizerCall);
  return isSanitizerCall(arg);
}

/**
 * Return `file:line` for every console.* or stdout/stderr write with an argument that is not
 * safe, unless a log-safe marker sits on its line or the line before. Each argument is judged on
 * its own, so one sanitized argument does not excuse a raw one beside it.
 */
export function findRawErrorWriters(files: Array<{ path: string; text: string }>): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    const flag = (index: number): void => {
      const line = text.slice(0, index).split("\n").length;
      const nearby = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      const entry = `${path}:${line}`;
      if (!/log-safe:/.test(nearby) && !offenders.includes(entry)) offenders.push(entry);
    };
    for (const match of text.matchAll(WRITER_REFERENCE)) {
      const index = match.index ?? 0;
      const after = index + match[0].length;
      const call = /^\s*\(/.exec(text.slice(after, after + 40));
      // A reference that is not called here could be called later with raw text.
      if (!call) {
        flag(index);
        continue;
      }
      const { args } = splitArguments(text, after + call[0].length);
      if (!args.every(isSafeArgument)) flag(index);
    }
    for (const match of text.matchAll(BARE_CONSOLE)) flag(match.index ?? 0);
    for (const match of text.matchAll(BARE_STREAM)) flag(match.index ?? 0);
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

  it("judges each argument on its own", () => {
    const text = "console.error(sanitizeLogText('safe'), err.message);";
    expect(findRawErrorWriters([{ path: "m.ts", text }])).toEqual(["m.ts:1"]);
  });

  it("rejects a string that only mentions a sanitizer call", () => {
    const planted = [
      { path: "q1.ts", text: 'console.error("sanitizeLogText(fake)" + err.message);' },
      { path: "q2.ts", text: "console.error(`sanitizeLogText(fake) ${err.message}`);" },
      { path: "q3.ts", text: "console.error(err.message, 'sanitizeLogText(fake)');" }
    ];
    expect(findRawErrorWriters(planted)).toEqual(["q1.ts:1", "q2.ts:1", "q3.ts:1"]);
  });

  it("accepts plain string literals and sanitized templates", () => {
    const ok = [
      { path: "k1.ts", text: 'console.log("worker ready");' },
      { path: "k2.ts", text: "console.error(`x ${sanitizeLogText(e.message)} y`);" }
    ];
    expect(findRawErrorWriters(ok)).toEqual([]);
  });

  it("flags an aliased writer", () => {
    const planted = [
      { path: "a1.ts", text: "const w = console.error;\nw(err.message);" },
      { path: "a2.ts", text: "const { error } = console;" },
      { path: "a3.ts", text: "const w = process.stderr.write.bind(process.stderr);" },
      { path: "a4.ts", text: "run(console);" }
    ];
    expect(findRawErrorWriters(planted)).toEqual(["a1.ts:1", "a2.ts:1", "a3.ts:1", "a4.ts:1"]);
  });

  it("flags a stream held in a variable", () => {
    const planted = [
      { path: "s1.ts", text: "const output = process.stderr;\noutput.write(err.message);" },
      { path: "s2.ts", text: "const out = process.stdout;" },
      { path: "s3.ts", text: 'const o = process["stderr"];' },
      { path: "s4.ts", text: "const { write } = process.stderr;" },
      { path: "s5.ts", text: "emit(target ?? process.stdout);" }
    ];
    expect(findRawErrorWriters(planted)).toEqual([
      "s1.ts:1",
      "s2.ts:1",
      "s3.ts:1",
      "s4.ts:1",
      "s5.ts:1"
    ]);
  });

  it("accepts a marked stream reference", () => {
    const ok = [
      { path: "s6.ts", text: "// log-safe: wrapped by the sanitizer\nwrap(process.stdout);" }
    ];
    expect(findRawErrorWriters(ok)).toEqual([]);
  });

  it("flags bracket-style writers", () => {
    const planted = [
      { path: "b1.ts", text: 'console["error"](err.message);' },
      { path: "b2.ts", text: "console['warn'](err.message);" },
      { path: "b3.ts", text: 'process["stderr"].write(err.message);' },
      { path: "b4.ts", text: 'process.stdout["write"](err.message);' },
      { path: "b5.ts", text: "console.table(err);" }
    ];
    expect(findRawErrorWriters(planted)).toEqual([
      "b1.ts:1",
      "b2.ts:1",
      "b3.ts:1",
      "b4.ts:1",
      "b5.ts:1"
    ]);
  });

  it("accepts a sanitized bracket-style call", () => {
    const ok = [{ path: "c1.ts", text: 'console["error"](sanitizeLogText(e.message));' }];
    expect(findRawErrorWriters(ok)).toEqual([]);
  });
});
