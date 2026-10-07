import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import { AiRepository } from "../../packages/ai/src/repository.js";
import { modelFavoritesPresentation } from "../../packages/ai/src/approval-presentation.js";
import {
  activeThemePresentation,
  deleteThemePresentation,
  localeRoutePresentation,
  modeRoutePresentation,
  notificationRoutePresentation,
  quietRoutePresentation,
  saveThemePresentation,
  weatherLocationPresentation,
  weatherSearchPresentation,
  weatherUnitPresentation
} from "../../packages/settings/src/action-presentations.js";
import { customThemeTarget } from "../../packages/settings/src/chat-targets.js";

const db = { [dataContextBrand]: true, db: {} };
const ctx = { actorUserId: "owner", chatSessionId: "session", requestId: "request" };
const call = (body: unknown) => ({ target: null, params: {}, body });
const tokens = {
  paper: "#112233",
  surface: "#112233",
  surface2: "#112233",
  surface3: "#112233",
  ink: "#112233",
  ink2: "#112233",
  ink3: "#112233",
  ink4: "#112233",
  line: "#112233",
  lineSubtle: "#112233",
  lineStrong: "#112233",
  accent: "#112233"
};
afterEach(() => vi.restoreAllMocks());

describe("Settings human disclosure", () => {
  it("shows the exact three metric rows and rejects every unknown field", async () => {
    expect(await weatherUnitPresentation(db, call({ unit: "metric" }), ctx)).toEqual({
      target: "Weather",
      fields: [
        { label: "Temperature", value: "Celsius" },
        { label: "Wind speed", value: "Kilometres per hour" },
        { label: "Rainfall", value: "Millimetres" }
      ]
    });
    for (const body of [
      { unit: "metric", secretId: "hidden" },
      { unit: "unknown" },
      {},
      ["metric"]
    ])
      expect(await weatherUnitPresentation(db, call(body), ctx)).toBeNull();
  });
  it("maps actual nested route envelopes without dropping values", async () => {
    const quietHours = { enabled: false, start: "22:00", end: "07:00", timezone: "Europe/London" };
    expect((await quietRoutePresentation(db, call({ quietHours }), ctx))?.fields).toHaveLength(4);
    expect(await quietRoutePresentation(db, call(quietHours), ctx)).toBeNull();
    expect(
      (
        await localeRoutePresentation(
          db,
          call({ locale: { timezone: "Europe/London", region: "en-GB", dateFormat: "24" } }),
          ctx
        )
      )?.fields
    ).toEqual([
      { label: "Time zone", value: "Europe/London" },
      { label: "Language and region", value: "en-GB" },
      { label: "Time format", value: "24-hour" }
    ]);
  });
  it("names the settings target without path or method rows", async () => {
    expect(await modeRoutePresentation(db, call({ mode: "dark" }), ctx)).toEqual({
      target: "Appearance",
      fields: [{ label: "Appearance", value: "Dark" }]
    });
    expect(
      await modeRoutePresentation(db, { ...call({ mode: "dark" }), query: { hidden: "yes" } }, ctx)
    ).toBeNull();
    expect(
      await modeRoutePresentation(db, { ...call({ mode: "dark" }), params: { id: "hidden" } }, ctx)
    ).toBeNull();
  });
  it("shows explicit location removal and exact query text", async () => {
    expect((await weatherLocationPresentation(db, call(null), ctx))?.fields).toEqual([
      { label: "Location", value: "Remove saved location" }
    ]);
    expect(
      (
        await weatherSearchPresentation(
          db,
          { target: null, params: {}, query: { query: "  Paris  " } },
          ctx
        )
      )?.fields
    ).toEqual([{ label: "Place to search", value: "  Paris  " }]);
    expect(
      await weatherSearchPresentation(db, { target: null, params: {}, query: { q: "Paris" } }, ctx)
    ).toBeNull();
  });
  it("resolves theme IDs to exact full names and binds full theme identity", async () => {
    const theme = { id: "opaque-theme", name: "Canyon\nafter rain", tokens };
    vi.spyOn(PreferencesRepository.prototype, "get").mockResolvedValue([theme]);
    expect((await activeThemePresentation(db, call({ id: theme.id }), ctx))?.fields).toEqual([
      { label: "Theme", value: theme.name }
    ]);
    const target = await customThemeTarget(db, { id: theme.id });
    expect(target).toMatchObject({ label: theme.name });
    const deletion = await deleteThemePresentation(
      db,
      { target: theme.name, params: { id: theme.id } },
      ctx
    );
    expect(deletion).toEqual({ target: theme.name, fields: [] });
    expect(JSON.stringify(deletion)).not.toContain(theme.id);
    expect(
      await deleteThemePresentation(
        db,
        { target: theme.name, params: { id: theme.id }, body: { extra: true } },
        ctx
      )
    ).toBeNull();
  });
  it("shows all saved colors and never hides unknown nested submitted keys", async () => {
    vi.spyOn(PreferencesRepository.prototype, "get").mockResolvedValue([]);
    const request = {
      target: null,
      params: { id: "new-theme" },
      body: { name: "New theme", tokens }
    };
    const result = await saveThemePresentation(db, request, ctx);
    expect(result?.fields).toHaveLength(13);
    expect(result?.target).toBe("New theme");
    expect(
      await saveThemePresentation(
        db,
        { ...request, body: { name: "New theme", tokens: { ...tokens, secret: "hidden" } } },
        ctx
      )
    ).toBeNull();
  });
  it("resolves notification module names only from host-provided active metadata", async () => {
    const request = {
      target: null,
      params: { moduleId: "module-id" },
      body: { enabled: true, clearUnread: false },
      modules: [{ id: "module-id", name: "Tasks", notificationsSupported: true }]
    };
    expect(await notificationRoutePresentation(db, request, ctx)).toEqual({
      target: "Tasks",
      fields: [
        { label: "Notifications enabled", value: "Yes" },
        { label: "Clear unread notifications", value: "No" }
      ],
      version: "module-id"
    });
    expect(await notificationRoutePresentation(db, { ...request, modules: [] }, ctx)).toBeNull();
  });
});

describe("AI model favorites disclosure", () => {
  it("resolves every model and provider, retaining opaque IDs only in the version", async () => {
    vi.spyOn(AiRepository.prototype, "listModels").mockResolvedValue([
      {
        id: "model-id",
        provider_config_id: "provider-id",
        display_name: "My model",
        provider_display_name: "My provider"
      }
    ] as never);
    const result = await modelFavoritesPresentation(db, call({ modelIds: ["model-id"] }), ctx);
    expect(result?.fields).toEqual([
      { label: "Favorite model 1", value: "My model (My provider)" }
    ]);
    expect(JSON.stringify(result?.fields)).not.toContain("model-id");
    expect(result?.version).toContain("model-id");
    expect(
      await modelFavoritesPresentation(db, call({ modelIds: ["unknown-id"] }), ctx)
    ).toBeNull();
  });
  it("makes clearing all favorites explicit and refuses unknown submitted fields", async () => {
    vi.spyOn(AiRepository.prototype, "listModels").mockResolvedValue([]);
    expect((await modelFavoritesPresentation(db, call({ modelIds: [] }), ctx))?.fields).toEqual([
      { label: "Favorite models", value: "None" }
    ]);
    expect(
      await modelFavoritesPresentation(db, call({ modelIds: [], hidden: true }), ctx)
    ).toBeNull();
  });
});
