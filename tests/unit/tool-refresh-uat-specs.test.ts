import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SPECS = ["2942-midchat-tools.uat.spec.ts", "2950-tool-switches-repeat-calls.uat.spec.ts"];

const source = (spec: string) => readFile(new URL(`../uat/specs/${spec}`, import.meta.url), "utf8");

describe("tool-refresh live specs (#3275)", () => {
  it.each(SPECS)("%s starts fresh chats through the Conversations controls", async (spec) => {
    const text = await source(spec);
    expect(text, "removed New chat button").not.toMatch(/name: "New chat"/);
    const opens = text.match(/name: "Open conversations"/g) ?? [];
    const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
    expect(opens.length, "Open conversations clicks").toBeGreaterThan(0);
    expect(sides.length, "every overlay open starts a side chat").toBe(opens.length);
  });

  it.each(SPECS)("%s guards every direct screenshot with its capture opt-out", async (spec) => {
    const text = await source(spec);
    const direct = text.match(/\.screenshot\(/g) ?? [];
    const guarded =
      text.match(
        /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await [^;]*?\.screenshot\(/g
      ) ?? [];
    expect(direct.length, "unguarded screenshots").toBe(guarded.length);
  });
});
