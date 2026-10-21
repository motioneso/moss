import { describe, expect, it } from "vitest";

import { createStreamRedactor } from "../../packages/cli-runner/src/stderr-redactor.js";

// No "sk-" prefix, so the generic secret patterns cannot hide a redactor bug.
const KEY = "localproxy0004neverlog";
const LINE = `upstream said ${KEY} is not valid\n`;
const MASKED = "upstream said [redacted] is not valid\n";

function run(secret: string | undefined, chunks: readonly (string | Buffer)[]): string {
  const redactor = createStreamRedactor(secret);
  const pushed = chunks.map((chunk) => redactor.push(Buffer.from(chunk))).join("");
  return pushed + redactor.flush();
}

const splits = Array.from({ length: KEY.length - 1 }, (_, index) => index + 1);

describe("createStreamRedactor", () => {
  it("passes text through unchanged when there is no secret", () => {
    expect(run(undefined, ["plain ", "text\n"])).toBe("plain text\n");
  });

  it.each(splits)("masks a key split after its character %i", (split) => {
    const at = LINE.indexOf(KEY) + split;
    expect(run(KEY, [LINE.slice(0, at), LINE.slice(at)])).toBe(MASKED);
  });

  it("masks a key fed one character per chunk", () => {
    expect(run(KEY, [...LINE])).toBe(MASKED);
  });

  it("masks repeats, including back-to-back copies, at every split position", () => {
    const text = `${KEY}${KEY} and ${KEY}\n`;
    for (let at = 1; at < text.length; at += 1) {
      expect(run(KEY, [text.slice(0, at), text.slice(at)])).toBe(
        "[redacted][redacted] and [redacted]\n"
      );
    }
  });

  it.each(splits)("masks a stream that ends after %i characters of the key", (length) => {
    expect(run(KEY, ["fatal: ", KEY.slice(0, length)])).toBe("fatal: [redacted]");
  });

  it("releases text that cannot start the key without waiting for more", () => {
    const redactor = createStreamRedactor(KEY);
    expect(redactor.push(Buffer.from("no secret here\n"))).toBe("no secret here\n");
  });

  it("keeps a multi-byte character split across chunks intact", () => {
    const bytes = Buffer.from("café\n");
    expect(run(KEY, [bytes.subarray(0, 4), bytes.subarray(4)])).toBe("café\n");
  });
});
