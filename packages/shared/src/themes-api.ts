import { errorResponseSchema, idParamsSchema } from "./schema-fragments.js";

export const AESTHETIC_THEME_TOKEN_KEYS = [
  "paper",
  "surface",
  "surface2",
  "surface3",
  "ink",
  "ink2",
  "ink3",
  "ink4",
  "line",
  "lineSubtle",
  "lineStrong",
  "accent"
] as const;

/** Optional aesthetic tokens: absent = built-in constant applies. */
export const OPTIONAL_AESTHETIC_TOKEN_KEYS = ["gold"] as const;

export type AestheticThemeTokenKey = (typeof AESTHETIC_THEME_TOKEN_KEYS)[number];
export type AestheticThemeTokens = Record<AestheticThemeTokenKey, string> & {
  gold?: string;
};
export type BuiltInThemeId = "light" | "sage" | "canyon" | "teal" | "dusk" | "dark";
export type ColorMode = "light" | "dark";

export interface BuiltInThemeDto {
  readonly id: BuiltInThemeId;
  readonly name: string;
  readonly builtIn: true;
}

export interface CustomThemeDto {
  readonly id: string;
  readonly name: string;
  readonly builtIn: false;
  readonly tokens: AestheticThemeTokens;
}

export interface ListThemesResponse {
  readonly builtIn: readonly BuiltInThemeDto[];
  readonly custom: readonly CustomThemeDto[];
  readonly activeId: string;
  readonly mode: ColorMode;
}

export interface PutActiveThemeRequest {
  readonly id: string;
}

export interface PutColorModeRequest {
  readonly mode: ColorMode;
}

export interface PutCustomThemeRequest {
  readonly name?: string;
  readonly tokens?: Partial<AestheticThemeTokens>;
}

export interface PutCustomThemeResponse {
  readonly theme: CustomThemeDto;
}

export interface DeleteCustomThemeResponse {
  readonly deletedThemeId: string;
}

const colorValueSchema = {
  type: "string",
  pattern:
    "^(#[0-9a-fA-F]{6}|rgba?\\((25[0-5]|2[0-4]\\d|1?\\d?\\d),\\s*(25[0-5]|2[0-4]\\d|1?\\d?\\d),\\s*(25[0-5]|2[0-4]\\d|1?\\d?\\d)(,\\s*(0|1|0?\\.\\d+))?\\))$"
} as const;

const tokenProperties = Object.fromEntries(
  [...AESTHETIC_THEME_TOKEN_KEYS, ...OPTIONAL_AESTHETIC_TOKEN_KEYS].map((key) => [
    key,
    colorValueSchema
  ])
) as Record<
  AestheticThemeTokenKey | (typeof OPTIONAL_AESTHETIC_TOKEN_KEYS)[number],
  typeof colorValueSchema
>;

export const aestheticThemeTokensSchema = {
  type: "object",
  additionalProperties: false,
  required: [...AESTHETIC_THEME_TOKEN_KEYS],
  properties: tokenProperties
} as const;

const partialAestheticThemeTokensSchema = {
  type: "object",
  additionalProperties: false,
  properties: tokenProperties
} as const;

const builtInThemeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "builtIn"],
  properties: {
    id: { type: "string", enum: ["light", "sage", "canyon", "teal", "dusk", "dark"] },
    name: { type: "string" },
    builtIn: { type: "boolean", const: true }
  }
} as const;

const customThemeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "builtIn", "tokens"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    builtIn: { type: "boolean", const: false },
    tokens: aestheticThemeTokensSchema
  }
} as const;

export const listThemesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["builtIn", "custom", "activeId", "mode"],
      properties: {
        builtIn: { type: "array", items: builtInThemeSchema },
        custom: { type: "array", items: customThemeSchema },
        activeId: { type: "string" },
        mode: { type: "string", enum: ["light", "dark"] }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const putColorModeRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["mode"],
    properties: { mode: { type: "string", enum: ["light", "dark"] } }
  },
  response: listThemesRouteSchema.response
} as const;

export const putActiveThemeRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 80 }
    }
  },
  response: listThemesRouteSchema.response
} as const;

export const putCustomThemeRouteSchema = {
  params: idParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 80 },
      tokens: partialAestheticThemeTokensSchema
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["theme"],
      properties: { theme: customThemeSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const deleteCustomThemeRouteSchema = {
  params: idParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deletedThemeId"],
      properties: { deletedThemeId: { type: "string" } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
