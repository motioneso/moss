import { describe, expect, it, vi } from "vitest";
import { sanitizeAssistantToolResult } from "@moss/ai";
import {
  APP_MAP_SLICE_LOOKUP_KEYS,
  createAppMapReadService,
  appGetMapSliceExecute,
  appGetMapSliceInputSchema,
  appGetMapSliceOutputSchema
} from "@moss/settings";

const artifact = {
  schemaVersion: 1,
  build: { version: "1.2.3", buildId: "abc123" },
  screens: [
    {
      moduleId: "news",
      id: "news",
      label: "News",
      description: "News screen.",
      path: "/news",
      scope: "user"
    },
    {
      moduleId: "settings",
      id: "admin",
      label: "Admin",
      description: "Admin screen.",
      path: "/settings/admin",
      scope: "admin"
    },
    {
      moduleId: "hidden",
      id: "hidden",
      label: "Hidden",
      description: "Hidden screen.",
      path: "/hidden",
      scope: "user"
    },
    {
      moduleId: "news",
      id: "news-labs",
      label: "News Labs",
      description: "Unreleased News screen.",
      path: "/news/labs",
      scope: "user",
      featureFlagId: "news.labs"
    }
  ],
  settings: [],
  features: [],
  errors: [],
  remediations: [],
  narrative: { authoritative: false, markdown: "release prose" }
} as const;

describe("AppMapReadService", () => {
  it.each(["screen", "screen scope"])(
    "filters inactive, admin-only, and live flagged-OFF entries before slicing for %s",
    async (query) => {
      const resolveFeatureFlagState = vi.fn(
        (featureFlagId: string) => featureFlagId !== "news.labs"
      );
      const service = createAppMapReadService({
        artifact,
        resolveActiveModules: vi.fn().mockResolvedValue([{ id: "news" }, { id: "settings" }]),
        resolveFeatureFlagState,
        getUser: vi.fn().mockResolvedValue({ is_instance_admin: false }),
        logGap: vi.fn()
      });
      const result = await service.query({} as never, "user-1", { query, limit: 8 });
      expect(result.items.map((item) => item.id)).toEqual(["news"]);
      expect(result.items.map((item) => item.id)).not.toContain("news-labs");
      expect(resolveFeatureFlagState).toHaveBeenCalledWith("news.labs");
    }
  );

  it("returns at most eight schema-sanitized items", async () => {
    const service = createAppMapReadService({
      artifact: {
        ...artifact,
        screens: Array.from({ length: 12 }, (_, i) => ({
          moduleId: "news",
          id: `n${i}`,
          label: `N${i}`,
          description: "News screen.",
          path: `/n${i}`,
          scope: "user" as const
        }))
      },
      resolveActiveModules: vi.fn().mockResolvedValue([{ id: "news" }]),
      resolveFeatureFlagState: vi.fn().mockReturnValue(true),
      getUser: vi.fn().mockResolvedValue({ is_instance_admin: true }),
      logGap: vi.fn()
    });
    const slice = await service.query({} as never, "admin-1", { query: "news", limit: 99 });
    expect(slice.items).toHaveLength(8);
    const sanitized = sanitizeAssistantToolResult(appGetMapSliceOutputSchema, {
      data: { ...slice, secret: "drop" }
    });
    expect(sanitized.data).not.toHaveProperty("secret");
  });

  it("logs an undeclared query as a coverage gap", async () => {
    const logGap = vi.fn();
    const service = createAppMapReadService({
      artifact,
      resolveActiveModules: vi.fn().mockResolvedValue([{ id: "news" }]),
      resolveFeatureFlagState: vi.fn().mockReturnValue(true),
      getUser: vi.fn().mockResolvedValue({ is_instance_admin: false }),
      logGap
    });
    await service.query({} as never, "u1", { query: "quantum sandwich settings" });
    expect(logGap).toHaveBeenCalledWith({ kind: "query", value: "quantum sandwich settings" });
  });
});

// #1363: "supply at least one lookup key" used to be a top-level `anyOf` in the input schema. That
// is valid JSON Schema, but the Anthropic API rejects a top-level combinator and the CLI drops the
// whole tool — so the rule now lives here, in the execute handler, where a bad call fails
// recoverably instead of the tool vanishing from every chat.
describe("app.getMapSlice lookup-key requirement", () => {
  const ctx = { actorUserId: "u1", requestId: "r1" } as never;

  const runWith = (input: Record<string, unknown>, query = vi.fn().mockResolvedValue({})) =>
    appGetMapSliceExecute({} as never, input, ctx, { appMap: { query } } as never);

  it("stays out of the schema, which must never regain a top-level combinator", () => {
    const schema = appGetMapSliceInputSchema as Record<string, unknown>;
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("allOf");
  });

  it.each(APP_MAP_SLICE_LOOKUP_KEYS)("accepts a call carrying only %s", async (key) => {
    const query = vi.fn().mockResolvedValue({ kind: "slice", items: [] });
    await expect(runWith({ [key]: "something" }, query)).resolves.toEqual({
      data: { kind: "slice", items: [] }
    });
    expect(query).toHaveBeenCalledOnce();
  });

  // The message must name the keys: the model has to be able to retry, not conclude the tool is
  // broken and fall back to its priors — which is the exact failure #1363 caused in the first place.
  it.each([
    ["no keys at all", {}],
    ["only a limit", { limit: 3 }],
    ["a blank key", { query: "   " }],
    ["a non-string key", { screenId: 42 }]
  ])("rejects %s and names the keys it wanted", async (_label, input) => {
    const query = vi.fn();
    await expect(runWith(input, query)).rejects.toThrow(/screenId, settingId, errorCode, query/);
    expect(query).not.toHaveBeenCalled();
  });
});
