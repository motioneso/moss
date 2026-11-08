/** Execute the actual legacy edit handler, with explicit filesystem/queue stand-ins.
 * This is a domain oracle only: no database, network, or production folder is opened.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "write-tools.ts",
  readFileSync(new URL("../../../packages/notes/src/write-tools.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true
);
let initializer: ts.Expression | undefined;
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "notesEditExecute") {
    initializer = node.initializer;
  }
  ts.forEachChild(node, find);
}
find(source);
if (!initializer) throw new Error("Legacy notesEditExecute was not found");
const script = ts.transpileModule(`const execute = ${initializer.getText(source)}; execute;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

interface Input {
  content: string;
  oldText: string;
  newText: string;
}
interface Change {
  changes: { content: string }[];
}
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
async function legacy(input: Input): Promise<unknown> {
  let saved = input.content;
  const execute = runInNewContext(script, {
    HttpError,
    assertDataContextDb: () => {},
    resolveSource: async () => "/notes",
    coerceToRelativePath: (path: string) => path,
    requireMarkdownPath: (path: string) => path,
    join: (...paths: string[]) => paths.join("/"),
    resolveExistingFile: async () => "/notes/note.md",
    withNotesVault: async (_db: unknown, _root: unknown, work: (vault: object) => unknown) =>
      work({}),
    recheckInside: async () => {},
    mutateVaultFiles: async (
      _db: unknown,
      _vault: unknown,
      _paths: unknown,
      work: (files: { content: string }[]) => Promise<Change>
    ) => {
      saved = (await work([{ content: saved }])).changes[0]!.content;
    },
    sync: async () => ({ data: { path: "note.md", synced: true } })
  }) as (db: object, input: object, ctx: object) => Promise<unknown>;
  try {
    await execute({}, { path: "note.md", oldText: input.oldText, newText: input.newText }, {});
    return { ok: saved };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { error: error.message, status: error.statusCode };
  }
}
const replacements = [
  "new",
  "",
  "$$",
  "$&",
  "$`",
  "$'",
  "$1 $01 $99 $0 $<name>",
  "$$& $$$& $$$$ $$` $$'",
  "$&$`$'$$",
  "😀 $& café\r\n$' $`",
  "$",
  "$$$",
  "\\$&"
];
const inputs: Input[] = [];
for (const content of ["prefix old suffix", "old", "😀oldé", "old\r\n", "$old$", "x\0old\0z"]) {
  for (const newText of replacements) inputs.push({ content, oldText: "old", newText });
}
for (const [content, oldText] of [
  ["aaa", "aa"],
  ["aaaa", "aa"],
  ["banana", "ana"],
  ["😀😀", "😀"],
  ["absent", "old"],
  ["x", ""],
  ["", ""],
  ["old old", "old"]
]) {
  for (const newText of replacements)
    inputs.push({ content: content!, oldText: oldText!, newText });
}
const vectors = [];
for (const input of inputs) vectors.push({ input, expected: await legacy(input) });
writeFileSync(
  new URL("../src/tests/edit-vectors.jsonl", import.meta.url),
  vectors.map((vector) => JSON.stringify(vector)).join("\n") + "\n"
);
console.log(
  `Recorded ${vectors.length} results from the actual legacy edit handler (boundary stand-ins)`
);
