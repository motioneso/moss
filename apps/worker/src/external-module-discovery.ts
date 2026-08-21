import type { ExternalModuleDiscovery } from "@moss/module-registry";
import type { ExternalModuleDiscoveryHolder } from "@moss/module-registry/node";

/**
 * A lookup rebuilt from the holder's live snapshot on every call (#1752). Deliberately
 * uncached — the worker's old `discoveryById` was a `Map` built once at boot, which is
 * the exact staleness this holder exists to fix.
 */
export function buildDiscoveryLookup(
  holder: Pick<ExternalModuleDiscoveryHolder, "getDiscoveries">
): (id: string) => ExternalModuleDiscovery | undefined {
  return (id: string) => holder.getDiscoveries().find((discovery) => discovery.id === id);
}
