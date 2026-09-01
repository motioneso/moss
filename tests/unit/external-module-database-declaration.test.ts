import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ExternalPackageEscapeError,
  hashExternalPackage,
  validateExternalModuleManifest
} from "../../packages/module-registry/src/node.js";

const baseManifest = {
  schemaVersion: 1,
  id: "demo-module",
  name: "Demo Module",
  version: "1.0.0",
  publisher: "Jarvis Labs",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" }
};

describe("manifest database.ownedTables validation (#964)", () => {
  it("accepts a well-formed database declaration with the module slug prefix", () => {
    const result = validateExternalModuleManifest(
      {
        ...baseManifest,
        database: { ownedTables: ["app.demo_module_listings", "app.demo_module_notes"] }
      },
      "demo-module"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.database?.ownedTables).toEqual([
        "app.demo_module_listings",
        "app.demo_module_notes"
      ]);
    }
  });

  it("still accepts a manifest with no database block (metadata-only module)", () => {
    expect(validateExternalModuleManifest(baseManifest, "demo-module").ok).toBe(true);
  });

  it("rejects tables outside the module's slug prefix (cross-module claim)", () => {
    for (const table of ["app.users", "app.notes_items", "app.demomodule_x", "app.demo_modulex"]) {
      const result = validateExternalModuleManifest(
        { ...baseManifest, database: { ownedTables: [table] } },
        "demo-module"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unqualified, non-app-schema, and malformed table names", () => {
    for (const table of [
      "demo_module_x",
      "public.demo_module_x",
      "app.Demo_Module",
      "app.demo-module-x",
      'app."x"; DROP TABLE app.users'
    ]) {
      const result = validateExternalModuleManifest(
        { ...baseManifest, database: { ownedTables: [table] } },
        "demo-module"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects oversized, duplicate, and unknown-key database blocks", () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `app.demo_module_t${i}`);
    for (const database of [
      { ownedTables: tooMany },
      { ownedTables: ["app.demo_module_a", "app.demo_module_a"] },
      { ownedTables: ["app.demo_module_a"], migrations: "sql/" },
      { ownedTables: "app.demo_module_a" },
      []
    ]) {
      const result = validateExternalModuleManifest({ ...baseManifest, database }, "demo-module");
      expect(result.ok).toBe(false);
    }
  });

  it("accepts a database-less module that declares an empty owned-table list", () => {
    const result = validateExternalModuleManifest(
      { ...baseManifest, database: { ownedTables: [] } },
      "demo-module"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.database?.ownedTables).toEqual([]);
    }
  });
});

describe("hashExternalPackage covers sql/** (#964)", () => {
  const dirs: string[] = [];
  const makeModule = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "mod-hash-"));
    dirs.push(dir);
    writeFileSync(join(dir, "jarvis.module.json"), JSON.stringify(baseManifest));
    mkdirSync(join(dir, "sql"));
    writeFileSync(
      join(dir, "sql", "0001_init.sql"),
      "CREATE TABLE app.demo_module_listings (id uuid);"
    );
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("changes the package hash when a sql file changes", () => {
    const dir = makeModule();
    const before = hashExternalPackage(dir);
    writeFileSync(
      join(dir, "sql", "0001_init.sql"),
      "CREATE TABLE app.demo_module_listings (id uuid, x int);"
    );
    expect(hashExternalPackage(dir)).not.toBe(before);
  });

  it("changes the package hash when a sql file is added", () => {
    const dir = makeModule();
    const before = hashExternalPackage(dir);
    writeFileSync(
      join(dir, "sql", "0002_more.sql"),
      "ALTER TABLE app.demo_module_listings ADD COLUMN y int;"
    );
    expect(hashExternalPackage(dir)).not.toBe(before);
  });

  it("rejects a sql/ symlink escaping the module directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "mod-hash-esc-"));
    dirs.push(dir);
    const outside = mkdtempSync(join(tmpdir(), "mod-hash-out-"));
    dirs.push(outside);
    writeFileSync(join(dir, "jarvis.module.json"), JSON.stringify(baseManifest));
    symlinkSync(outside, join(dir, "sql"));
    expect(() => hashExternalPackage(dir)).toThrow(ExternalPackageEscapeError);
  });
});
