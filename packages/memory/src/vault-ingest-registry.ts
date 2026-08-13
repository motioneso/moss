import path from "node:path";

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

/**
 * Collapses `.`/`..` segments via `path.posix.normalize` and rejects anything that still escapes
 * (a leading `..` or an absolute path) by returning `null` — such a root can never match any
 * path. Without this, a root like `"people/.."` normalized naively to `"people/../"`, which
 * `String.prototype.startsWith` treats as a literal prefix rather than resolving `..` — letting a
 * path escape its allowlisted root into a hard-excluded one.
 */
function normalizeRoot(root: string): string | null {
  const trimmed = root.replace(/^\/+/, "");
  const isFile = trimmed.endsWith(".md");
  const withMarker = isFile ? trimmed : trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const normalized = path.posix.normalize(withMarker);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  if (isFile) return normalized;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

/** Same escape-collapsing as `normalizeRoot`, applied to the candidate path being checked. */
function normalizeRelPath(relPath: string): string | null {
  const trimmed = relPath.replace(/^\/+/, "");
  const normalized = path.posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}

function isHardExcluded(relPath: string): boolean {
  return HARD_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** True only for `.md` under a resolved root and not under a hard-excluded prefix. */
export function isPathIngestable(relPath: string, roots: readonly string[]): boolean {
  const normalizedPath = normalizeRelPath(relPath);
  if (normalizedPath === null) return false;
  if (!normalizedPath.endsWith(".md")) return false;
  if (isHardExcluded(normalizedPath)) return false;
  return roots.some((root) => {
    const normalized = normalizeRoot(root);
    if (normalized === null) return false;
    return normalized.endsWith(".md")
      ? normalizedPath === normalized
      : normalizedPath.startsWith(normalized);
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
    if (normalized === null) {
      throw new Error(
        `Vault ingest provider "${provider.moduleId}" resolved a root ("${root}") that escapes ` +
          `the vault`
      );
    }
    if (HARD_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(
        `Vault ingest provider "${provider.moduleId}" resolved a root ("${root}") under a ` +
          `hard-excluded prefix`
      );
    }
  }
  return roots;
}
