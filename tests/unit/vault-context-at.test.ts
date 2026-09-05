import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readVaultFile,
  VaultContextError,
  VaultContextRunner,
  VaultPathError,
  writeVaultFile
} from "@moss/vault";

const accessContext = { actorUserId: "owner-1", requestId: "vault-context-at" };

let base = "";
let allowedRoot = "";
let outsideRoot = "";
let runner: VaultContextRunner;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "jarvis-vault-at-"));
  allowedRoot = join(base, "notes");
  outsideRoot = join(base, "outside");
  await mkdir(join(allowedRoot, "People"), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(outsideRoot, "secret.md"), "not yours", "utf8");
  runner = new VaultContextRunner(join(base, "private-vaults"));
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe("withVaultContextAt", () => {
  it("opens a folder that sits inside an allowed root", async () => {
    const written = await runner.withVaultContextAt(
      accessContext,
      join(allowedRoot, "People"),
      [allowedRoot],
      async (ctx) => {
        await writeVaultFile(ctx, "Ada.md", "# Ada\n");
        return readVaultFile(ctx, "Ada.md");
      }
    );
    expect(written).toBe("# Ada\n");
  });

  it("refuses a root outside every allowed root", async () => {
    await expect(
      runner.withVaultContextAt(accessContext, outsideRoot, [allowedRoot], async () => "reached")
    ).rejects.toBeInstanceOf(VaultContextError);
  });

  it("refuses a root that does not exist and a relative root", async () => {
    await expect(
      runner.withVaultContextAt(
        accessContext,
        join(allowedRoot, "NoSuchFolder"),
        [allowedRoot],
        async () => "reached"
      )
    ).rejects.toBeInstanceOf(VaultContextError);

    await expect(
      runner.withVaultContextAt(accessContext, "People", [allowedRoot], async () => "reached")
    ).rejects.toBeInstanceOf(VaultContextError);
  });

  it("refuses a root whose symlink target leaves the allowed roots", async () => {
    const link = join(allowedRoot, "EscapeRoot");
    await symlink(outsideRoot, link, "dir");
    await expect(
      runner.withVaultContextAt(accessContext, link, [allowedRoot], async () => "reached")
    ).rejects.toBeInstanceOf(VaultContextError);
  });

  it("refuses a file inside the root that symlinks out of it", async () => {
    const peopleFolder = join(allowedRoot, "People");
    await symlink(join(outsideRoot, "secret.md"), join(peopleFolder, "escape.md"), "file");
    await expect(
      runner.withVaultContextAt(accessContext, peopleFolder, [allowedRoot], (ctx) =>
        readVaultFile(ctx, "escape.md")
      )
    ).rejects.toBeInstanceOf(VaultPathError);
  });

  it("refuses when no allowed root is available", async () => {
    await expect(
      runner.withVaultContextAt(
        accessContext,
        join(allowedRoot, "People"),
        [],
        async () => "reached"
      )
    ).rejects.toBeInstanceOf(VaultContextError);
  });
});
