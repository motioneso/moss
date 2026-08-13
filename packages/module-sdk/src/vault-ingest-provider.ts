import type { DataContextDb } from "@moss/db";

/**
 * Lives here (not @moss/memory) so modules that provide roots — e.g. @moss/structured-state,
 * @moss/people — can implement this without depending on @moss/memory. @moss/memory itself
 * depends on @moss/settings, which depends on @moss/structured-state, so a
 * structured-state -> memory edge would close a cycle.
 */
export interface VaultIngestRootProvider {
  readonly moduleId: string;
  /** Owner's ingestable vault-relative root prefixes; empty = nothing for this owner. */
  resolveRoots(scopedDb: DataContextDb, ownerUserId: string): Promise<readonly string[]>;
}
