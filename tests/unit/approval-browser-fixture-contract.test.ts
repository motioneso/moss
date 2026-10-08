import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const item of node.properties) {
    if (
      (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name
    ) {
      return ts.isPropertyAssignment(item) ? item.initializer : item.name;
    }
  }
  return undefined;
}
function text(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

// These browser fixtures bypass the real producer. Require its positive disclosure contract
// so a stale summary-only fixture cannot silently exercise the lost-details fallback instead.
const fixtures: { location: string; record: ts.ObjectLiteralExpression }[] = [];
for (const file of readdirSync("tests/e2e").filter((name) => name.endsWith(".ts"))) {
  const path = join("tests/e2e", file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && text(property(node, "kind")) === "action_request") {
      fixtures.push({
        location: `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
        record: node
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

describe("approval browser fixture disclosure", () => {
  it("finds the browser's action-request fixtures", () =>
    expect(fixtures.length).toBeGreaterThan(0));
  it.each(fixtures)(
    "declares complete disclosure or explicitly lost details at $location",
    ({ record }) => {
      // A deliberate restore-without-details case declares itself rather than accidentally
      // dropping a contract field from an otherwise approvable synthetic record.
      if (property(record, "approvalAvailable")?.kind === ts.SyntaxKind.FalseKeyword) return;
      if (property(record, "nativePermission")?.kind === ts.SyntaxKind.TrueKeyword) {
        expect(property(record, "summary")).toBeDefined();
        return;
      }
      if (property(record, "externalTool")?.kind === ts.SyntaxKind.TrueKeyword) {
        expect(property(record, "toolName")).toBeDefined();
        expect(property(record, "exactArguments")).toBeDefined();
        return;
      }
      expect(text(property(record, "outcomeTitle"))?.trim()).toBeTruthy();
      const preview = property(record, "preview");
      if (preview && ts.isObjectLiteralExpression(preview)) {
        for (const key of ["to", "subject", "body"]) expect(property(preview, key)).toBeDefined();
        return;
      }
      const details = property(record, "details");
      expect(details && ts.isObjectLiteralExpression(details)).toBe(true);
      if (!details || !ts.isObjectLiteralExpression(details)) return;
      expect(text(property(details, "presentation"))).toBe("human");
      expect(property(details, "target")).toBeDefined();
      const fields = property(details, "fields");
      expect(fields && ts.isArrayLiteralExpression(fields)).toBe(true);
    }
  );
});
