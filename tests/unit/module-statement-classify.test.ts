import { inspectModuleStatement } from "../../packages/db/src/module-statement-classify.js";
import { describe, expect, it } from "vitest";
import { classifyModuleStatement, ModuleQueryError } from "@moss/db";

// #1167 — the statement allowlist is the security boundary in front of
// module-authored SQL (spec 2026-07-09-module-data-plane.md D5). Every case
// here is either a required acceptance or a documented fail-closed rejection.

function classifyError(text: string): ModuleQueryError {
  try {
    classifyModuleStatement(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleQueryError);
    return error as ModuleQueryError;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
}

describe("classifyModuleStatement", () => {
  it("classifies the four allowed kinds", () => {
    expect(classifyModuleStatement("SELECT * FROM app.t WHERE a = $1")).toBe("select");
    expect(classifyModuleStatement("insert into app.t (a) values ($1)")).toBe("insert");
    expect(classifyModuleStatement("UPDATE app.t SET a = $1 WHERE b = $2")).toBe("update");
    expect(classifyModuleStatement("DELETE FROM app.t WHERE a = $1")).toBe("delete");
  });

  it("classifies WITH + top-level select as select", () => {
    expect(
      classifyModuleStatement("WITH recent AS (SELECT * FROM app.t) SELECT count(*) FROM recent")
    ).toBe("select");
  });

  it("classifies WITH + top-level mutation as the mutation", () => {
    expect(classifyModuleStatement("WITH x AS (SELECT 1) UPDATE app.t SET a = 2")).toBe("update");
  });

  it("classifies a data-modifying CTE as the mutation (any depth)", () => {
    // The readOnly-bypass case: depth-0-only scanning would call this "select".
    expect(
      classifyModuleStatement("WITH d AS (DELETE FROM app.t RETURNING id) SELECT * FROM d")
    ).toBe("delete");
    expect(
      classifyModuleStatement(
        "WITH a AS (SELECT 1), b AS (INSERT INTO app.t (x) VALUES (1)) SELECT * FROM a"
      )
    ).toBe("insert");
  });

  it("ignores keywords inside string literals and quoted identifiers", () => {
    expect(classifyModuleStatement("SELECT 'DELETE FROM x' AS label FROM app.t")).toBe("select");
    expect(classifyModuleStatement('SELECT "delete" FROM app.t')).toBe("select");
    expect(classifyModuleStatement("SELECT 'it''s fine' FROM app.t")).toBe("select");
  });

  it("skips comments", () => {
    expect(classifyModuleStatement("-- lead comment\n/* block */ SELECT 1")).toBe("select");
  });

  it("rejects non-allowlisted statement kinds", () => {
    expect(classifyError("TRUNCATE app.t").code).toBe("forbidden_statement");
    expect(classifyError("DROP TABLE app.t").code).toBe("forbidden_statement");
    expect(classifyError("COPY app.t TO STDOUT").code).toBe("forbidden_statement");
    expect(classifyError("BEGIN").code).toBe("forbidden_statement");
    expect(classifyError("SET ROLE postgres").code).toBe("forbidden_statement");
    expect(classifyError("EXPLAIN SELECT 1").code).toBe("forbidden_statement");
  });

  it("rejects set_config anywhere, fail closed (RLS GUC spoofing)", () => {
    expect(classifyError("SELECT set_config('app.actor_user_id', 'victim', true)").code).toBe(
      "forbidden_statement"
    );
    expect(
      classifyError("WITH s AS (SELECT SET_CONFIG('role', 'postgres', true)) SELECT * FROM s").code
    ).toBe("forbidden_statement");
    // Documented false positive: even as a plain string literal it is rejected.
    expect(classifyError("SELECT 'set_config'").code).toBe("forbidden_statement");
  });

  it("rejects unicode-escape and escape-string literals (skipper desync)", () => {
    expect(classifyError("SELECT U&'\\0064elete'").code).toBe("forbidden_statement");
    expect(classifyError('SELECT U&"x" FROM app.t').code).toBe("forbidden_statement");
    expect(classifyError("SELECT E'\\'' , x FROM app.t").code).toBe("forbidden_statement");
    // A positional param is a distinct token — "1e'" is a fresh E-string
    // prefix, not part of the "$1" param (digits are not a safe predecessor).
    expect(classifyError("SELECT $1e''").code).toBe("forbidden_statement");
  });

  it("rejects dollar-quoted strings but allows positional params", () => {
    expect(classifyError("SELECT $$DELETE FROM app.t$$").code).toBe("forbidden_statement");
    expect(classifyError("SELECT $fn$body$fn$").code).toBe("forbidden_statement");
    expect(classifyModuleStatement("SELECT * FROM app.t WHERE a = $1 AND b = $22")).toBe("select");
  });

  it("rejects multiple statements; allows one trailing semicolon", () => {
    // node-pg uses the simple protocol for parameterless queries — a second
    // command after ';' would actually EXECUTE, so the classifier must reject it.
    expect(classifyError("SELECT 1; DELETE FROM app.t").code).toBe("forbidden_statement");
    expect(classifyError("SELECT 1;\n-- c\nDELETE FROM app.t").code).toBe("forbidden_statement");
    expect(classifyModuleStatement("SELECT 1;")).toBe("select");
    expect(classifyModuleStatement("SELECT 1; -- trailing comment")).toBe("select");
  });

  it("rejects unterminated constructs and empty input", () => {
    expect(classifyError("SELECT 'unterminated").code).toBe("forbidden_statement");
    expect(classifyError("/* unterminated SELECT 1").code).toBe("forbidden_statement");
    expect(classifyError("").code).toBe("forbidden_statement");
    expect(classifyError("   -- only a comment").code).toBe("forbidden_statement");
  });

  it("formats the error contract", () => {
    const error = classifyError("TRUNCATE app.t");
    expect(error.name).toBe("ModuleQueryError");
    expect(error.message).toContain("forbidden_statement");
    expect(error.sqlstate).toBeUndefined();
  });
});

describe("module locking-read classification", () => {
  it.each([
    "FOR UPDATE",
    "for no key update",
    "FOR SHARE",
    "FOR KEY SHARE",
    "FOR /* comment */ UPDATE",
    "FOR /* outer /* inner */ continued */ UPDATE",
    "FOR NO -- comment\n KEY UPDATE"
  ])("orders %s with mutations", (clause) => {
    expect(inspectModuleStatement(`SELECT id FROM app.t ${clause}`)).toEqual({
      kind: "select",
      locksRows: true
    });
  });
  it.each([
    "SELECT 'FOR UPDATE'",
    'SELECT "FOR", "UPDATE" FROM app.t',
    "SELECT id FROM app.t /* FOR SHARE */",
    "SELECT id FROM app.t -- FOR KEY SHARE"
  ])("keeps an ordinary read independent: %s", (query) => {
    expect(inspectModuleStatement(query)).toEqual({ kind: "select", locksRows: false });
  });
});

it("does not treat nested-comment words as a row-lock clause or a second statement", () => {
  expect(inspectModuleStatement("SELECT 1 /* outer /* FOR UPDATE */ continued */")).toEqual({
    kind: "select",
    locksRows: false
  });
  expect(classifyError("SELECT 1; /* outer /* inner */ continued */ DELETE FROM app.t").code).toBe(
    "forbidden_statement"
  );
});
