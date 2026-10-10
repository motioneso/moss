import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Real-chat specs whose assertions name Codex internals; a Claude run must skip, not fail.
const CODEX_ONLY = ["tools-volume-adapter.uat.spec.ts", "3065-app-actions-real.uat.spec.ts"];

const source = (spec: string) => readFile(new URL(`../uat/specs/${spec}`, import.meta.url), "utf8");

function problems(text: string): string[] {
  const found: string[] = [];
  if (!/const CODEX_SELECTED = uatRealChatProvider\(\) === "codex";/.test(text)) {
    found.push("does not read the real-chat provider");
  }
  if (!/test\.skip\(\s*!REAL_CHAT_CONFIGURED \|\| !CODEX_SELECTED,/.test(text)) {
    found.push("runs under Claude");
  }
  return found;
}

describe("Codex-only real-chat specs skip under Claude (#3361)", () => {
  it.each(CODEX_ONLY)("%s skips unless Codex is selected", async (spec) => {
    expect(problems(await source(spec))).toEqual([]);
  });

  it.each(CODEX_ONLY)("negative control: %s without the provider check is caught", async (spec) => {
    const text = await source(spec);
    const next = text.replace(
      "!REAL_CHAT_CONFIGURED || !CODEX_SELECTED,",
      "!REAL_CHAT_CONFIGURED,"
    );
    expect(next).not.toBe(text);
    expect(problems(next)).toContain("runs under Claude");
  });
});
