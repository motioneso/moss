import type { DataContextDb } from "@moss/db";
import type { VaultIngestRootProvider } from "@moss/module-sdk";

export type { VaultIngestRootProvider } from "@moss/module-sdk";

/**
 * Fail-closed regardless of what any provider resolves — a root under one of these can never
 * become ingestable, even via a misconfigured or compromised provider (spec's belt-and-braces
 * rule).
 */
export const HARD_EXCLUDED_PREFIXES: readonly string[] = ["attachments/", "exports/"];

let providers: VaultIngestRootProvider[] = [];

export function registerVaultIngestRootProvider(provider: VaultIngestRootProvider): void {
  providers.push(provider);
}

export function listVaultIngestRootProviders(): readonly VaultIngestRootProvider[] {
  return providers;
}

export function resetVaultIngestRootProvidersForTests(): void {
  providers = [];
}

function normalizeRoot(root: string): string {
  const trimmed = root.replace(/^\/+/, "");
  if (trimmed.endsWith(".md")) return trimmed;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isHardExcluded(relPath: string): boolean {
  return HARD_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** True only for `.md` under a resolved root and not under a hard-excluded prefix. */
export function isPathIngestable(relPath: string, roots: readonly string[]): boolean {
  if (!relPath.endsWith(".md")) return false;
  if (isHardExcluded(relPath)) return false;
  return roots.some((root) => {
    const normalized = normalizeRoot(root);
    return normalized.endsWith(".md") ? relPath === normalized : relPath.startsWith(normalized);
  });
}

/**
 * Calls a provider's resolveRoots and enforces the hard-excluded-prefix guard on the result —
 * the belt to isPathIngestable's braces. A provider that resolves a root under attachments/ or
 * exports/ (e.g. a user-configurable folder preference pointed at one) fails loudly here rather
 * than silently letting isPathIngestable's per-path check be the only line of defense.
 */
export async function resolveIngestRoots(
  provider: VaultIngestRootProvider,
  scopedDb: DataContextDb,
  ownerUserId: string
): Promise<readonly string[]> {
  const roots = await provider.resolveRoots(scopedDb, ownerUserId);
  for (const root of roots) {
    const normalized = normalizeRoot(root);
    if (HARD_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(
        `Vault ingest provider "${provider.moduleId}" resolved a root ("${root}") under a ` +
          `hard-excluded prefix`
      );
    }
  }
  return roots;
}
