import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultContextRunner, grantVaultNativeReadAccess, writeVaultFile } from "@moss/vault";

const UID = 100_001;
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const acl = (path: string) => execFileSync("getfacl", ["-ncp", "--", path], { encoding: "utf8" });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "vault-native-"));
  scratch.push(base);
  await chmod(base, 0o711);
  const runner = new VaultContextRunner(base);
  return runner.withVaultContext({ actorUserId: "owner" }, async (ctx) => {
    await writeVaultFile(ctx, "nested/proof.md", "private synthetic proof");
    return { base, ctx, file: join(ctx.vaultRoot, "nested/proof.md") };
  });
}

describe("private vault native read grant", () => {
  it("grants only the stable owner slot read/traverse and refreshes a masked app write", async () => {
    const { base, ctx, file } = await fixture();
    await grantVaultNativeReadAccess(ctx, UID);
    expect(acl(base)).toContain(`user:${UID}:--x`);
    expect(acl(ctx.vaultRoot)).toContain(`user:${UID}:r-x`);
    expect(acl(file)).toContain(`user:${UID}:r--`);
    expect(acl(file)).toContain("group::---");
    expect(acl(file)).toContain("other::---");
    await writeVaultFile(ctx, "nested/proof.md", "new private proof");
    expect(acl(file)).toContain("mask::---");
    await grantVaultNativeReadAccess(ctx, UID);
    expect(acl(file)).toContain("mask::r--");
    expect(await readFile(file, "utf8")).toBe("new private proof");
  });
  it("does not activate a masked foreign ACL or change any ACL on refusal", async () => {
    const { ctx, file } = await fixture();
    execFileSync("setfacl", ["-m", "u:100002:rw-,m::---", "--", file]);
    const before = acl(file);
    await expect(grantVaultNativeReadAccess(ctx, UID)).rejects.toThrow("Unexpected vault ACL");
    expect(acl(file)).toBe(before);
    expect(acl(ctx.vaultRoot)).not.toContain(`user:${UID}:`);
  });
  it("rejects hardlinked files before granting directory traversal", async () => {
    const { base, ctx, file } = await fixture();
    await link(file, join(base, "outside-alias"));
    await expect(grantVaultNativeReadAccess(ctx, UID)).rejects.toThrow("Hardlinked vault file");
    expect(acl(ctx.vaultRoot)).not.toContain(`user:${UID}:`);
  });
  it("skips links into foreign vaults and refuses a linked root ancestor", async () => {
    const { base, ctx } = await fixture();
    const foreign = join(base, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await symlink(foreign, join(ctx.vaultRoot, "foreign-link"));
    await grantVaultNativeReadAccess(ctx, UID);
    expect(acl(foreign)).not.toContain(`user:${UID}:`);
    const alias = join(base, "alias");
    await symlink(base, alias);
    const runner = new VaultContextRunner(alias);
    await expect(
      runner.withVaultContext({ actorUserId: "owner" }, (linked) =>
        grantVaultNativeReadAccess(linked, UID)
      )
    ).rejects.toThrow("Linked vault ancestor");
  });
});
