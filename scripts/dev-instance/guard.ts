/**
 * #1258: refuses to let the dev-instance CLI operate against anything but the local dev
 * database, and refuses to run at all when NODE_ENV is set (a set NODE_ENV changes which
 * keyring `packages/db/src/keyring.ts` resolves, so a credential written under the wrong key
 * fails later with an opaque authentication-tag error).
 *
 * Allowlist on database name and port, never a denylist — mirrors
 * `tests/integration/test-database.ts` `assertIsolatedTestDatabase` and
 * `tests/uat/seed/guard.ts` `assertTargetIsEphemeral`. A malformed connection string throws; it
 * never passes by default.
 */

export const DEV_INSTANCE_DATABASE_NAMES: readonly string[] = ["jarv1s"];
export const DEV_INSTANCE_PORTS: readonly string[] = ["55433"];
// The migration-owner URL uses the in-container port when the CLI runs inside the dev-instance
// container itself (see tests/uat/provisioner.ts) rather than the host-mapped port above.
export const DEV_INSTANCE_MIGRATION_PORTS: readonly string[] = ["55433", "5432"];

export class NotDevInstanceError extends Error {
  constructor(reason: string) {
    super(`[dev-instance] refusing: target is not the dev instance (${reason})`);
    this.name = "NotDevInstanceError";
  }
}

export class DevEnvParityError extends Error {
  constructor(nodeEnv: string) {
    super(
      `[dev-instance] refusing: NODE_ENV is set to "${nodeEnv}" — the dev-instance CLI must run ` +
        "with NODE_ENV unset so it resolves the same keyring a source-run dev instance uses"
    );
    this.name = "DevEnvParityError";
  }
}

export function assertTargetIsDevInstance(
  connectionString: string,
  allowedPorts: readonly string[] = DEV_INSTANCE_PORTS
): void {
  if (!connectionString) {
    throw new NotDevInstanceError("empty connection string");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new NotDevInstanceError("connection string is not a parseable URL");
  }

  const databaseName = url.pathname.replace(/^\//, "");
  if (!DEV_INSTANCE_DATABASE_NAMES.includes(databaseName)) {
    throw new NotDevInstanceError(`database name "${databaseName}" is not on the allowlist`);
  }

  if (!allowedPorts.includes(url.port)) {
    throw new NotDevInstanceError(`port "${url.port}" is not on the allowlist`);
  }
}

export function assertDevEnvParity(env: NodeJS.ProcessEnv): void {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv) {
    throw new DevEnvParityError(nodeEnv);
  }
}
