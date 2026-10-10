import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkBannedProperties, checkTokens } from "../../scripts/check-design-tokens.ts";

/**
 * Guard 4 regression test (#1388 Foundation, D2). The guard's own module-load self-test proves
 * the banned-property detector fires on a synthetic bad case; this file adds a real fixture tree
 * and the day-one-empty-list acceptance bar the spec sets: the guard must not red the tree before
 * any section has migrated.
 */

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixture(cssContents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-design-tokens-"));
  fixtureRoots.push(root);
  await mkdir(join(root, "apps/web/src/styles"), { recursive: true });
  await writeFile(join(root, "apps/web/src/styles/kit-example.css"), cssContents);
  return root;
}

describe("check-design-tokens banned-property guard (#1388 Foundation guard 4)", () => {
  it("flags a banned visual property in a migrated section's CSS file", async () => {
    const root = await buildFixture(".kit-example { background-color: #fff; }\n");

    const violations = await checkBannedProperties(root, ["apps/web/src/styles/kit-example.css"]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.property).toBe("background-color");
  });

  it("does not flag layout properties in a migrated section's CSS file", async () => {
    const root = await buildFixture(
      ".kit-example { position: relative; display: flex; gap: var(--space-2); }\n"
    );

    const violations = await checkBannedProperties(root, ["apps/web/src/styles/kit-example.css"]);

    expect(violations).toEqual([]);
  });

  it("does not flag a banned property in a file that is not in the migrated list", async () => {
    const root = await buildFixture(".kit-example { color: red; }\n");

    const violations = await checkBannedProperties(root, []);

    expect(violations).toEqual([]);
  });

  it("passes against the real repo tree with the real migrated-sections list", async () => {
    const repoRoot = join(import.meta.dirname, "../..");
    const violations = await checkBannedProperties(repoRoot);

    expect(violations).toEqual([]);
  });
});

describe("token scan includes shared primitives", () => {
  it("rejects shared literals and misspelled variables, while allowing declared local contracts", async () => {
    const root = await buildFixture("");
    await writeFile(join(root, "apps/web/src/styles/tokens.css"), ":root { --text: #282c25; }\n");
    await mkdir(join(root, "packages/ui/src/styles"), { recursive: true });
    await writeFile(
      join(root, "packages/ui/src/styles/example.css"),
      ".example { --local: var(--text); color: var(--local); border-color: var(--typo); background: #fff; }\n"
    );
    const violations = await checkTokens(root);
    expect(
      violations.some(
        (item) =>
          item.path === "packages/ui/src/styles/example.css" &&
          item.text.includes("Forbidden literal")
      )
    ).toBe(true);
    expect(violations.some((item) => item.text.includes("--typo"))).toBe(true);
    expect(violations.some((item) => item.text.startsWith("Undefined token --local:"))).toBe(false);
  });
  it("does not leak tokens between independent roots", async () => {
    const first = await buildFixture(".ok { color: var(--first); }");
    await writeFile(
      join(first, "apps/web/src/styles/tokens.css"),
      ":root {\n --first: #282c25;\n}\n"
    );
    expect(await checkTokens(first)).toEqual([]);
    const second = await buildFixture(".wrong { color: var(--first); }");
    await writeFile(
      join(second, "apps/web/src/styles/tokens.css"),
      ":root {\n --second: #282c25;\n}\n"
    );
    expect(
      (await checkTokens(second)).some((item) => item.text.includes("Undefined token --first"))
    ).toBe(true);
  });
  it("rejects tokens that only occur in commented-out examples", async () => {
    const root = await buildFixture(".unrelated-page { color: var(--retired-color); }");
    await writeFile(
      join(root, "apps/web/src/styles/tokens.css"),
      ":root { --text: #282c25; } /* Historical example: :root { --retired-color: #282c25; } */\n"
    );
    expect(await checkTokens(root)).toEqual([
      expect.objectContaining({
        path: "apps/web/src/styles/kit-example.css",
        text: expect.stringContaining("Undefined token --retired-color")
      })
    ]);
  });
  it("allows Calendar's scoped gutter only in its declared time-grid consumer", async () => {
    const root = await buildFixture(".unrelated-page { width: var(--cal-gutter, 60px); }");
    await writeFile(join(root, "apps/web/src/styles/tokens.css"), ":root { --text: #282c25; }\n");
    await writeFile(
      join(root, "apps/web/src/styles/kit-calendar.css"),
      ".cal-wrap { --cal-gutter: 60px; }\n"
    );
    await mkdir(join(root, "apps/web/src/calendar"), { recursive: true });
    await writeFile(
      join(root, "apps/web/src/calendar/calendar-time-grid.tsx"),
      'export const gridStyle = { gridTemplateColumns: "var(--cal-gutter, 60px) 1fr" };\n'
    );
    expect(await checkTokens(root)).toEqual([
      expect.objectContaining({
        path: "apps/web/src/styles/kit-example.css",
        text: expect.stringContaining("Undefined token --cal-gutter")
      })
    ]);
  });
  it("does not promote another module's scoped custom properties to global tokens", async () => {
    const root = await buildFixture(".unrelated-page { color: var(--example-local-color); }");
    await writeFile(
      join(root, "apps/web/src/styles/tokens.css"),
      ":root {\n --text: #282c25;\n}\n"
    );
    await mkdir(join(root, "packages/example/src"), { recursive: true });
    await writeFile(
      join(root, "packages/example/src/styles.css"),
      ".example-local { --example-local-color: var(--text); color: var(--example-local-color); }\n"
    );
    const violations = await checkTokens(root);
    expect(violations).toEqual([
      expect.objectContaining({
        path: "apps/web/src/styles/kit-example.css",
        text: expect.stringContaining("Undefined token --example-local-color")
      })
    ]);
  });
});
