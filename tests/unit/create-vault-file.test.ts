import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VaultContextRunner, createVaultFile, readVaultFile, vaultFileExists } from "@moss/vault";

const fault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fault.partialWrite) {
        await actual.writeFile(args[0], "partial", args[2]);
        throw new Error("synthetic disk failure");
      }
      return actual.writeFile(...args);
    }
  };
});

it("does not publish partial temporary writes and can retry after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "moss-vault-create-"));
  try {
    await new VaultContextRunner(root).withVaultContext(
      { actorUserId: "synthetic-owner", requestId: "test" },
      async (ctx) => {
        fault.partialWrite = true;
        await expect(createVaultFile(ctx, "notes/test.md", "complete")).rejects.toThrow(
          "synthetic disk failure"
        );
        expect(await vaultFileExists(ctx, "notes/test.md")).toBe(false);
        expect(await readdir(join(ctx.vaultRoot, "notes"))).toEqual([]);
        fault.partialWrite = false;
        expect(await createVaultFile(ctx, "notes/test.md", "complete")).toBe("created");
        expect(await readVaultFile(ctx, "notes/test.md")).toBe("complete");
        expect(await createVaultFile(ctx, "notes/test.md", "replacement")).toBe("exists");
        expect(await readVaultFile(ctx, "notes/test.md")).toBe("complete");
      }
    );
  } finally {
    fault.partialWrite = false;
    await rm(root, { recursive: true, force: true });
  }
});
