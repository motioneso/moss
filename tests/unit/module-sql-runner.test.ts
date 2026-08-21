import { describe, expect, it } from "vitest";

import { validateModuleMigrationSql } from "../../packages/db/src/migrations/module-sql-runner.js";

describe("validateModuleMigrationSql", () => {
  it("accepts a single CREATE TABLE statement", () => {
    const result = validateModuleMigrationSql(
      "CREATE TABLE app.acme_widgets (id uuid PRIMARY KEY);"
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts CREATE UNIQUE INDEX", () => {
    const result = validateModuleMigrationSql(
      "CREATE UNIQUE INDEX acme_widgets_name_idx ON app.acme_widgets (name);"
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a statement without a trailing semicolon", () => {
    const result = validateModuleMigrationSql("ALTER TABLE app.acme_widgets ADD COLUMN qty int");
    expect(result.ok).toBe(true);
  });

  it("accepts one data-only UPDATE for an idempotent module-owned migration", () => {
    const result = validateModuleMigrationSql(
      "UPDATE app.acme_widgets SET qty = 0 WHERE qty IS NULL;"
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts one data-only DELETE for an idempotent module-owned migration", () => {
    const result = validateModuleMigrationSql(
      "DELETE FROM app.acme_widgets WHERE id IN (SELECT id FROM app.acme_widgets WHERE qty = 0);"
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects two statements", () => {
    const result = validateModuleMigrationSql(
      "CREATE TABLE app.a (id uuid); CREATE TABLE app.b (id uuid);"
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/expected exactly one sql statement, found 2/i);
  });

  it("rejects a disallowed first command", () => {
    const result = validateModuleMigrationSql("DROP TABLE app.acme_widgets;");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/first command must be one of/i);
  });

  it("rejects an empty file", () => {
    const result = validateModuleMigrationSql("   \n  ");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/empty/i);
  });

  it("ignores semicolons inside string literals and comments when counting statements", () => {
    const result = validateModuleMigrationSql(
      "-- comment; with a semicolon\n" +
        "CREATE TABLE app.a (id uuid, note text DEFAULT 'a;b''c;d');"
    );
    expect(result.ok).toBe(true);
  });
});
