/** Execute the actual legacy sync coordinator. Files, preferences, per-file ingestion
 * and database transactions are named stand-ins; this is not indexing/model proof. */
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface Entry {
  source?: string | null;
  files: string[];
  payload?: Record<string, unknown>;
  results?: Record<string, unknown>;
  failures?: Record<string, string>;
  resolveFailures?: Record<string, string>;
  purgeFailure?: boolean;
  indexed?: string[];
  resolvedFiles?: Record<string, string>;
}
const ast = ts.createSourceFile(
  "jobs.ts",
  readFileSync(new URL("../../../packages/notes/src/jobs.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true
);
const declarations = new Map<string, string>();
for (const node of ast.statements)
  if (ts.isFunctionDeclaration(node) && node.name)
    declarations.set(node.name.text, node.getText(ast).replace(/^export /, ""));
const names = ["resolveSourcePath", "purgeDeletedNotes", "handleNotesSyncJobWithDataContext"];
const script = ts.transpileModule(
  names
    .map((name) => {
      const declaration = declarations.get(name);
      if (!declaration) throw new Error(`Legacy sync declaration missing: ${name}`);
      return declaration;
    })
    .join("\n") + "\nhandleNotesSyncJobWithDataContext;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
class NotesPathError extends Error {}
// Run the authored error sink too, rather than copying its allowlist into the oracle.
const sinkSource = readFileSync(
  new URL("../../../packages/notes/src/error-sink.ts", import.meta.url),
  "utf8"
)
  .replace(/^import .*;$/m, "")
  .replace(/export /g, "");
const sink = runInNewContext(
  ts.transpileModule(sinkSource + "\n({ NotesSyncFailure, sinkSafeErrorMessage });", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText,
  { Error, NotesPathError }
) as {
  NotesSyncFailure: new (message: string) => Error;
  sinkSafeErrorMessage: (error: unknown) => string;
};
const { NotesSyncFailure, sinkSafeErrorMessage: safe } = sink;
function failure(code: string): Error {
  return code === "OUTSIDE"
    ? new NotesPathError("private path")
    : Object.assign(new Error("private path must not reach the result"), { code });
}
async function legacy(entry: Entry) {
  const calls: unknown[] = [];
  const payload = entry.payload ?? {};
  const execute = runInNewContext(script, {
    Error,
    NOTES_SOURCE_KIND: "notes",
    NOTES_SOURCE_PREFERENCE_KEY: "notes-source-path",
    NOTES_SYNC_MAX_CHUNKS_PER_RUN: 100,
    NotesSyncFailure,
    toAccessContext: () => ({}),
    resolveNotesRoots: () => ["/notes"],
    realpath: async (path: string) => {
      if (path !== "/notes") {
        calls.push({ canonical: path });
        const code = entry.resolveFailures?.[path];
        if (code) throw failure(code);
      }
      return entry.resolvedFiles?.[path] ?? path;
    },
    MemoryRepository: class {
      async listIndexedPaths() {
        calls.push({ indexed: true });
        if (entry.purgeFailure) throw failure("EACCES");
        return entry.indexed ?? [];
      }
      async deleteFileChunks(_db: unknown, _actor: string, path: string, kind: string) {
        calls.push({ deleteChunks: { path, kind } });
      }
      async replaceFileLinks(_db: unknown, _actor: string, path: string, links: string[]) {
        calls.push({ replaceLinks: { path, links } });
      }
      async deleteFileIndex(_db: unknown, _actor: string, kind: string, path: string) {
        calls.push({ deleteIndex: { path, kind } });
      }
    },
    collectMarkdownFiles: async () => entry.files,
    resolveAndValidateNoteFile: async (_root: string, file: string) => {
      const code = entry.resolveFailures?.[file];
      if (code) throw failure(code);
      return entry.resolvedFiles?.[file] ?? file;
    },
    ingestResolvedMarkdownFile: async (
      _root: string,
      _db: unknown,
      file: string,
      _repository: unknown,
      _embedding: unknown,
      offset: number,
      limit: number,
      hash?: string,
      snapshot?: string
    ) => {
      calls.push({
        filePath: file,
        chunkOffset: offset,
        chunkLimit: limit,
        ...(hash === undefined ? {} : { expectedFileHash: hash }),
        ...(snapshot === undefined ? {} : { expectedSnapshotKey: snapshot })
      });
      const code = entry.failures?.[file];
      if (code) throw failure(code);
      return entry.results?.[file] ?? { status: "ingested", chunksProcessed: 1 };
    },
    sinkSafeErrorMessage: safe
  }) as (
    job: object,
    runner: object,
    embeddings: () => Promise<object>,
    prefs: object
  ) => Promise<unknown>;
  let expected: unknown;
  try {
    expected = {
      ok: await execute(
        { data: { actorUserId: "test-actor", ...payload } },
        { withDataContext: async (_access: unknown, work: (db: object) => unknown) => work({}) },
        async () => ({}),
        { get: async () => entry.source ?? null }
      )
    };
  } catch (error) {
    if (!(error instanceof NotesSyncFailure) && !("code" in Object(error))) throw error;
    expected = { error: error instanceof NotesSyncFailure ? error.message : safe(error) };
  }
  return { ...entry, payload, expected, calls };
}
const files = ["/notes/a.md", "/notes/b.md", "/notes/c.md"];
const cases: Entry[] = [
  { files: [] },
  { source: "", files },
  { source: "/notes", files: [] },
  { source: "/notes", files },
  { source: "/notes", files, payload: { sourcePath: "" } },
  { source: null, files, payload: { sourcePath: "/notes" } },
  { source: "/notes", files, purgeFailure: true },
  { source: "/notes", files, failures: { [files[0]!]: "EACCES" } },
  { source: "/notes", files, failures: Object.fromEntries(files.map((f) => [f, "EACCES"])) },
  {
    source: "/notes",
    files,
    resolveFailures: Object.fromEntries(files.map((f) => [f, "OUTSIDE"]))
  },
  { source: "/notes", files, resolveFailures: { [files[0]!]: "ENOENT" } },
  {
    source: "/notes",
    files,
    results: Object.fromEntries(files.map((f) => [f, { status: "skipped", chunksProcessed: 0 }]))
  }
];
for (const processed of [0, 1, 49, 99, 100]) {
  cases.push({
    source: "/notes",
    files,
    results: { [files[0]!]: { status: "ingested", chunksProcessed: processed } }
  });
  cases.push({
    source: "/notes",
    files: [files[0]!],
    results: { [files[0]!]: { status: "ingested", chunksProcessed: processed } }
  });
}
for (const start of [files[0]!, files[1]!, files[2]!, "/notes/gone.md"]) {
  for (const snapshot of [undefined, "snapshot-v1"]) {
    cases.push({
      source: "/notes",
      files,
      payload: {
        filePath: start,
        chunkOffset: 23,
        fileHash: "abc",
        ...(snapshot ? { snapshotKey: snapshot } : {})
      }
    });
  }
}
for (const status of ["ingested", "skipped"]) {
  for (const snapshot of [undefined, "managed-v1"]) {
    const continuation = {
      chunkOffset: 100,
      fileHash: "hash-v1",
      ...(snapshot ? { snapshotKey: snapshot } : {})
    };
    cases.push({
      source: "/notes",
      files,
      results: { [files[0]!]: { status, chunksProcessed: 100, continuation } }
    });
  }
}
cases.push({
  source: "/notes",
  files,
  results: { [files[0]!]: { status: "skipped", chunksProcessed: 0 } },
  failures: { [files[1]!]: "EACCES", [files[2]!]: "UNKNOWN" }
});
for (const code of [
  "EPERM",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENAMETOOLONG",
  "EIO",
  "EUNKNOWN",
  "Eprivate/path",
  "OUTSIDE"
]) {
  cases.push({ source: "/notes", files: [files[0]!], failures: { [files[0]!]: code } });
}
cases.push(
  { source: "/notes", files: [], indexed: ["/notes/gone.md"] },
  {
    source: "/notes",
    files,
    indexed: [...files, "/notes/gone.md", "/notes-else/keep.md", "/elsewhere/keep.md", "/notes"]
  },
  {
    source: "/notes",
    files: ["/notes/alias.md"],
    resolvedFiles: { "/notes/alias.md": "/notes/actual.md" },
    indexed: ["/notes/alias.md", "/notes/actual.md", "/notes/gone.md"],
    results: {
      "/notes/actual.md": {
        status: "ingested",
        chunksProcessed: 100,
        continuation: { chunkOffset: 100, fileHash: "hash" }
      }
    }
  },
  {
    source: "/notes",
    files: ["/notes/alias.md"],
    resolvedFiles: { "/notes/alias.md": "/notes/actual.md" },
    indexed: ["/notes/alias.md", "/notes/actual.md", "/notes/gone.md"]
  },
  {
    source: "/notes",
    files: [files[0]!],
    resolveFailures: { [files[0]!]: "ENOENT" },
    indexed: [files[0]!, "/notes/gone.md"]
  }
);
const rows = [];
for (const entry of cases) rows.push(await legacy(entry));
writeFileSync(
  new URL("../src/tests/sync-vectors.jsonl", import.meta.url),
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
);
console.log(
  `PASS ${rows.length} actual legacy sync coordinator vectors (explicit filesystem, ingestion and transaction stand-ins)`
);
