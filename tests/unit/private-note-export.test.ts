import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@moss/db";
import { isPathIngestable } from "@moss/memory";
import {
  PrivateNoteExportService,
  isPrivateNoteExportReference,
  notesPrivateExportIngestProvider
} from "@moss/notes";
import { VaultContextRunner, createVaultFile, readVaultFile } from "@moss/vault";

const access: AccessContext = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  requestId: "test"
};
const identity = { sourceId: "22222222-2222-4222-8222-222222222222", version: 1 };
let root: string;
let runner: VaultContextRunner;
let service: PrivateNoteExportService;
const enqueue = vi.fn().mockResolvedValue({ status: "queued", jobId: "job" });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-private-note-"));
  runner = new VaultContextRunner(root);
  service = new PrivateNoteExportService(runner, { enqueue });
  enqueue.mockReset().mockResolvedValue({ status: "queued", jobId: "job" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private versioned note exports", () => {
  it("creates once, reconciles a lost receipt, and queues only as a separate step", async () => {
    expect((await service.inspect(access, identity, "# summary")).status).toBe("missing");
    const result = await service.createOrInspect(access, identity, "# summary");
    expect(result).toMatchObject({
      status: "written",
      destination: "private-vault",
      audience: "owner"
    });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await service.createOrInspect(access, identity, "# summary")).status).toBe("unchanged");
    expect(await service.queueIndex(access, identity, "# summary")).toEqual({
      status: "queued",
      jobId: "job"
    });
    expect(enqueue).toHaveBeenCalledWith(access, result.noteReference);
    expect((await stat(join(root, access.actorUserId, result.noteReference))).mode & 0o777).toBe(
      0o600
    );
  });

  it("preserves manual additions and refuses indexing a mismatching target", async () => {
    const original = await service.createOrInspect(access, identity, "summary");
    const file = join(root, access.actorUserId, original.noteReference);
    await writeFile(file, "summary\nManual addition");
    expect((await service.createOrInspect(access, identity, "summary")).status).toBe("conflict");
    expect(await service.queueIndex(access, identity, "summary")).toEqual({ status: "conflict" });
    expect(await readFile(file, "utf8")).toBe("summary\nManual addition");
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      (await service.createOrInspect(access, { ...identity, version: 2 }, "new summary")).status
    ).toBe("written");
    expect(await readFile(file, "utf8")).toBe("summary\nManual addition");
  });

  it("has one exclusive-create winner and no repeated appended content", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => service.createOrInspect(access, identity, "same"))
    );
    expect(outcomes.filter((item) => item.status === "written")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "unchanged")).toHaveLength(11);
    await runner.withVaultContext(access, async (ctx) => {
      expect(await readVaultFile(ctx, outcomes[0]!.noteReference)).toBe("same");
    });
    const children = await readdir(
      join(root, access.actorUserId, "notes/generated", identity.sourceId)
    );
    expect(children).toEqual(["v1.md"]);
  });

  it("never overwrites either winner when competing contents race", async () => {
    const outcomes = await Promise.all([
      service.createOrInspect(access, identity, "first"),
      service.createOrInspect(access, identity, "second")
    ]);
    expect(outcomes.map((item) => item.status).sort()).toEqual(["conflict", "written"]);
  });

  it("reports a queue failure without losing the written note and allows index-only retry", async () => {
    await service.createOrInspect(access, identity, "summary");
    enqueue.mockRejectedValueOnce(new Error("internal queue detail"));
    expect(await service.queueIndex(access, identity, "summary")).toEqual({ status: "delayed" });
    expect((await service.inspect(access, identity, "summary")).status).toBe("unchanged");
    expect(await service.queueIndex(access, identity, "summary")).toEqual({
      status: "queued",
      jobId: "job"
    });
  });

  it("rejects path-shaped identities, invalid versions and actor traversal before resolving a vault", async () => {
    const open = vi.spyOn(runner, "withVaultContext");
    for (const bad of [0, -1, 1.1, 2_147_483_648]) {
      await expect(
        service.createOrInspect(access, { ...identity, version: bad }, "x")
      ).rejects.toThrow("Invalid");
    }
    await expect(
      service.createOrInspect(access, { ...identity, sourceId: "../escape" }, "x")
    ).rejects.toThrow("Invalid");
    await expect(
      service.createOrInspect({ ...access, actorUserId: "../other" }, identity, "x")
    ).rejects.toThrow("Invalid");
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps owners separate and canonicalizes source UUID casing", async () => {
    const other = { ...access, actorUserId: "33333333-3333-4333-8333-333333333333" };
    const source = { ...identity, sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    await service.createOrInspect(access, source, "one");
    expect((await service.inspect(other, source, "one")).status).toBe("missing");
    expect(
      (
        await service.createOrInspect(
          access,
          { ...source, sourceId: source.sourceId.toUpperCase() },
          "one"
        )
      ).status
    ).toBe("unchanged");
  });

  it("rejects a symlink escape without changing the external target", async () => {
    const outside = join(root, "outside");
    await writeFile(outside, "external");
    await runner.withVaultContext(access, async (ctx) => {
      await symlink(outside, join(ctx.vaultRoot, "linked.md"));
      await expect(createVaultFile(ctx, "linked.md", "bad")).rejects.toThrow();
      await expect(createVaultFile(ctx, "../escape.md", "bad")).rejects.toThrow();
    });
    expect(await readFile(outside, "utf8")).toBe("external");
  });

  it("validates queue references as canonical opaque UUID/version paths", () => {
    expect(isPrivateNoteExportReference(`notes/generated/${identity.sourceId}/v1.md`)).toBe(true);
    for (const value of [
      "private content",
      `notes/generated/${identity.sourceId}/v1.md\n`,
      `notes/generated/${identity.sourceId}/v01.md`,
      `notes/generated/${identity.sourceId}/v2147483648.md`,
      `notes/generated/${identity.sourceId}/v1.md\ncontent`,
      "notes/generated/../v1.md",
      "exports/file.md"
    ]) {
      expect(isPrivateNoteExportReference(value)).toBe(false);
    }
  });

  it("allows only the narrow generated-note namespace for ingest", async () => {
    // Provider does not query DB; its root is applied by the worker inside each actor context.
    const roots = await notesPrivateExportIngestProvider.resolveRoots(
      null as never,
      access.actorUserId
    );
    expect(roots).toEqual(["notes/generated/"]);
    expect(isPathIngestable(`notes/generated/${identity.sourceId}/v1.md`, roots)).toBe(true);
    for (const path of [
      "exports/x.md",
      "attachments/x.md",
      "notes/manual.md",
      "other.md",
      "notes/generated/x.tmp"
    ]) {
      expect(isPathIngestable(path, roots)).toBe(false);
    }
  });
});
