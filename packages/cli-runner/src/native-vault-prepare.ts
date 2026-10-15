import { VaultContextRunner, grantVaultNativeReadAccess } from "@moss/vault";

const [userId, uid] = process.argv.slice(2);
if (!userId || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error("Invalid vault owner");
await new VaultContextRunner("/data/vaults").withVaultContext({ actorUserId: userId }, (ctx) =>
  grantVaultNativeReadAccess(ctx, Number(uid))
);
