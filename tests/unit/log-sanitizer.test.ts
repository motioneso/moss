import { describe, expect, it } from "vitest";

import { redactSecrets as aiRedactSecrets } from "../../packages/ai/src/adapters/redact.js";
import {
  LOG_DROP_COUNTER,
  createSanitizedLogDestination,
  redactSecrets,
  sanitizeLogLine,
  sanitizeLogRecord,
  sanitizeLogText,
  sanitizeLogValue,
  writeSanitizedFatal
} from "../../packages/shared/src/log-sanitizer.js";

describe("sanitizeLogText", () => {
  it("masks the password in a URL and keeps user and host", () => {
    const out = sanitizeLogText("connect failed https://bob:hunter2@host/x");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("bob");
    expect(out).toContain("host");
  });

  it("masks a password that holds an at sign", () => {
    const out = sanitizeLogText("postgres://u:p@ss@db:5432/app");
    expect(out).not.toContain("p@ss");
    expect(out).toContain("db:5432");
  });

  it("masks Cookie and Set-Cookie values and keeps the header name", () => {
    const out = sanitizeLogText(
      "Cookie: sid=abcd1234; theme=dark\nSet-Cookie: refresh=zzzz9999; Path=/"
    );
    expect(out).not.toContain("abcd1234");
    expect(out).not.toContain("zzzz9999");
    expect(out).toContain("Cookie");
    expect(out).toContain("Cookie: ");
  });

  it("masks Basic and Digest Authorization values as well as Bearer", () => {
    for (const header of [
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      'Authorization: Digest username="al", response="cafef00dcafe"',
      "Authorization: Bearer xyz12345"
    ]) {
      const out = sanitizeLogText(header);
      expect(out).not.toMatch(/dXNlcjpwYXNzd29yZA|cafef00dcafe|xyz12345/);
      expect(out).toContain("Authorization");
    }
  });

  it("masks a cookie held in a JSON string", () => {
    const out = sanitizeLogText('{"cookie":"sid=abcd1234; a=b","x":1}');
    expect(out).not.toContain("abcd1234");
    expect(out).toContain("cookie");
  });
});

describe("sanitizeLogValue", () => {
  it("masks a secret at every depth of a nested error", () => {
    const err = new Error("x", { cause: new Error("token=abc12345") });
    const agg = Object.assign(new Error("agg"), { errors: [new Error("password=abc12345")] });
    const out = JSON.stringify(sanitizeLogValue({ err, agg }));
    expect(out).not.toContain("abc12345");
    expect(out).toContain("agg");
  });

  it("masks by key name even when the value looks harmless", () => {
    const out = JSON.stringify(
      sanitizeLogValue({ password: "pw", nested: { apiKey: "k1" }, ok: "fine" })
    );
    expect(out).not.toMatch(/"pw"|"k1"/);
    expect(out).toContain("fine");
  });

  it("terminates on a cyclic object", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = JSON.stringify(sanitizeLogValue(a));
    expect(out.length).toBeLessThan(1000);
  });

  it("stops at the depth, key and item bounds", () => {
    let deep: Record<string, unknown> = { leaf: "bottom-marker" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeLogValue(deep))).not.toContain("bottom-marker");
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) wide[`k${i}`] = "v";
    expect(Object.keys(sanitizeLogValue(wide) as object).length).toBeLessThanOrEqual(201);
    expect((sanitizeLogValue(new Array(1000).fill("x")) as unknown[]).length).toBeLessThanOrEqual(
      201
    );
  });

  it("bounds the work on a huge input", () => {
    const big = {
      a: "x".repeat(10_000_000),
      b: Array.from({ length: 5000 }, () => "y".repeat(1000))
    };
    const start = Date.now();
    const out = JSON.stringify(sanitizeLogValue(big));
    expect(out.length).toBeLessThan(200_000);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("sanitizeLogRecord", () => {
  it("cuts a 10 MB message to 2048 bytes and flags truncation", () => {
    const rec = sanitizeLogRecord("a".repeat(10_000_000), {});
    expect(rec).not.toBeNull();
    expect(Buffer.byteLength(rec!.message)).toBeLessThanOrEqual(2048);
    expect(rec!.truncated).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    const rec = sanitizeLogRecord("€".repeat(1000), {});
    expect(Buffer.byteLength(rec!.message)).toBeLessThanOrEqual(2048);
    expect(rec!.message).not.toContain("�");
    expect(rec!.message.length).toBe(682);
  });

  it("cuts the context to about 2048 bytes", () => {
    const rec = sanitizeLogRecord("m", { blob: "z".repeat(50_000) });
    expect(Buffer.byteLength(JSON.stringify(rec!.context))).toBeLessThanOrEqual(2200);
    expect(rec!.truncated).toBe(true);
  });

  it("does not flag a small record", () => {
    expect(sanitizeLogRecord("small", { a: 1 })!.truncated).toBe(false);
  });

  it("drops the record when sanitizing throws and never returns the raw input", () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded SECRET-CANARY");
      }
    };
    const before = LOG_DROP_COUNTER.count;
    expect(sanitizeLogRecord("m", hostile)).toBeNull();
    expect(LOG_DROP_COUNTER.count).toBe(before + 1);
  });
});

describe("sanitizeLogLine and the destination", () => {
  it("masks a pino line and keeps its shape", () => {
    const line = JSON.stringify({
      level: 40,
      time: 1,
      process: "api",
      msg: "bad Bearer xyz12345",
      url: "https://a:pw1234@h/"
    });
    const out = sanitizeLogLine(`${line}\n`)!;
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toMatch(/xyz12345|pw1234/);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.level).toBe(40);
    expect(parsed.process).toBe("api");
  });

  it("masks a line that is not JSON", () => {
    expect(sanitizeLogLine("boom token=abc12345\n")).not.toContain("abc12345");
  });

  it("returns null for a line that cannot be sanitized", () => {
    expect(sanitizeLogLine(undefined as unknown as string)).toBeNull();
  });

  it("writes only sanitized text to the target and drops failures", () => {
    const written: string[] = [];
    const dest = createSanitizedLogDestination({ write: (c: string) => written.push(c) });
    dest.write(`${JSON.stringify({ msg: "Authorization: Bearer xyz12345" })}\n`);
    dest.write(undefined as unknown as string);
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("xyz12345");
  });
});

describe("writeSanitizedFatal", () => {
  it("writes one sanitized line for an Error and for a non-Error", () => {
    const lines: string[] = [];
    writeSanitizedFatal("boot", new Error("db postgres://u:SECRET-CANARY@h/db"), (l) =>
      lines.push(l)
    );
    writeSanitizedFatal("boot", "token=SECRET-CANARY", (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toContain("SECRET-CANARY");
  });
});

describe("the older redactSecrets contract", () => {
  it("is re-exported by the ai package and behaves the same", () => {
    expect(aiRedactSecrets).toBe(redactSecrets);
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets("x JARVIS_MCP_TOKEN=jst_abc123 y")).not.toContain("jst_abc123");
  });
});
