import { afterEach, describe, expect, it, vi } from "vitest";

import type { MossModuleManifest, RouteChatTargetResolver } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { memoryModuleManifest } from "../../packages/memory/src/manifest.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import { notesModuleManifest } from "../../packages/notes/src/manifest.js";
import { peopleModuleManifest } from "../../packages/people/src/manifest.js";
import { scratchpadModuleManifest } from "../../packages/scratchpad/src/manifest.js";
import { wellnessModuleManifest } from "../../packages/wellness/src/manifest.js";
import {
  PRIVACY_EXPECTED_ROWS,
  PRIVACY_MODULE_IDS,
  PRIVACY_NAMED_BLOCKED
} from "../fixtures/route-chat-content-privacy.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_FACT_ID = "33333333-3333-4333-8333-333333333333";
const SUBJECT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_SUBJECT_ID = "55555555-5555-4555-8555-555555555555";
const CONSENT = "wellness.ai_consent_granted";
const manifests: readonly MossModuleManifest[] = [
  wellnessModuleManifest,
  memoryModuleManifest,
  peopleModuleManifest,
  scratchpadModuleManifest,
  notesModuleManifest
];
const wellness: MossModuleManifest = wellnessModuleManifest;

function targetFor(method: string, path: string): RouteChatTargetResolver {
  const target = buildRouteCatalog(manifests, []).resolve(method, path)?.route.policy.target;
  expect(target).toBeTypeOf("function");
  return async (db, params) => {
    const resolved = await target!(db, params);
    return typeof resolved === "object" && resolved ? resolved.label : resolved;
  };
}

function factRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    subject_entity_id: SUBJECT_ID,
    subject_name: "Alex",
    predicate: "prefers",
    object_text: "Early mornings",
    object_entity_id: null,
    object_name: null,
    ...overrides
  };
}

function expectScopedEntityJoins(query: string | undefined) {
  const normalized = query?.replace(/\s+/g, " ");
  expect(normalized).toContain("SELECT f.id, f.subject_entity_id, s.name AS subject_name");
  expect(normalized).toContain(
    "LEFT JOIN app.memory_entities s ON s.id = f.subject_entity_id AND s.owner_user_id = app.current_actor_user_id()"
  );
  expect(normalized).toContain(
    "LEFT JOIN app.memory_entities e ON e.id = f.object_entity_id AND e.owner_user_id = app.current_actor_user_id()"
  );
}

afterEach(() => vi.restoreAllMocks());

describe("private-content route policies", () => {
  it("classifies every route explicitly with no default access", () => {
    expect(new Set(manifests.map((manifest) => manifest.id))).toEqual(PRIVACY_MODULE_IDS);
    for (const manifest of manifests) {
      expect(manifest.chatDefaults?.access).toBeUndefined();
      for (const route of manifest.routes ?? []) expect(route.chat?.access).toBeDefined();
    }
    expect(() => assertRouteChatClassification(manifests)).not.toThrow();
  });

  it("pins every effective route policy", () => {
    const catalog = buildRouteCatalog(manifests, []);
    expect(catalog.routes).toHaveLength(
      manifests.reduce((sum, manifest) => sum + (manifest.routes?.length ?? 0), 0)
    );
    const rows = catalog.routes.map(({ moduleId, method, path, policy }) =>
      [
        moduleId,
        method,
        path,
        policy.access,
        policy.blockedBecause,
        policy.content === "user_authored" ? policy.content : undefined,
        policy.outbound ? "outbound" : undefined
      ]
        .filter((part) => part !== undefined)
        .join(" ")
    );
    expect(rows.sort()).toEqual([...PRIVACY_EXPECTED_ROWS].sort());
  });

  it.each(PRIVACY_NAMED_BLOCKED)("declares %s %s blocked as %s", (method, path, reason) => {
    const route = manifests
      .flatMap((manifest) => manifest.routes ?? [])
      .find((entry) => entry.method === method && entry.path === path);
    // Test the declaration independently of centrally forced catalog blocks.
    expect(route?.chat).toMatchObject({ access: "blocked", blockedBecause: reason });
    const effective = buildRouteCatalog(manifests, []).resolve(
      method,
      path.replace(/:[A-Za-z]+/g, TARGET_ID)
    );
    expect(effective?.route.policy).toMatchObject({ access: "blocked", blockedBecause: reason });
  });

  it("has exactly the reviewed nonblocked Wellness routes", () => {
    const allowed = buildRouteCatalog([wellness], [])
      .routes.filter((route) => route.policy.access !== "blocked")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(allowed).toEqual(
      [
        "GET /api/wellness/ai-consent",
        "POST /api/wellness/checkins",
        "GET /api/wellness/checkins",
        "PATCH /api/wellness/checkins/:id",
        "GET /api/wellness/insights",
        "DELETE /api/wellness/therapy-notes/:id"
      ].sort()
    );
  });

  it("requires Wellness consent on every effective policy, including blocked routes", () => {
    expect(wellness.aiConsent?.key).toBe(CONSENT);
    for (const route of buildRouteCatalog([wellness], []).routes) {
      expect(route.policy.consent, `${route.method} ${route.path}`).toBe(CONSENT);
    }
  });

  it.each([true, false])(
    "keeps raw Wellness responses blocked when consent is %s",
    async (granted) => {
      const { scoped } = makeRecordingDb();
      vi.spyOn(PreferencesRepository.prototype, "get").mockResolvedValue(granted);
      expect(await wellness.aiConsent?.isGranted(scoped, ACTOR_ID)).toBe(granted);
      const catalog = buildRouteCatalog([wellness], []);
      for (const [method, path] of PRIVACY_NAMED_BLOCKED.filter(
        ([, path, reason]) => path.startsWith("/api/wellness/") && reason === "data_scope_consent"
      )) {
        expect(catalog.resolve(method, path.replace(":id", TARGET_ID))?.route.policy.access).toBe(
          "blocked"
        );
      }
    }
  );

  it("resolves consent through the scoped preference and preserves the active-module default", async () => {
    const { scoped } = makeRecordingDb();
    const get = vi.spyOn(PreferencesRepository.prototype, "get").mockResolvedValue(null);
    expect(await wellness.aiConsent?.isGranted(scoped, ACTOR_ID)).toBe(true);
    expect(get).toHaveBeenCalledExactlyOnceWith(scoped, CONSENT);
    get.mockClear();
    await expect(wellness.aiConsent?.isGranted({}, ACTOR_ID)).rejects.toThrow(/withDataContext/);
    expect(get).not.toHaveBeenCalled();
  });

  it("gives every parameterized destructive route a resolver", () => {
    const destructive = buildRouteCatalog(manifests, []).routes.filter(
      ({ path, policy }) => policy.access === "destructive" && path.includes("/:")
    );
    expect(destructive.length).toBeGreaterThan(0);
    for (const { policy } of destructive) expect(policy.target).toBeTypeOf("function");
  });

  it.each([
    ["GET", "/api/scratchpad"],
    ["POST", "/api/scratchpad/append"],
    ["GET", "/api/memory/graph/recall"],
    ["GET", "/api/memory/graph/core"],
    ["GET", "/api/memory/dashboard"],
    ["GET", "/api/memory/candidates"],
    ["POST", "/api/memory/graph/entities"],
    ["POST", "/api/memory/graph/facts"],
    ["POST", "/api/wellness/checkins"],
    ["GET", "/api/wellness/checkins"],
    ["PATCH", `/api/wellness/checkins/${TARGET_ID}`]
  ])("taints returned note/memory text from %s %s", (method, path) => {
    expect(buildRouteCatalog(manifests, []).resolve(method, path)?.route.policy.content).toBe(
      "outside"
    );
  });
});

describe("private-content approval target resolvers", () => {
  it.each([
    ["DELETE", `/api/memory/graph/facts/${TARGET_ID}`],
    ["DELETE", `/api/memory/graph/entities/${TARGET_ID}`],
    ["POST", `/api/memory/graph/facts/${TARGET_ID}/confirm`],
    ["POST", `/api/memory/graph/facts/${TARGET_ID}/correct`],
    ["POST", `/api/memory/candidates/${TARGET_ID}/accept`],
    ["POST", `/api/memory/candidates/${TARGET_ID}/reject`],
    ["POST", `/api/memory/candidates/${TARGET_ID}/suppress`],
    ["DELETE", `/api/wellness/therapy-notes/${TARGET_ID}`]
  ])("requires a scoped handle and validates the id for %s %s", async (method, path) => {
    const target = targetFor(method, path);
    await expect(target({}, { id: TARGET_ID })).rejects.toThrow(/withDataContext/);
    const { scoped, queries } = makeRecordingDb();
    expect(await target(scoped, {})).toBeNull();
    expect(await target(scoped, { id: "invalid" })).toBeNull();
    expect(queries).toEqual([]);
    expect(await target(scoped, { id: TARGET_ID })).toBeNull();
  });

  it("reads a memory fact label from the actor-scoped record", async () => {
    const target = targetFor("DELETE", `/api/memory/graph/facts/${TARGET_ID}`);
    const { scoped, queries } = makeRecordingDb({
      rows: [factRow()]
    });
    expect(await target(scoped, { id: TARGET_ID })).toBe(`Alex: prefers: Early mornings`);
    expectScopedEntityJoins(queries[0]?.sql);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("app.memory_facts");
    expect(queries[0]?.parameters).toContain(TARGET_ID);
    expect(queries[0]?.sql).not.toMatch(/insert|update|delete/i);
    expect(queries[0]?.sql).toContain("app.current_actor_user_id()");
  });

  it.each(["confirm", "correct"])(
    "names the selected fact and every competing fact for %s",
    async (operation) => {
      const target = targetFor("POST", `/api/memory/graph/facts/${TARGET_ID}/${operation}`);
      const { scoped, queries } = makeRecordingDb({
        rows: [factRow(), factRow({ id: OTHER_FACT_ID, object_text: "Late nights" })]
      });
      expect(await target(scoped, { id: TARGET_ID })).toBe(
        `Selected memory: Alex: prefers: Early mornings; ` +
          `other affected memories: Alex: prefers: Late nights`
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain("f.conflict_group_id");
      expectScopedEntityJoins(queries[0]?.sql);
      expect(queries[0]?.sql).toContain("app.current_actor_user_id()");
      expect(queries[0]?.parameters).toEqual([TARGET_ID, TARGET_ID]);
    }
  );

  it("does not preview a conflict resolution without the selected record", async () => {
    const target = targetFor("POST", `/api/memory/graph/facts/${TARGET_ID}/confirm`);
    const { scoped } = makeRecordingDb({
      rows: [factRow({ id: OTHER_FACT_ID, object_text: "Other fact" })]
    });
    expect(await target(scoped, { id: TARGET_ID })).toBeNull();
  });

  it("labels an object-entity memory from its stored name", async () => {
    const target = targetFor("DELETE", `/api/memory/graph/facts/${TARGET_ID}`);
    const { scoped } = makeRecordingDb({
      rows: [
        factRow({
          predicate: "works_on",
          object_text: null,
          object_entity_id: OTHER_SUBJECT_ID,
          object_name: "Reading project"
        })
      ]
    });
    expect(await target(scoped, { id: TARGET_ID })).toBe(`Alex: works_on: Reading project`);
  });

  it("distinguishes single-fact previews with identical predicates and objects", async () => {
    const target = targetFor("DELETE", `/api/memory/graph/facts/${TARGET_ID}`);
    const first = makeRecordingDb({ rows: [factRow()] });
    const second = makeRecordingDb({
      rows: [
        factRow({ id: OTHER_FACT_ID, subject_entity_id: OTHER_SUBJECT_ID, subject_name: "Blair" })
      ]
    });
    const firstLabel = await target(first.scoped, { id: TARGET_ID });
    const secondLabel = await target(second.scoped, { id: OTHER_FACT_ID });
    expect(firstLabel).toBe(`Alex: prefers: Early mornings`);
    expect(secondLabel).toBe(`Blair: prefers: Early mornings`);
    expect(firstLabel).not.toBe(secondLabel);
    expectScopedEntityJoins(first.queries[0]?.sql);
    expectScopedEntityJoins(second.queries[0]?.sql);
  });

  it.each(["confirm", "correct"])(
    "distinguishes equal predicate/object facts from different subjects in a %s preview",
    async (operation) => {
      const target = targetFor("POST", `/api/memory/graph/facts/${TARGET_ID}/${operation}`);
      const { scoped, queries } = makeRecordingDb({
        rows: [
          factRow(),
          factRow({ id: OTHER_FACT_ID, subject_entity_id: OTHER_SUBJECT_ID, subject_name: "Blair" })
        ]
      });
      expect(await target(scoped, { id: TARGET_ID })).toBe(
        `Selected memory: Alex: prefers: Early mornings; ` +
          `other affected memories: Blair: prefers: Early mornings`
      );
      expectScopedEntityJoins(queries[0]?.sql);
    }
  );

  it("keeps identical display text while binding distinct fact IDs privately", async () => {
    const target = buildRouteCatalog(manifests, []).resolve(
      "DELETE",
      `/api/memory/graph/facts/${TARGET_ID}`
    )!.route.policy.target!;
    const first = makeRecordingDb({ rows: [factRow()] });
    const second = makeRecordingDb({ rows: [factRow({ id: OTHER_FACT_ID })] });
    const firstTarget = await target(first.scoped, { id: TARGET_ID });
    const secondTarget = await target(second.scoped, { id: OTHER_FACT_ID });
    expect(firstTarget).toMatchObject({
      label: "Alex: prefers: Early mornings",
      version: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(secondTarget).toMatchObject({ label: "Alex: prefers: Early mornings" });
    expect(firstTarget).not.toEqual(secondTarget);
  });

  it.each([null, ""])("uses a stable subject fallback when its name is %s", async (subjectName) => {
    const target = targetFor("DELETE", `/api/memory/graph/facts/${TARGET_ID}`);
    const { scoped } = makeRecordingDb({ rows: [factRow({ subject_name: subjectName })] });
    expect(await target(scoped, { id: TARGET_ID })).toBe(`Saved subject: prefers: Early mornings`);
  });

  it.each([
    [{ manualRequest: true, excerpt: "Water the ferns on Sundays" }, "Water the ferns on Sundays"],
    [
      { kind: "fact", fact: { subject: "user", predicate: "prefers", objectText: "tea" } },
      "user prefers tea"
    ]
  ])("labels a pending suggestion with its full text (%#)", async (payload, label) => {
    const target = targetFor("POST", `/api/memory/candidates/${TARGET_ID}/accept`);
    const { scoped, queries } = makeRecordingDb({
      rows: [{ id: TARGET_ID, payload_json: payload }]
    });
    expect(await target(scoped, { id: TARGET_ID })).toBe(`${label}`);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("app.memory_candidates");
    expect(queries[0]?.sql).toContain("owner_user_id = app.current_actor_user_id()");
    expect(queries[0]?.sql).toContain("status = 'pending'");
    expect(queries[0]?.sql).not.toMatch(/insert|update|delete/i);
    expect(queries[0]?.parameters).toEqual([TARGET_ID]);
  });

  it("reads an entity name from the actor-scoped record", async () => {
    const target = targetFor("DELETE", `/api/memory/graph/entities/${TARGET_ID}`);
    const { scoped, queries } = makeRecordingDb({ rows: [{ name: "Reading project" }] });
    expect(await target(scoped, { id: TARGET_ID })).toBe("Reading project");
    expect(queries[0]?.sql).toContain("app.memory_entities");
    expect(queries[0]?.sql).toContain("app.current_actor_user_id()");
    expect(queries[0]?.parameters).toEqual([TARGET_ID]);
  });

  it("labels therapy notes with a timestamp without querying their contents", async () => {
    const target = targetFor("DELETE", `/api/wellness/therapy-notes/${TARGET_ID}`);
    const { scoped, queries } = makeRecordingDb({
      rows: [{ created_at: new Date("2026-10-01T14:30:00Z") }]
    });
    expect(await target(scoped, { id: TARGET_ID })).toBe(
      "Therapy note from 2026-10-01T14:30:00.000Z"
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('select "created_at"');
    expect(queries[0]?.sql).not.toMatch(/\bbody\b|\*/i);
    expect(queries[0]?.sql).toContain("app.current_actor_user_id()");
    expect(queries[0]?.parameters).toEqual([TARGET_ID]);
  });
});
