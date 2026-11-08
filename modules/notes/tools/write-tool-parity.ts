/** Run the actual legacy write execute functions. Filesystem, DataContext and enqueue
 * are stand-ins: this corpus proves handler behavior, not privacy or real ingestion.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "write-tools.ts",
  readFileSync(new URL("../../../packages/notes/src/write-tools.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true
);
function expression(name: string, ast = source): string {
  let text: string | undefined;
  function find(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      text = node.initializer?.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast);
  if (!text) throw new Error(`Missing legacy handler ${name}`);
  return text;
}
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
interface Changes {
  changes: { path: string; content: string | null }[];
}
interface Case {
  tool: string;
  files: Record<string, string>;
  parameters: Record<string, unknown>;
}
async function legacy(entry: Case) {
  const files = { ...entry.files };
  let syncs = 0;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const transpile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText;
  const script = transpile(
    [
      expression("requireMarkdownPath"),
      expression("coerceToRelativePath"),
      `const execute = ${expression(`notes${entry.tool[0]!.toUpperCase()}${entry.tool.slice(1)}Execute`)}; execute;`
    ].join("\n")
  );
  const execute = runInNewContext(script, {
    HttpError,
    isAbsolute,
    normalize,
    dirname,
    join,
    assertDataContextDb: () => {},
    resolveSource: async () => "/notes",
    rejectSymlinkParent: async () => {},
    makeVaultDir: async () => {},
    realpath: async (path: string) => path,
    assertInside: () => {},
    recheckInside: async () => {},
    resolveExistingFile: async (_root: string, path: string) => {
      if (!(path in files)) throw missing();
      return join("/notes", path);
    },
    lstat: async (path: string) => {
      if (!(path.slice("/notes/".length) in files)) throw missing();
      return { isFile: () => true };
    },
    withNotesVault: async (_db: unknown, _root: unknown, work: (vault: object) => unknown) =>
      work({}),
    mutateVaultFiles: async (
      _db: unknown,
      _vault: unknown,
      paths: string[],
      work: (files: { content: string | null }[]) => Promise<Changes>
    ) => {
      const result = await work(paths.map((path) => ({ content: files[path] ?? null })));
      for (const change of result.changes) {
        if (change.content === null) delete files[change.path];
        else files[change.path] = change.content;
      }
    },
    sync: async (_services: unknown, _actor: unknown, _root: unknown, path: string) => {
      syncs += 1;
      return { data: { path, synced: true } };
    }
  }) as (db: object, input: object, ctx: object) => Promise<unknown>;
  let expected: unknown;
  try {
    expected = { ok: await execute({}, entry.parameters, { actorUserId: "fixture" }) };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    expected = { error: { statusCode: error.statusCode, error: error.message } };
  }
  return {
    files: entry.files,
    request: { tool: `notes.${entry.tool}`, parameters: entry.parameters },
    expected,
    after: files,
    syncs
  };
}
const cases: Case[] = [];
for (const path of ["note.md", "Journal/day.md", "./Journal//day.md", "/notes/Journal/day.md"]) {
  for (const content of ["", "Private café 😀\r\n", "# Note\nold\n"]) {
    cases.push({ tool: "create", files: {}, parameters: { path, content } });
    cases.push({
      tool: "create",
      files: { "note.md": "original", "Journal/day.md": "original" },
      parameters: { path, content, overwrite: true }
    });
  }
}
for (const newText of ["new", "", "$$", "$&", "$`", "$'", "😀$&\r\n"]) {
  cases.push({
    tool: "edit",
    files: { "note.md": "before old after" },
    parameters: { path: "note.md", oldText: "old", newText }
  });
}
for (const [content, oldText] of [
  ["old old", "old"],
  ["absent", "old"],
  ["x", ""],
  ["aaa", "aa"]
])
  cases.push({
    tool: "edit",
    files: { "note.md": content! },
    parameters: { path: "note.md", oldText, newText: "new" }
  });
for (const path of ["note.md", "/notes/note.md", "./note.md", "Journal/day.md"]) {
  cases.push({
    tool: "delete",
    files: { "note.md": "private", "Journal/day.md": "private" },
    parameters: { path }
  });
}
cases.push({
  tool: "create",
  files: { "note.md": "original" },
  parameters: { path: "note.md", content: "new" }
});
for (const path of ["../note.md", "/elsewhere/note.md", "bad.txt", "bad\0.md", "a/../note.md"]) {
  for (const tool of ["create", "edit", "delete"])
    cases.push({
      tool,
      files: { "note.md": "old" },
      parameters: {
        path,
        ...(tool === "create"
          ? { content: "new" }
          : tool === "edit"
            ? { oldText: "old", newText: "new" }
            : {})
      }
    });
}
const vectors = [];
for (const entry of cases) vectors.push(await legacy(entry));
writeFileSync(
  new URL("../src/tests/write-tool-vectors.jsonl", import.meta.url),
  vectors.map((v) => JSON.stringify(v)).join("\n") + "\n"
);
console.log(
  `Recorded ${vectors.length} actual legacy write-tool cases (filesystem and sync stand-ins)`
);

// Execute the authored legacy approval hooks and field presenters in one realm.
// Only target resolution is a stand-in; its version uses the real legacy digest formula.
const approvalSource = ts.createSourceFile(
  "approval-presentation.ts",
  readFileSync(
    new URL("../../../packages/notes/src/approval-presentation.ts", import.meta.url),
    "utf8"
  ),
  ts.ScriptTarget.ES2022,
  true
);
const fieldSource = ts.createSourceFile(
  "action-presentation.ts",
  readFileSync(
    new URL("../../../packages/module-sdk/src/action-presentation.ts", import.meta.url),
    "utf8"
  ),
  ts.ScriptTarget.ES2022,
  true
);
const approvalVectors = [];
const approvalCases: Case[] = [
  ...cases.filter(
    (c) =>
      !String(c.parameters.path).includes("..") &&
      !String(c.parameters.path).includes("\0") &&
      String(c.parameters.path).endsWith(".md") &&
      !String(c.parameters.path).startsWith("/elsewhere") &&
      c.parameters.oldText !== ""
  ),
  {
    tool: "create",
    files: { "note.md": "old" },
    parameters: { path: "note.md", overwrite: false, content: "" }
  },
  {
    tool: "edit",
    files: { "note.md": "old" },
    parameters: { path: "note.md", newText: "new", oldText: "old" }
  }
];
for (const entry of approvalCases) {
  const script = ts.transpileModule(
    [
      expression("requireMarkdownPath"),
      expression("coerceToRelativePath"),
      expression("presentApprovalFields", fieldSource).replace(/^export /, ""),
      `const approvalText = ${expression("approvalText", fieldSource)};`,
      `const approvalBoolean = ${expression("approvalBoolean", fieldSource)};`,
      expression("notePresentation", approvalSource),
      ...[
        "notesCreatePresentation",
        "notesEditPresentation",
        "deleteNoteTarget",
        "notesDeletePresentation"
      ].map((name) => `const ${name} = ${expression(name, approvalSource)};`),
      `({execute:notes${entry.tool[0]!.toUpperCase()}${entry.tool.slice(1)}Presentation, relative:(path)=>requireMarkdownPath(coerceToRelativePath(path,"/notes"))});`
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText;
  let relative: (path: unknown) => string;
  const api = runInNewContext(script, {
    HttpError,
    isAbsolute,
    normalize,
    assertDataContextDb: () => {},
    resolveNoteApprovalTarget: async (_db: unknown, path: unknown) => {
      const rel = relative(path);
      return {
        relative: rel,
        version: createHash("sha256")
          .update(JSON.stringify(["/notes", rel, entry.files[rel] ?? null]))
          .digest("hex")
      };
    }
  }) as {
    execute: (db: object, input: object) => Promise<unknown>;
    relative: (path: unknown) => string;
  };
  relative = api.relative;
  approvalVectors.push({
    files: entry.files,
    request: { tool: `notes.${entry.tool}`, parameters: entry.parameters },
    expected: await api.execute({}, entry.parameters)
  });
}
writeFileSync(
  new URL("../src/tests/approval-vectors.jsonl", import.meta.url),
  approvalVectors.map((v) => JSON.stringify(v)).join("\n") + "\n"
);
console.log(
  `Recorded ${approvalVectors.length} actual legacy approval-hook cases (target resolution stand-in)`
);
