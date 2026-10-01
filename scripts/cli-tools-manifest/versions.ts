// Picks which registry version of a package the publisher considers.
import { compareVersions, isStableVersion } from "./manifest.js";

export interface RegistryPackument {
  readonly versions: Readonly<Record<string, { readonly deprecated?: string }>>;
}

/** Newest stable, non-deprecated version, or null when none qualifies. No minimum age (Q2). */
export function pickVersion(doc: RegistryPackument): string | null {
  let best: string | null = null;
  for (const [version, meta] of Object.entries(doc.versions)) {
    if (!isStableVersion(version) || meta.deprecated) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}
