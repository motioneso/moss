// The publisher's own list of packages. The image catalog stays the install allowlist;
// this file mirrors it (a unit test keeps the two in step) and adds what only the
// publisher needs, such as the expected source repository for provenance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PackageRole } from "./manifest.js";

export interface PublisherPackage {
  readonly toolset: string;
  readonly role: PackageRole;
  readonly pkg: string;
  /** "owner/repo" an npm provenance attestation must name as its source. */
  readonly expectedRepo: string;
  /** Per-arch native packages that must appear in the generated lockfile. */
  readonly archPackages: readonly string[];
}

export function loadPublisherPackages(
  file = fileURLToPath(new URL("./packages.json", import.meta.url))
): readonly PublisherPackage[] {
  return JSON.parse(readFileSync(file, "utf8")) as PublisherPackage[];
}

export function toolsetNames(packages: readonly PublisherPackage[]): string[] {
  return [...new Set(packages.map((p) => p.toolset))];
}
