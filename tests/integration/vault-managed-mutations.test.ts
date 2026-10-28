import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, DataContextRunner, lockManagedActor, lockManagedSources } from "@moss/db";
import { mutateVaultFiles, VaultContextRunner, VaultMutationConflictError } from "@moss/vault";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const db = createDatabase({ connectionString: connectionStrings.app });
const inspection = createDatabase({ connectionString: connectionStrings.bootstrap });
const runner = new DataContextRunner(db);
let root: string;
beforeAll(() => resetFoundationDatabase());
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-vault-mutation-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterAll(async () => {
  await Promise.all([db.destroy(), inspection.destroy()]);
});

interface ChildMessage {
  kind: string;
  pid?: number;
  message?: string;
}
function writer(actor: string, path: string, from: string, to: string, hold = false) {
  const child = fork(
    new URL("./fixtures/vault-mutation-process.ts", import.meta.url),
    [root, actor, path, from, to, hold ? "hold" : ""],
    {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, MOSS_MUTATION_TEST_DB: connectionStrings.app },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    }
  );
  const messages: ChildMessage[] = [];
  child.on("message", (message: ChildMessage) => messages.push(message));
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors = (errors + String(chunk)).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const wait = async (kind: string) => {
    await expect
      .poll(
        () => {
          const failure = messages.find((message) => message.kind === "error");
          if (failure) throw new Error(failure.message);
          if (child.exitCode !== null && !messages.some((message) => message.kind === kind)) {
            throw new Error(`Writer exited ${child.exitCode}: ${errors}`);
          }
          return messages.some((message) => message.kind === kind);
        },
        { timeout: 10000, interval: 20 }
      )
      .toBe(true);
    return messages.find((message) => message.kind === kind)!;
  };
  return { child, messages, wait, exited };
}

describe("coordinated Vault mutation", () => {
  it("preserves a leading UTF-8 byte-order mark during a disjoint text edit", async () => {
    await writeFile(join(root, "topic.md"), "\uFEFFAPPLE BANANA");
    await runner.withDataContext({ actorUserId: ids.userA }, (db) =>
      new VaultContextRunner(root).withVaultContextAt(
        { actorUserId: ids.userA },
        root,
        [root],
        (ctx) =>
          mutateVaultFiles(db, ctx, ["topic.md"], async ([file]) => ({
            changes: [{ path: "topic.md", content: file!.content!.replace("APPLE", "ORANGE") }],
            result: undefined
          }))
      )
    );
    expect(await readFile(join(root, "topic.md"))).toEqual(Buffer.from("\uFEFFORANGE BANANA"));
  });

  it("rejects malformed UTF-8 before invoking a mutable-text transform", async () => {
    const bytes = Buffer.from([0x61, 0xff, 0x62]);
    await writeFile(join(root, "topic.md"), bytes);
    let entered = false;
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        new VaultContextRunner(root).withVaultContextAt(
          { actorUserId: ids.userA },
          root,
          [root],
          (ctx) =>
            mutateVaultFiles(db, ctx, ["topic.md"], async () => {
              entered = true;
              return { changes: [{ path: "topic.md", content: "replacement" }], result: undefined };
            })
        )
      )
    ).rejects.toThrow(TypeError);
    expect(entered).toBe(false);
    expect(await readFile(join(root, "topic.md"))).toEqual(bytes);
  });

  it("rejects a VaultContext belonging to a different scoped actor before reading or writing", async () => {
    await writeFile(join(root, "topic.md"), "untouched");
    let entered = false;
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
        new VaultContextRunner(root).withVaultContextAt(
          { actorUserId: ids.userB },
          root,
          [root],
          (vault) =>
            mutateVaultFiles(scoped, vault, ["topic.md"], async () => {
              entered = true;
              return {
                changes: [{ path: "topic.md", content: "wrong actor" }],
                result: undefined
              };
            })
        )
      )
    ).rejects.toThrow("scoped actor's VaultContext");
    expect(entered).toBe(false);
    expect(await readFile(join(root, "topic.md"), "utf8")).toBe("untouched");
  });

  it("preserves disjoint edits across two processes, owners and canonical aliases", async () => {
    await mkdir(join(root, "real"));
    await symlink("real", join(root, "alias"));
    await writeFile(join(root, "real/topic.md"), "APPLE BANANA");
    const first = writer(ids.userA, "real/topic.md", "APPLE", "ORANGE", true);
    let second: ReturnType<typeof writer> | undefined;
    try {
      await first.wait("read");
      second = writer(ids.userB, "alias/topic.md", "BANANA", "GRAPE");
      const { pid } = await second.wait("ready");
      const other = second;
      await expect
        .poll(
          async () => {
            if (other.messages.some(({ kind }) => kind === "read")) return "read-before-lock";
            const result = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_locks where pid = ${pid!} and locktype = 'advisory' and not granted
        ) as waiting`.execute(inspection);
            return result.rows[0]!.waiting ? "waiting" : "starting";
          },
          { timeout: 10000, interval: 20 }
        )
        .toBe("waiting");
      first.child.send("release");
      await Promise.all([first.wait("done"), second.wait("done")]);
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      expect(await readFile(join(root, "real/topic.md"), "utf8")).toBe("ORANGE GRAPE");
    } finally {
      first.child.kill();
      second?.child.kill();
      await Promise.all([first.exited, second?.exited]);
    }
  });

  it("refuses an external edit completed during the transform and preserves its bytes", async () => {
    await writeFile(join(root, "topic.md"), "original");
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
        new VaultContextRunner(root).withVaultContextAt(
          { actorUserId: ids.userA },
          root,
          [root],
          (vault) =>
            mutateVaultFiles(scoped, vault, ["topic.md"], async () => {
              await writeFile(join(root, "topic.md"), "external change");
              return {
                changes: [{ path: "topic.md", content: "stale replacement" }],
                result: undefined
              };
            })
        )
      )
    ).rejects.toThrow(VaultMutationConflictError);
    expect(await readFile(join(root, "topic.md"), "utf8")).toBe("external change");
  });

  it("reads both candidates under locks and publishes only the selected file with private modes", async () => {
    await writeFile(join(root, "topic.md"), "user note");
    await runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
      new VaultContextRunner(root).withVaultContextAt(
        { actorUserId: ids.userA },
        root,
        [root],
        (vault) =>
          mutateVaultFiles(scoped, vault, ["topic.md", "nested/fallback.md"], async (current) => {
            expect(current[0]!.content).toBe("user note");
            expect(current[1]!.content).toBeNull();
            return {
              changes: [{ path: current[1]!.path, content: "managed note" }],
              result: undefined
            };
          })
      )
    );
    expect(await readFile(join(root, "topic.md"), "utf8")).toBe("user note");
    expect(await readFile(join(root, "nested/fallback.md"), "utf8")).toBe("managed note");
    expect((await stat(join(root, "nested/fallback.md"))).mode & 0o777).toBe(0o600);
  });

  it.each(["actor", "source"] as const)(
    "releases shared %s admission only when its transaction ends",
    async (boundary) => {
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const source = { ownerUserId: ids.userA, sourceModuleId: "meetings", sourceId: randomUUID() };
      const first = runner.withDataContext({ actorUserId: ids.userA }, async (scoped) => {
        await lockManagedActor(scoped, ids.userA, "shared");
        await lockManagedSources(scoped, [source, source], "shared");
        entered();
        await held;
      });
      await admitted;
      let exclusive = false;
      const second = runner.withDataContext({ actorUserId: ids.userA }, async (scoped) => {
        const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
          scoped.db
        );
        enteredPid(result.rows[0]!.pid);
        await lockManagedActor(scoped, ids.userA, boundary === "actor" ? "exclusive" : "shared");
        await lockManagedSources(
          scoped,
          [{ ...source, sourceId: source.sourceId.toUpperCase() }],
          "exclusive"
        );
        exclusive = true;
      });
      let enteredPid!: (pid: number) => void;
      const secondPid = new Promise<number>((resolve) => {
        enteredPid = resolve;
      });
      try {
        const pid = await secondPid;
        await expect
          .poll(
            async () =>
              (
                await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_locks where pid = ${pid} and locktype = 'advisory' and not granted
      ) as waiting`.execute(inspection)
              ).rows[0]!.waiting
          )
          .toBe(true);
        expect(exclusive).toBe(false);
      } finally {
        release();
        await Promise.all([first, second]);
      }
      expect(exclusive).toBe(true);
    }
  );
});
