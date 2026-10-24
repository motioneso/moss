import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

/** Real vendor route/adapter fixture; deliberately omits DB-backed user bootstrap hooks. */
export function createVendorMemoryAuth(options: BetterAuthOptions) {
  return betterAuth({
    ...options,
    database: memoryAdapter({
      users: [],
      better_auth_sessions: [],
      auth_accounts: [],
      auth_verifications: []
    }),
    databaseHooks: { session: options.databaseHooks?.session }
  });
}
