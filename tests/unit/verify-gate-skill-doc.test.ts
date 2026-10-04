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

  it("documents the throwaway per-run server and concurrent-gate safety (#2989)", async () => {
    const doc = await readFile(
      new URL("../../.claude/skills/verify-gate/SKILL.md", import.meta.url),
      "utf8"
    );

    expect(doc).toContain("GATE_CONTAINER");
    expect(doc).toMatch(/throwaway/i);
    expect(doc).not.toContain("Stagger with other sessions");
    expect(doc).toContain("verify:foundation");
  });

  it("documents that bare database-touching commands are hook-blocked", async () => {
    const doc = await readFile(
      new URL("../../.claude/skills/verify-gate/SKILL.md", import.meta.url),
      "utf8"
    );

    expect(doc).toContain("check-gate-pipe.sh");
    expect(doc).toContain("db:migrate");
  });
});
