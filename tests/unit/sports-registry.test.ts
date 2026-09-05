import { describe, expect, it } from "vitest";

import {
  assertModuleRegistryConsistency,
  getBuiltInModuleManifests,
  getBuiltInSqlMigrationDirectories,
  MODULE_IMAGE_CSP_HOSTS,
  type BuiltInModuleRegistration
} from "@moss/module-registry";

describe("sports built-in registration", () => {
  it("registers the sports module manifest", () => {
    const ids = getBuiltInModuleManifests().map((m) => m.id);
    expect(ids).toContain("sports");
  });

  it("contributes the sports sql migration directory", () => {
    const dirs = getBuiltInSqlMigrationDirectories();
    expect(dirs.some((d) => d.endsWith("/packages/sports/sql"))).toBe(true);
  });

  it("derives MODULE_IMAGE_CSP_HOSTS from every module's externalSources.imageHosts", () => {
    // Pinned by tests/unit/static-web-csp.test.ts's exact img-src string. Order is registration
    // order (sports before news, #897), with each module's hosts in its manifest order — the
    // news catalog pre-sorts its union, so the news block below is alphabetical.
    expect(MODULE_IMAGE_CSP_HOSTS).toEqual([
      "a.espncdn.com",
      "s.espncdn.com",
      "s.secure.espncdn.com",
      "espnmedia-cdn.akamaized.net",
      "assets.apnews.com",
      "cdn.arstechnica.net",
      "dims.apnews.com",
      "i.guim.co.uk",
      "ichef.bbci.co.uk",
      "media.npr.org",
      "media.wired.com",
      "npr.brightspotcdn.com",
      "platform.theverge.com",
      "static01.nyt.com"
    ]);
  });
});

describe("assertModuleRegistryConsistency: dataset connector SDK (#800)", () => {
  function registrationWith(
    externalSources: NonNullable<BuiltInModuleRegistration["manifest"]["externalSources"]>,
    moduleId = "fixture"
  ): readonly BuiltInModuleRegistration[] {
    return [
      {
        manifest: {
          id: moduleId,
          name: "Fixture",
          version: "0.0.0",
          publisher: "jarv1s",
          lifecycle: "user-toggleable",
          compatibility: { jarv1s: ">=0.0.0" },
          availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
          externalSources
        } as BuiltInModuleRegistration["manifest"],
        sqlMigrationDirectories: [],
        queueDefinitions: []
      }
    ];
  }

  it("rejects a duplicate external source id across modules", () => {
    const dup = {
      id: "espn",
      displayName: "Dup",
      credential: "none" as const,
      fetchHosts: ["example.com"],
      datasets: [{ key: "x", ttlMs: 1000, staleness: "degrade-empty" as const }]
    };
    expect(() =>
      assertModuleRegistryConsistency([
        ...registrationWith([dup], "fixture-a"),
        ...registrationWith([dup], "fixture-b")
      ])
    ).toThrow(/duplicate external source id/i);
  });

  it("rejects an invalid fetchHost (IP literal)", () => {
    expect(() =>
      assertModuleRegistryConsistency(
        registrationWith([
          {
            id: "bad-host",
            displayName: "Bad",
            credential: "none",
            fetchHosts: ["127.0.0.1"],
            datasets: [{ key: "x", ttlMs: 1000, staleness: "degrade-empty" }]
          }
        ])
      )
    ).toThrow(/invalid fetchHost/i);
  });

  it("rejects credential: api-key (reserved, not yet supported)", () => {
    expect(() =>
      assertModuleRegistryConsistency(
        registrationWith([
          {
            id: "needs-key",
            displayName: "Needs Key",
            credential: "api-key",
            fetchHosts: ["example.com"],
            datasets: [{ key: "x", ttlMs: 1000, staleness: "degrade-empty" }]
          }
        ])
      )
    ).toThrow(/api-key/);
  });
});
