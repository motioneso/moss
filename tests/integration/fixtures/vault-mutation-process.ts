import { createDatabase, DataContextRunner } from "@moss/db";
import { mutateVaultFiles, VaultContextRunner } from "@moss/vault";
import { sql } from "kysely";

const [root, actorUserId, path, oldText, newText, hold] = process.argv.slice(2);
if (!root || !actorUserId || !path || !oldText || !newText)
  throw new Error("Missing fixture input");
let release!: () => void;
const released = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message === "release") release();
});
const connectionString = process.env.MOSS_MUTATION_TEST_DB;
if (!connectionString) throw new Error("Missing fixture database");
const db = createDatabase({ connectionString, maxConnections: 1 });
try {
  await new DataContextRunner(db).withDataContext({ actorUserId }, (scoped) =>
    new VaultContextRunner(root).withVaultContextAt(
      { actorUserId },
      root,
      [root],
      async (vault) => {
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(scoped.db);
        process.send?.({ kind: "ready", pid: pid.rows[0]!.pid });
        await mutateVaultFiles(scoped, vault, [path], async ([current]) => {
          process.send?.({ kind: "read" });
          if (hold === "hold") await released;
          if (!current?.content?.includes(oldText)) throw new Error("Fixture source missing");
          return {
            changes: [{ path, content: current.content.replace(oldText, newText) }],
            result: undefined
          };
        });
      }
    )
  );
  process.send?.({ kind: "done" });
} catch (error) {
  process.send?.({
    kind: "error",
    message: error instanceof Error ? error.message : "Fixture failed"
  });
  process.exitCode = 1;
} finally {
  await db.destroy();
  process.disconnect?.();
}
