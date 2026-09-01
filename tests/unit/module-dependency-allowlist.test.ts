import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sanctioned-coupling allowlist test (#802 module boundary enforcement).
 *
 * "Modules collaborate only through declared public APIs/events. No module imports another
 * module's internals" is a Hard Invariant, but nothing previously stopped a *new*
 * feature-to-feature workspace dependency from appearing silently — every coupling that exists
 * today was added one `package.json` line at a time, with no single place recording which ones
 * are intentional. This test derives the complete feature -> feature dependency edge set from
 * the actual package graph and pins it against an explicit allowlist: adding a new edge means
 * touching `SANCTIONED_FEATURE_COUPLINGS` in this file, a visible, reviewable act (and, per the
 * Hard Invariant, one that needs a spec-level justification — see CLAUDE.md "Module isolation").
 *
 * This gate freezes the status quo; it does not relitigate it. Every edge below already existed
 * in the real dependency graph at the time this test was written (2026-07). Some were previously
 * *undeclared* (resolved only via pnpm's hoisted `node_modules`) and were made honest by the
 * companion `check:package-deps` gate in the same PR — see `chat -> email` / `chat -> notes`,
 * which existed in `packages/chat/src/**` before their `package.json` entries did.
 *
 * Classification (platform vs. feature) is architectural judgment, not derived from any single
 * metadata field — `ModuleManifest` exports exist on both platform and feature packages (e.g.
 * `@moss/ai`, `@moss/memory`, `@moss/settings` all register one), so manifest presence
 * alone doesn't distinguish them. The criterion used here: a package is **platform** if it is
 * cross-cutting infrastructure with no independent, end-user-visible product domain of its own
 * (storage, job queue, auth, generic settings/preferences plumbing, AI routing, ranking/scoring
 * primitives, the composition root) — consumed broadly across feature packages and by other
 * platform packages. A package is **feature** if it represents a distinct product capability a
 * user recognizes as its own area (calendar, chat, connectors, notes, tasks, sports, weather...).
 * Platform packages sometimes depend on feature packages (e.g. `@moss/jobs`, platform, depends
 * on `@moss/notifications`, feature, to write an upgrade notice) — that's expected of hub
 * packages and is intentionally *not* tracked here; only feature -> feature edges are pinned.
 */

const packagesRoot = join(process.cwd(), "packages");

/** Platform: cross-cutting infrastructure, no independent end-user product domain. */
const PLATFORM_PACKAGES = new Set([
  "@moss/ai", // provider-agnostic AI capability router (CLAUDE.md invariant), not a feature
  "@moss/auth",
  "@moss/datasets", // dataset connector SDK runtime host (host pinning, cache, TTL) — infra, not a product domain
  "@moss/db",
  "@moss/host-fetch", // shared server-only outbound network policy/transport
  "@moss/integrations", // external MCP/OpenAPI connection runtime consumed by the composition root — infra like @moss/datasets
  "@moss/jobs",
  "@moss/memory",
  "@moss/module-css-confine", // host-only CSS scoping for module contributions (#1388/D9), no product domain
  "@moss/module-registry", // composition root; wires every module together
  "@moss/module-sdk",
  "@moss/module-web-sdk", // browser-safe frontend contribution SDK (routes/widgets/palette), infra not a product domain
  "@moss/priority", // ranking/ordering primitive; consumed by @moss/shared itself
  "@moss/settings", // generic settings/audit-log hub — "platform packages are expected hubs"
  "@moss/settings-ui",
  "@moss/shared",
  "@moss/source-behaviors", // cross-cutting input-signal weighting for briefings/settings
  "@moss/structured-state", // generic preferences/state store used across features
  "@moss/ui", // authored jds-* component library (#1388), no independent product domain
  "@moss/usefulness-feedback", // cross-cutting feedback-loop signal, no product page of its own
  "@moss/vault",
  "@moss/workflows" // durable run state for any module's workflow; no product page of its own
]);

/** Feature: a distinct, user-recognizable product capability. */
const FEATURE_PACKAGES = new Set([
  "@moss/briefings",
  "@moss/calendar",
  "@moss/chat",
  "@moss/cli-runner",
  "@moss/commitments",
  "@moss/connectors",
  "@moss/email",
  "@moss/goals",
  "@moss/news",
  "@moss/notes",
  "@moss/notifications",
  "@moss/people",
  "@moss/proactive-monitoring",
  "@moss/sports",
  "@moss/tasks",
  "@moss/weather",
  "@moss/web-research",
  "@moss/wellness",
  "@moss/workshop"
]);

/**
 * The complete, pre-sanctioned feature -> feature coupling set, derived from the actual package
 * graph (not copied from the design spec's illustrative example, which was explicitly
 * known-incomplete). Adding an edge here is a visible act requiring review.
 */
const SANCTIONED_FEATURE_COUPLINGS = [
  "@moss/briefings -> @moss/notifications",
  "@moss/chat -> @moss/calendar",
  "@moss/chat -> @moss/connectors",
  "@moss/chat -> @moss/email",
  "@moss/chat -> @moss/notes",
  "@moss/chat -> @moss/tasks",
  // #1888: chat is the composition host for workshop.buildModule. Workshop declares the service it
  // needs (`ModuleBuildStartService`) in its public API and never constructs it; chat implements
  // that interface because it owns the database handle, the queue and the admin check. Type-only
  // import of a declared public boundary — the same shape as the calendar/email write services
  // above, not a reach into another module's internals.
  "@moss/chat -> @moss/workshop",
  "@moss/cli-runner -> @moss/chat",
  "@moss/connectors -> @moss/calendar",
  "@moss/connectors -> @moss/email",
  // #975 Slice 4: revalidation writes its one owner-facing summary through the
  // Notifications public boundary (same shape as briefings -> notifications above).
  "@moss/news -> @moss/notifications",
  // #1572: custom sports news sources reuse News's URL-preview/confirm helpers
  // (NEWS_MAX_CUSTOM_SOURCES, discovery types) rather than duplicating them.
  "@moss/sports -> @moss/news"
].sort();

interface PackageManifest {
  readonly name: string;
  readonly dependencyNames: readonly string[];
}

function listWorkspacePackages(): PackageManifest[] {
  const entries = readdirSync(packagesRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  );

  const manifests: PackageManifest[] = [];
  for (const entry of entries) {
    const manifestPath = join(packagesRoot, entry.name, "package.json");
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      continue; // not a real package (no package.json)
    }

    const parsed = JSON.parse(raw) as {
      name?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (!parsed.name) continue;

    manifests.push({
      name: parsed.name,
      dependencyNames: [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.peerDependencies ?? {})
      ].filter((dep) => dep.startsWith("@moss/"))
    });
  }

  return manifests;
}

function deriveFeatureToFeatureEdges(manifests: readonly PackageManifest[]): string[] {
  const edges: string[] = [];
  for (const manifest of manifests) {
    if (!FEATURE_PACKAGES.has(manifest.name)) continue;
    for (const dependency of manifest.dependencyNames) {
      if (FEATURE_PACKAGES.has(dependency)) {
        edges.push(`${manifest.name} -> ${dependency}`);
      }
    }
  }
  return edges.sort();
}

describe("module dependency allowlist (#802 module boundary enforcement)", () => {
  const manifests = listWorkspacePackages();

  it("classifies every workspace package as platform or feature", () => {
    const unclassified = manifests
      .map((manifest) => manifest.name)
      .filter((name) => !PLATFORM_PACKAGES.has(name) && !FEATURE_PACKAGES.has(name));

    expect(
      unclassified,
      `New/renamed package(s) not classified in this test: ${unclassified.join(", ")}. ` +
        "Add them to PLATFORM_PACKAGES or FEATURE_PACKAGES."
    ).toEqual([]);
  });

  it("has no package double-classified as both platform and feature", () => {
    const overlap = [...PLATFORM_PACKAGES].filter((name) => FEATURE_PACKAGES.has(name));
    expect(overlap).toEqual([]);
  });

  it("matches the complete feature -> feature edge set against the sanctioned allowlist", () => {
    const derivedEdges = deriveFeatureToFeatureEdges(manifests);
    expect(derivedEdges).toEqual(SANCTIONED_FEATURE_COUPLINGS);
  });
});
