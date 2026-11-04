/**
 * Text is masked fail-closed. From the first secret-name marker to the end of the string,
 * everything is hidden, whatever the quoting, nesting, escaping or line breaks. Checked on real
 * pino output and real stderr.
 */
import Fastify, { type FastifyServerOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import { defaultOnPgBossError } from "../../packages/jobs/src/pg-boss.js";
import { isSecretName, sanitizeLogText } from "../../packages/shared/src/log-sanitizer.js";

const FORMS = [
  JSON.stringify(JSON.stringify({ password: 'start " inside TAIL_CANARY' })),
  JSON.stringify({ password: 'start " inside TAIL_CANARY' }),
  'password="line one\nTAIL_CANARY"',
  '{"password":"line one\r\nTAIL_CANARY"}',
  '{"pass phrase":"X-CANARY"}',
  "pass_phrase=X-CANARY",
  "pass.word: X-CANARY",
  '{"api key value":"X-CANARY"}',
  '{"passwordWithAVeryLongSuffixNameThatKeepsGoing":"X-CANARY"}',
  '{"password": {"value": "X-CANARY"}}',
  '{"outer":{"password":{"a":["X-CANARY",{"b":"X-CANARY"}]}}}',
  `{'password':'it''s X-CANARY'}`,
  `{"password":'mixed " and \\' X-CANARY'}`,
  '{\\"password\\": {\\"value\\": \\"X-CANARY\\"}}',
  'Authorization: Digest username="al"\nresponse="X-CANARY"',
  "PRIVATE KEY: -----BEGIN-----\nX-CANARY\n-----END-----"
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fail-closed text masking, on real pino output and stderr", () => {
  it.each(FORMS.map((text, i) => [i, text] as const))("form %i", (_i, text) => {
    const { server, output } = logger();
    server.log.warn({ nested: { note: text }, err: new Error(`failed ${text}`) }, text);
    expect(output(), text).not.toMatch(/CANARY/);

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    defaultOnPgBossError(new Error(text));
    const written = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written, text).not.toMatch(/CANARY/);
  });

  it("masks string values returned by caller serializers", () => {
    const { server, output } = logger({
      serializers: { thing: () => ({ note: FORMS[0], other: FORMS[9] }) }
    });
    server.log.warn({ thing: {} }, "ser");
    expect(output()).not.toMatch(/CANARY/);
  });

  it.each([
    "pass phrase",
    "pass_phrase",
    "pass.word",
    "api key value",
    "passwordWithAVeryLongSuffixNameThatKeepsGoing"
  ])("object key %s agrees with the text matcher", (name) => {
    expect(isSecretName(name)).toBe(true);
    const { server, output } = logger();
    server.log.warn({ [name]: "KEY-CANARY" }, "keyed");
    expect(output()).not.toContain("KEY-CANARY");
  });

  it.each(["secretary", "author", "keyboard", "username"])("leaves %s readable", (word) => {
    expect(isSecretName(word)).toBe(false);
    expect(sanitizeLogText(`note ${word} done`)).toBe(`note ${word} done`);
  });

  it.each(["İ", "ß", "ﬁ", "ǅ", "ŉ", "ΐ"])("keeps positions aligned after %s", (letter) => {
    const text = `${letter.repeat(12)} pass.word=INDEX_CANARY trailing-long-enough-for-position-map`;
    const { server, output } = logger();
    server.log.warn({ note: text }, text);
    expect(output(), letter).not.toMatch(/CANARY/);
    expect(sanitizeLogText(text)).not.toContain("CANARY");
  });

  it.each(["passwordKEY_CANARY=value", "token_CANARY: x", "api key CANARY value"])(
    "drops a suffix after the marker in text: %s",
    (text) => {
      const { server, output } = logger();
      server.log.warn({ note: text }, text);
      expect(output(), text).not.toMatch(/CANARY/);
    }
  );

  it("drops a suffix after the marker in an object key", () => {
    const { server, output } = logger();
    server.log.warn({ "passwordKEY_CANARY=foo": "v", nested: { tokenCANARY2: 1 } }, "keys");
    expect(output()).not.toMatch(/CANARY/);
  });

  it("stays fast on hostile input", () => {
    const start = performance.now();
    sanitizeLogText("secretary ".repeat(1600));
    sanitizeLogText("p a s s ".repeat(2000));
    sanitizeLogText("password".repeat(2000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
