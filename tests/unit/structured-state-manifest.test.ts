import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { structuredStateModuleManifest } from "@moss/structured-state";

describe("structuredStateModuleManifest", () => {
  it("lists every structured-state SQL migration file in order", async () => {
    const sqlFiles = (await readdir("packages/structured-state/sql"))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => `sql/${file}`);

    expect(structuredStateModuleManifest.database?.migrations).toEqual(sqlFiles);
  });
});
