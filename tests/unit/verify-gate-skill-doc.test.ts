import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe(".claude/skills/verify-gate/SKILL.md", () => {
  it("documents the non-blocking --follow wait and drops the old foreground 600000 ms instruction", async () => {
    const doc = await readFile(
      new URL("../../.claude/skills/verify-gate/SKILL.md", import.meta.url),
      "utf8"
    );

    expect(doc).toContain("--follow");
    expect(doc).toContain("run_in_background");
    expect(doc).not.toMatch(/600000\s*ms/);
  });
});
