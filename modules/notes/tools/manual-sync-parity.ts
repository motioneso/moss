/** Execute the authored legacy HTTP handler. Transaction, preference and queue
 * boundaries are explicit stand-ins; this does not prove a running server. */
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../../../packages/notes/src/notes-sync-routes.ts", import.meta.url),
  "utf8"
);
const ast = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.ES2022, true);
const register = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "registerNotesSyncRoutes"
);
if (!register) throw new Error("Legacy manual sync handler missing");
const script = ts.transpileModule(
  register.getText(ast).replace(/^export /, "") + "\nregisterNotesSyncRoutes;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
const id = "ca52403e-9b4a-4ff7-bd53-7590890c563c";
const cases = [];
for (const stored of [null, "", 3, {}, "/notes", " "]) {
  let handler: (() => Promise<unknown>) | undefined;
  const queued: unknown[] = [];
  const execute = runInNewContext(script, {
    HttpError,
    NOTES_SOURCE_PREFERENCE_KEY: "notes-source-path",
    NOTES_SYNC_QUEUE: "notes.sync",
    postNotesSyncRouteSchema: {},
    handleRouteError: (error: HttpError, reply: { code: (n: number) => unknown }) => {
      reply.code(error.statusCode);
      return { error: error.message };
    },
    sendJob: async (_boss: unknown, queue: string, payload: unknown) => {
      queued.push({ queue, payload });
      return id;
    }
  }) as (server: unknown, deps: unknown) => void;
  let status = 200;
  const reply = {
    code: (n: number) => {
      status = n;
      return reply;
    },
    send: (body: unknown) => body
  };
  execute(
    {
      post: (
        _path: string,
        _options: unknown,
        run: (req: unknown, res: unknown) => Promise<unknown>
      ) => {
        handler = () => run({ body: { actorUserId: "other", sourcePath: "/other" } }, reply);
      }
    },
    {
      resolveAccessContext: async () => ({ actorUserId: "owner" }),
      dataContext: {
        withDataContext: async (_access: unknown, fn: (db: unknown) => unknown) => fn({})
      },
      preferencesRepository: { get: async () => stored },
      boss: {}
    }
  );
  if (!handler) throw new Error("Legacy route not registered");
  const body = await handler();
  cases.push({ source: stored, expected: { status, body } });
  if (
    queued.length &&
    JSON.stringify(queued) !==
      JSON.stringify([
        { queue: "notes.sync", payload: { actorUserId: "owner", sourcePath: stored } }
      ])
  )
    throw new Error("Legacy caller isolation changed");
}
writeFileSync(
  new URL("../src/tests/manual-sync-vectors.jsonl", import.meta.url),
  cases.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
);
console.log(
  `PASS ${cases.length} legacy manual-sync HTTP cases; preference/queue boundaries are stand-ins`
);
