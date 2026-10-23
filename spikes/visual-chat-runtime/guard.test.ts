import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateProgram } from "./guard.js";
import { fixtures } from "./fixtures.js";
import { prepareRuntimeModule, removeDevtoolsBootstrap } from "./runtime-entry.js";

const program = 'root = Reply([Section("Time", [Fact("hours")])]);';

describe("restricted visual runtime experiment", () => {
  it.each(fixtures)("$id has the intended acceptance result", ({ program, valid }) => {
    expect(validateProgram(program)).toBe(valid);
  });

  it.each([
    String.raw`root = Reply([Section("Query(\"read\") is plain text", [Fact("hours")])]);`,
    '  root = Reply([Section("Unicode: café 🌿", [Fact("projects")])])  ',
    String.raw`root = Reply([Section("Quoted \"label\"", [Fact("hours")])]);`
  ])("accepts inert JSON strings: %s", (value) => {
    expect(validateProgram(value)).toBe(true);
  });

  it.each([
    "",
    program + " /* silently ignored by a permissive parser */",
    program + " root = Reply([]);",
    'root = Reply([Section("State", [Fact($field)])]);',
    'root = Reply([Section("Action", [Action(OpenUrl("https://example.test"))])]);',
    'root = Reply([Section("Injected", [Fact("hours", "999")])]);',
    'root = Reply([Section("No facts", [])]);',
    'root = Reply([Section("Too many facts", [Fact("hours"), Fact("projects"), Fact("budget"), Fact("hours")])]);',
    'root = Reply([Section("One", [Fact("hours"), Fact("budget")]), Section("Two", [Fact("projects"), Fact("hours")])]);',
    'root = Reply([Section("Wrong child", [Section("Nested", [Fact("hours")])])]);',
    'root = Reply([Fact("hours")]);',
    'root = Reply([Section("Bad escape \\q", [Fact("hours")])]);',
    'root = Reply([Section("Bad string\nnewline", [Fact("hours")])]);',
    'root = Reply([Section("' + "x".repeat(101) + '", [Fact("hours")])]);',
    'root = Reply([Section("Huge", [Fact("hours")])]);' + " ".repeat(65536),
    "root = Reply(" + "[".repeat(10000) + "null" + "]".repeat(10000) + ");"
  ])("rejects unsupported or incomplete programs: %s", (value) => {
    expect(validateProgram(value)).toBe(false);
  });

  it("rejects non-string proposals", () => {
    expect(validateProgram({ program })).toBe(false);
    expect(validateProgram(null)).toBe(false);
  });
});

describe("inspected published web entry", () => {
  it("handles Vite's versioned module IDs and bracket-form environment checks", () => {
    const source =
      '//#region src/devtoolsBootstrap.ts\nunsafe();\n//#endregion\nif(process.env["NODE_ENV"] !== "production") publish();';
    const entry = "/node_modules/@openuidev/react-lang/dist/index.mjs?v=123";
    const prepared = prepareRuntimeModule(source, entry, "development");
    expect(prepared).not.toContain("unsafe()");
    expect(prepared).not.toContain("process.env");
    expect(prepared).toContain('"development" !== "production"');
    expect(prepareRuntimeModule(source, entry, "development", true)).toContain("unsafe()");
    expect(prepareRuntimeModule(source, "/unrelated/index.mjs", "development")).toBeUndefined();
  });

  it("normalizes the vendor's private renderer chunk without rewriting other code", () => {
    expect(
      prepareRuntimeModule(
        'const dev = process.env["NODE_ENV"];',
        "/node_modules/@openuidev/react-lang/dist/exports-CLfR509v.mjs",
        "production"
      )
    ).toBe('const dev = "production";');
  });

  it("removes the actual pinned bootstrap and preserves the public exports", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(
      require.resolve("@openuidev/react-lang").replace(/index\.cjs$/, "index.mjs"),
      "utf8"
    );
    expect(source).toContain('import("@openuidev/devtools")');
    const result = removeDevtoolsBootstrap(source);
    expect(result).not.toContain('import("@openuidev/devtools")');
    expect(result).not.toContain("openui.devtools.autoMount");
    expect(result).toContain("export {");
  });

  it("requires a fresh evaluation when the vendor entry changes", () => {
    expect(() => removeDevtoolsBootstrap("export {};")).toThrow("bootstrap changed");
    const block = "//#region src/devtoolsBootstrap.ts\nunsafe();\n//#endregion";
    expect(() => removeDevtoolsBootstrap(block + block)).toThrow("bootstrap changed");
  });
});
