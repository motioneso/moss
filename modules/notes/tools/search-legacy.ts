/** Actual legacy execute body, with an explicit retriever seam. No provider/model
 * is downloaded. Database tests supply the real MemoryRetriever and repository. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { assertDataContextDb, type DataContextDb } from "@moss/db";

const ast = ts.createSourceFile(
  "tools.ts",
  readFileSync(new URL("../../../packages/notes/src/tools.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true
);
function expression(name: string): string {
  let found: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      found = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!found) throw new Error(`Missing legacy declaration ${name}`);
  return found;
}
const script = ts.transpileModule(
  ["NOTES_SOURCE_KIND", "DEFAULT_LIMIT", "MAX_LIMIT"]
    .map((name) => `const ${name}=${expression(name)};`)
    .join("\n") + `\nconst execute=${expression("notesSearchExecute")}; execute;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

export interface SearchRetriever {
  retrieve(db: DataContextDb, query: string, limit: number, kind: string): Promise<unknown[]>;
}
export function legacySearch(retriever: SearchRetriever, realDatabase = true) {
  return runInNewContext(script, {
    assertDataContextDb: realDatabase ? assertDataContextDb : () => {},
    getRetriever: async () => retriever
  }) as (db: DataContextDb, input: Record<string, unknown>) => Promise<unknown>;
}
