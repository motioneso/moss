import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SPECS = ["notes-default-retrieval.uat.spec.ts", "notes-path-recheck.uat.spec.ts"];

const source = (file: string) => readFile(new URL(`../uat/specs/${file}`, import.meta.url), "utf8");

describe("notes live specs (#3277)", () => {
  it.each(SPECS)("%s starts its fresh chat through the shared side-chat helper", async (spec) => {
    const text = await source(spec);
    expect(text, "removed New chat button").not.toMatch(/name: "New chat"/);
    expect(text).toMatch(/from "\.\/notes-new-side-chat\.js"/);
    expect(text.match(/await startNewSideChat\(/g) ?? [], "one fresh chat per spec").toHaveLength(
      1
    );
  });

  it("the side-chat helper uses the Conversations controls", async () => {
    const text = await source("notes-new-side-chat.ts");
    expect(text).toMatch(/name: "Open conversations"/);
    expect(text).toMatch(/name: "New side chat", exact: true/);
  });

  it("the recall spec checks both conversations in storage", async () => {
    const text = await source("notes-default-retrieval.uat.spec.ts");
    expect(text).toMatch(/await expectThreadCarries\(/);
    expect(text).toMatch(/await expectOnlyUserTurn\(/);
  });
});
