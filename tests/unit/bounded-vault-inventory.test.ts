import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { VaultContextRunner } from "@moss/vault";
import { readBoundedVaultInventory } from "../../packages/vault/src/bounded-vault-inventory.js";

import { it } from "vitest";

it("bounds streamed inventory and rejects escaped or symlinked candidates", async () => {
  const base = await mkdtemp(join(tmpdir(), "bounded-vault-inventory-"));
  const realBase = join(base, "real");
  await mkdir(realBase);
  const alias = join(base, "alias");
  await symlink(realBase, alias);
  const runner = new VaultContextRunner(alias);

  async function fixture(work: (path: string) => Promise<void>) {
    return runner.withVaultContext({ actorUserId: randomUUID() }, async (ctx) => {
      await work(ctx.vaultRoot);
      return readBoundedVaultInventory(ctx);
    });
  }
  try {
    const complete = await fixture(async (root) => {
      await mkdir(join(root, "My topic"));
      await writeFile(join(root, "My topic", "idea.md"), "草".repeat(1000));
      await writeFile(join(root, "ignored.bin"), "binary unrelated file");
      await symlink("/etc", join(root, "outside"));
      await symlink("/etc/passwd", join(root, "outside.md"));
    });
    assert.equal(complete.status, "complete");
    assert.equal(complete.entries.length, 3);
    const topic = complete.entries.find((e) => e.kind === "markdown")!;
    assert.equal(topic.path, "My topic/idea.md");
    assert.equal(topic.excerpt, "草".repeat(682));
    assert(Buffer.byteLength(topic.excerpt!, "utf8") <= 2048);
    assert(complete.entries.every((entry) => !entry.path.includes("outside")));

    const entries = await fixture(async (root) => {
      for (let i = 0; i < 210; i++) await writeFile(join(root, `note-${i}.md`), "short");
    });
    assert.equal(entries.status, "overflow");
    assert.equal(entries.status === "overflow" && entries.limit, "entries");
    assert.equal(entries.entries.length, 200);

    const serialized = await fixture(async (root) => {
      for (let i = 0; i < 150; i++) await writeFile(join(root, `note-${i}.md`), "A".repeat(2048));
    });
    assert.equal(serialized.status, "overflow");
    assert.equal(serialized.status === "overflow" && serialized.limit, "serialized_bytes");
    assert(Buffer.byteLength(JSON.stringify(serialized), "utf8") <= 256 * 1024);

    const paths = await fixture(async (root) => {
      const nested = join(root, ...Array.from({ length: 6 }, () => "草".repeat(30)));
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "note.md"), "bounded");
    });
    assert.equal(paths.status === "overflow" && paths.limit, "path_bytes");

    const depth = await fixture(async (root) => {
      await mkdir(join(root, ...Array.from({ length: 18 }, () => "nested")), { recursive: true });
    });
    assert.equal(depth.status === "overflow" && depth.limit, "depth");

    const scanned = await fixture(async (root) => {
      for (let i = 0; i < 8193; i++) await writeFile(join(root, `file-${i}.bin`), "");
    });
    assert.equal(scanned.status === "overflow" && scanned.limit, "scanned_entries");

    for (const invalid of [[0xff, 0xfe], [0xe8], [0xe8, 0x8d]]) {
      await assert.rejects(() =>
        fixture(async (root) => {
          await writeFile(join(root, "invalid.md"), Buffer.from(invalid));
        })
      );
    }
    await assert.rejects(() =>
      fixture(async (root) => {
        await writeFile(
          join(root, "exact.md"),
          Buffer.concat([Buffer.alloc(2047, 65), Buffer.from([0xe8])])
        );
      })
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
