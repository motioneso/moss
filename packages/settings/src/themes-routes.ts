import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  AESTHETIC_THEME_TOKEN_KEYS,
  OPTIONAL_AESTHETIC_TOKEN_KEYS,
  deleteCustomThemeRouteSchema,
  listThemesRouteSchema,
  putColorModeRouteSchema,
  putActiveThemeRouteSchema,
  putCustomThemeRouteSchema,
  type AestheticThemeTokens,
  type BuiltInThemeDto,
  type CustomThemeDto,
  type PutActiveThemeRequest,
  type PutColorModeRequest,
  type PutCustomThemeRequest
} from "@moss/shared";

import type { ProfilePreferencesPort } from "./preferences-port.js";
import { handleSettingsRouteError } from "./route-error.js";

const CUSTOM_THEMES_KEY = "themes.custom";
const ACTIVE_THEME_KEY = "themes.active";
const COLOR_MODE_KEY = "themes.color-mode";
const BUILT_IN_THEMES: readonly BuiltInThemeDto[] = [
  // The "light" id keeps its value so stored active-theme preferences and
  // localStorage survive; only the display name changed for Park Press.
  { id: "light", name: "Forest", builtIn: true },
  { id: "sage", name: "Sage", builtIn: true },
  { id: "canyon", name: "Canyon", builtIn: true },
  { id: "teal", name: "Teal", builtIn: true },
  { id: "dusk", name: "Dusk", builtIn: true }
];
const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_THEMES.map((theme) => theme.id));
const THEME_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

interface ThemeRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: ProfilePreferencesPort;
}

export function registerThemeRoutes(
  server: FastifyInstance,
  dependencies: ThemeRoutesDependencies
): void {
  server.get("/api/me/themes", { schema: listThemesRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const custom = normalizeCustomThemes(
          await dependencies.preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
        );
        const storedActiveId = await dependencies.preferencesRepository.get(
          scopedDb,
          ACTIVE_THEME_KEY
        );
        const activeId = normalizeActiveThemeId(storedActiveId, custom);
        return {
          builtIn: BUILT_IN_THEMES,
          custom,
          activeId,
          mode: normalizeColorMode(
            await dependencies.preferencesRepository.get(scopedDb, COLOR_MODE_KEY),
            storedActiveId
          )
        };
      });
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });

  server.put(
    "/api/me/themes/active",
    { schema: putActiveThemeRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PutActiveThemeRequest;
        return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const custom = normalizeCustomThemes(
            await dependencies.preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
          );
          if (!isKnownThemeId(body.id, custom)) throw new HttpError(400, "Unknown theme");
          await dependencies.preferencesRepository.upsert(scopedDb, ACTIVE_THEME_KEY, body.id);
          return {
            builtIn: BUILT_IN_THEMES,
            custom,
            activeId: body.id,
            mode: normalizeColorMode(
              await dependencies.preferencesRepository.get(scopedDb, COLOR_MODE_KEY),
              body.id
            )
          };
        });
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put("/api/me/themes/mode", { schema: putColorModeRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = request.body as PutColorModeRequest;
      return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const custom = normalizeCustomThemes(
          await dependencies.preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
        );
        const activeId = normalizeActiveThemeId(
          await dependencies.preferencesRepository.get(scopedDb, ACTIVE_THEME_KEY),
          custom
        );
        await dependencies.preferencesRepository.upsert(scopedDb, COLOR_MODE_KEY, body.mode);
        return { builtIn: BUILT_IN_THEMES, custom, activeId, mode: body.mode };
      });
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });

  server.put(
    "/api/me/themes/:id",
    { schema: putCustomThemeRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const body = request.body as PutCustomThemeRequest;
        assertCustomThemeId(id);
        return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const custom = normalizeCustomThemes(
            await dependencies.preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
          );
          const existing = custom.find((theme) => theme.id === id);
          if (!existing && !hasCompleteTokens(body.tokens)) {
            throw new HttpError(400, "Theme tokens are required");
          }

          // A complete set replaces the saved colors, so an optional token it omits is cleared.
          // A partial set patches the saved colors.
          const base = hasCompleteTokens(body.tokens) ? {} : (existing?.tokens ?? {});
          const theme: CustomThemeDto = {
            id,
            name: sanitizeName(body.name ?? existing?.name ?? "Untitled theme"),
            builtIn: false,
            tokens: { ...base, ...pickAestheticTokens(body.tokens ?? {}) } as AestheticThemeTokens
          };
          const next = [...custom.filter((item) => item.id !== id), theme];
          await dependencies.preferencesRepository.upsert(scopedDb, CUSTOM_THEMES_KEY, next);
          return { theme };
        });
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/me/themes/:id",
    { schema: deleteCustomThemeRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        if (BUILT_IN_IDS.has(id)) throw new HttpError(400, "Built-in themes cannot be deleted");
        return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const custom = normalizeCustomThemes(
            await dependencies.preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
          );
          const activeId = normalizeActiveThemeId(
            await dependencies.preferencesRepository.get(scopedDb, ACTIVE_THEME_KEY),
            custom
          );
          if (activeId === id) throw new HttpError(400, "Active theme cannot be deleted");
          await dependencies.preferencesRepository.upsert(
            scopedDb,
            CUSTOM_THEMES_KEY,
            custom.filter((theme) => theme.id !== id)
          );
          return { deletedThemeId: id };
        });
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

function normalizeCustomThemes(value: unknown): readonly CustomThemeDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || BUILT_IN_IDS.has(record.id)) return [];
    if (typeof record.name !== "string") return [];
    if (!hasCompleteTokens(record.tokens)) return [];
    return [
      {
        id: record.id,
        name: sanitizeName(record.name),
        builtIn: false,
        // Themes saved before the highlight rename stored it as gold.
        tokens: pickAestheticTokens({
          highlight: (record.tokens as { gold?: unknown }).gold,
          ...record.tokens
        })
      }
    ];
  });
}

function normalizeActiveThemeId(value: unknown, custom: readonly CustomThemeDto[]): string {
  return typeof value === "string" && isKnownThemeId(value, custom)
    ? value === "dark"
      ? "light"
      : value
    : "light";
}

function normalizeColorMode(value: unknown, activeId: unknown): "light" | "dark" {
  if (activeId === "dark") return "dark";
  return value === "dark" ? "dark" : "light";
}

function isKnownThemeId(id: string, custom: readonly CustomThemeDto[]): boolean {
  return BUILT_IN_IDS.has(id) || custom.some((theme) => theme.id === id);
}

function assertCustomThemeId(id: string): void {
  if (BUILT_IN_IDS.has(id)) throw new HttpError(400, "Built-in themes are read-only");
  if (!THEME_ID_PATTERN.test(id)) throw new HttpError(400, "Theme id is invalid");
}

function hasCompleteTokens(value: unknown): value is AestheticThemeTokens {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return AESTHETIC_THEME_TOKEN_KEYS.every((key) => typeof record[key] === "string");
}

function pickAestheticTokens(value: unknown): AestheticThemeTokens {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    [...AESTHETIC_THEME_TOKEN_KEYS, ...OPTIONAL_AESTHETIC_TOKEN_KEYS].flatMap((key) =>
      typeof record[key] === "string" ? [[key, record[key]]] : []
    )
  ) as AestheticThemeTokens;
}

function sanitizeName(value: string): string {
  const name = value.trim().slice(0, 80);
  if (name.length === 0) throw new HttpError(400, "Theme name is required");
  return name;
}

/** The name of the actor's custom theme `id`, or null when there is none. */
export async function readCustomThemeName(
  preferencesRepository: ProfilePreferencesPort,
  scopedDb: DataContextDb,
  id: string
): Promise<string | null> {
  const custom = normalizeCustomThemes(
    await preferencesRepository.get(scopedDb, CUSTOM_THEMES_KEY)
  );
  return custom.find((theme) => theme.id === id)?.name ?? null;
}
