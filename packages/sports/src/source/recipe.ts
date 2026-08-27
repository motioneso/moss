import { createHash } from "node:crypto";

import { Ajv } from "ajv";
import { compile, selectAll, selectOne } from "css-select";
import { DomUtils, Parser, parseDocument } from "htmlparser2";

import { publisherIdentity } from "./publisher-identity.js";

export const SPORTS_SOURCE_RECIPE_VERSION = 1 as const;

const MAX_HTML_NODES = 10_000;
const MAX_HTML_DEPTH = 128;

export type SportsRecipeNormalization = "trim" | "collapse_whitespace" | "strip_controls";

export interface SportsRecipeSlot {
  readonly name: string;
  readonly location: "path" | "query";
  readonly encoding: "path_segment" | "query_value";
  readonly maxLength: number;
}

interface SportsRecipeRequest {
  readonly urlTemplate: string;
  readonly slots: readonly SportsRecipeSlot[];
  readonly headers: {
    readonly accept: "application/json" | "text/html,application/xhtml+xml";
    readonly "accept-language"?: "en-US,en;q=0.5";
  };
}

export interface SportsJsonSourceRecipe {
  readonly version: 1;
  readonly kind: "json";
  readonly fetchHosts: readonly string[];
  readonly request: SportsRecipeRequest;
  readonly scopes: readonly ("sport" | "team" | "competition")[];
  readonly itemLimit: number;
  readonly extraction: {
    readonly itemsPath: readonly string[];
    readonly headlinePath: readonly string[];
    readonly urlPath?: readonly string[];
    readonly publishedAtPath?: readonly string[];
    readonly normalize: readonly SportsRecipeNormalization[];
  };
}

interface SportsHtmlRecipeField {
  readonly selector: string;
  readonly source: "text" | "attribute";
  readonly attribute?: "href" | "datetime" | "content";
}

export interface SportsHtmlSourceRecipe {
  readonly version: 1;
  readonly kind: "html";
  readonly fetchHosts: readonly string[];
  readonly request: SportsRecipeRequest;
  readonly scopes: readonly ("sport" | "team" | "competition")[];
  readonly itemLimit: number;
  readonly extraction: {
    readonly collectionSelector: string;
    readonly itemSelector: string;
    readonly headline: SportsHtmlRecipeField;
    readonly url?: SportsHtmlRecipeField;
    readonly publishedAt?: SportsHtmlRecipeField;
    readonly normalize: readonly SportsRecipeNormalization[];
  };
}

export type SportsSourceRecipe = SportsJsonSourceRecipe | SportsHtmlSourceRecipe;

export interface SportsRecipeItem {
  readonly headline: string;
  readonly url?: string;
  readonly publishedAt?: string;
}

const PATH_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }
} as const;

const SLOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "location", "encoding", "maxLength"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
    location: { type: "string", enum: ["path", "query"] },
    encoding: { type: "string", enum: ["path_segment", "query_value"] },
    maxLength: { type: "integer", minimum: 1, maximum: 128 }
  }
} as const;

const REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["urlTemplate", "slots", "headers"],
  properties: {
    urlTemplate: { type: "string", minLength: 1, maxLength: 4096 },
    slots: { type: "array", maxItems: 8, items: SLOT_SCHEMA },
    headers: {
      type: "object",
      additionalProperties: false,
      required: ["accept"],
      properties: {
        accept: {
          type: "string",
          enum: ["application/json", "text/html,application/xhtml+xml"]
        },
        "accept-language": { type: "string", enum: ["en-US,en;q=0.5"] }
      }
    }
  }
} as const;

const COMMON_PROPERTIES = {
  version: { const: SPORTS_SOURCE_RECIPE_VERSION },
  fetchHosts: {
    type: "array",
    minItems: 1,
    maxItems: 6,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 253,
      pattern: "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$"
    }
  },
  request: REQUEST_SCHEMA,
  scopes: {
    type: "array",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: { type: "string", enum: ["sport", "team", "competition"] }
  },
  itemLimit: { type: "integer", minimum: 1, maximum: 50 }
} as const;

const JSON_RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "fetchHosts", "request", "scopes", "itemLimit", "extraction"],
  properties: {
    ...COMMON_PROPERTIES,
    kind: { const: "json" },
    extraction: {
      type: "object",
      additionalProperties: false,
      required: ["itemsPath", "headlinePath", "normalize"],
      properties: {
        itemsPath: PATH_SCHEMA,
        headlinePath: PATH_SCHEMA,
        urlPath: PATH_SCHEMA,
        publishedAtPath: PATH_SCHEMA,
        normalize: {
          type: "array",
          maxItems: 4,
          items: {
            type: "string",
            enum: ["trim", "collapse_whitespace", "strip_controls"]
          }
        }
      }
    }
  }
} as const;

const HTML_FIELD_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["selector", "source"],
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 256 },
        source: { const: "text" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["selector", "source", "attribute"],
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 256 },
        source: { const: "attribute" },
        attribute: { type: "string", enum: ["href", "datetime", "content"] }
      }
    }
  ]
} as const;

const HTML_RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "fetchHosts", "request", "scopes", "itemLimit", "extraction"],
  properties: {
    ...COMMON_PROPERTIES,
    kind: { const: "html" },
    extraction: {
      type: "object",
      additionalProperties: false,
      required: ["collectionSelector", "itemSelector", "headline", "normalize"],
      properties: {
        collectionSelector: { type: "string", minLength: 1, maxLength: 256 },
        itemSelector: { type: "string", minLength: 1, maxLength: 256 },
        headline: HTML_FIELD_SCHEMA,
        url: HTML_FIELD_SCHEMA,
        publishedAt: HTML_FIELD_SCHEMA,
        normalize: {
          type: "array",
          maxItems: 4,
          items: {
            type: "string",
            enum: ["trim", "collapse_whitespace", "strip_controls"]
          }
        }
      }
    }
  }
} as const;

export const SPORTS_SOURCE_RECIPE_SCHEMA = {
  oneOf: [JSON_RECIPE_SCHEMA, HTML_RECIPE_SCHEMA]
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(
  SPORTS_SOURCE_RECIPE_SCHEMA
);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateRecipeSemantics(recipe: SportsSourceRecipe): boolean {
  const slotNames = new Set<string>();
  const placeholders = [...recipe.request.urlTemplate.matchAll(/\{([^{}]+)\}/g)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
  for (const slot of recipe.request.slots) {
    if (slotNames.has(slot.name)) return false;
    slotNames.add(slot.name);
    if (placeholders.filter((name) => name === slot.name).length !== 1) return false;
    const markerAt = recipe.request.urlTemplate.indexOf(`{${slot.name}}`);
    const queryAt = recipe.request.urlTemplate.indexOf("?");
    if ((slot.location === "path") !== (queryAt === -1 || markerAt < queryAt)) return false;
    if (
      (slot.location === "path" && slot.encoding !== "path_segment") ||
      (slot.location === "query" && slot.encoding !== "query_value")
    ) {
      return false;
    }
  }
  if (placeholders.length !== slotNames.size || placeholders.some((name) => !slotNames.has(name))) {
    return false;
  }
  try {
    const parsed = new URL(recipe.request.urlTemplate.replace(/\{[^{}]+\}/g, "slot"));
    const requestDomain = publisherIdentity(parsed.hostname);
    const validRequest =
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      !parsed.hash &&
      requestDomain !== null &&
      recipe.fetchHosts.includes(parsed.hostname.toLowerCase()) &&
      recipe.fetchHosts.every((host) => publisherIdentity(host) === requestDomain) &&
      recipe.request.headers.accept ===
        (recipe.kind === "json" ? "application/json" : "text/html,application/xhtml+xml");
    if (!validRequest) return false;
    if (recipe.kind === "html") {
      compile(recipe.extraction.collectionSelector);
      compile(recipe.extraction.itemSelector);
      compile(recipe.extraction.headline.selector);
      if (recipe.extraction.url) compile(recipe.extraction.url.selector);
      if (recipe.extraction.publishedAt) compile(recipe.extraction.publishedAt.selector);
    }
    return true;
  } catch {
    return false;
  }
}

export function validateSportsSourceRecipe(
  value: unknown
):
  | { readonly ok: true; readonly recipe: SportsSourceRecipe; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: "invalid_recipe" } {
  if (!validateSchema(value)) return { ok: false, reason: "invalid_recipe" };
  const recipe = value as SportsSourceRecipe;
  if (!validateRecipeSemantics(recipe)) return { ok: false, reason: "invalid_recipe" };
  return { ok: true, recipe, fingerprint: fingerprint(recipe) };
}

export function expandSportsSourceRecipe(
  recipe: SportsSourceRecipe,
  parameters: Readonly<Record<string, string>>
):
  | {
      readonly ok: true;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly identity: string;
    }
  | { readonly ok: false; readonly reason: "invalid_parameters" } {
  if (
    Object.keys(parameters).length !== recipe.request.slots.length ||
    recipe.request.slots.some((slot) => !(slot.name in parameters))
  ) {
    return { ok: false, reason: "invalid_parameters" };
  }
  let expanded = recipe.request.urlTemplate;
  for (const slot of recipe.request.slots) {
    const value = parameters[slot.name];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > slot.maxLength ||
      !/^[A-Za-z0-9._~ -]+$/.test(value)
    ) {
      return { ok: false, reason: "invalid_parameters" };
    }
    expanded = expanded.replace(`{${slot.name}}`, encodeURIComponent(value));
  }
  try {
    const url = new URL(expanded).toString();
    const headers = { ...recipe.request.headers };
    return {
      ok: true,
      url,
      headers,
      identity: `${fingerprint(recipe)}:${fingerprint({ headers, url })}`
    };
  } catch {
    return { ok: false, reason: "invalid_parameters" };
  }
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function normalizedText(
  value: unknown,
  operations: readonly SportsRecipeNormalization[],
  maxLength: number
): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value;
  for (const operation of operations) {
    if (operation === "trim") normalized = normalized.trim();
    if (operation === "collapse_whitespace") normalized = normalized.replace(/\s+/g, " ");
    if (operation === "strip_controls") {
      normalized = [...normalized]
        .filter((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code >= 32 && code !== 127;
        })
        .join("");
    }
  }
  return normalized.slice(0, maxLength) || undefined;
}

function safeOutputUrl(value: unknown, requestUrl: string): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value, requestUrl);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizedDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function htmlFieldValue(
  root: Parameters<typeof DomUtils.textContent>[0],
  field: SportsHtmlRecipeField
): string | undefined {
  const selected = selectOne(field.selector, root);
  if (!selected) return undefined;
  return field.source === "text"
    ? DomUtils.textContent(selected)
    : DomUtils.isTag(selected)
      ? DomUtils.getAttributeValue(selected, field.attribute ?? "")
      : undefined;
}

function hasBoundedHtmlStructure(body: string): boolean {
  let depth = 0;
  let nodes = 0;
  const count = (): void => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) throw new Error("html_node_limit");
  };
  try {
    const parser = new Parser({
      onopentag() {
        count();
        depth += 1;
        if (depth > MAX_HTML_DEPTH) throw new Error("html_depth_limit");
      },
      onclosetag() {
        depth = Math.max(0, depth - 1);
      },
      ontext: count,
      oncomment: count,
      onprocessinginstruction: count
    });
    parser.end(body);
    return true;
  } catch {
    return false;
  }
}

function extractHtmlRecipe(
  recipe: SportsHtmlSourceRecipe,
  response: {
    readonly body: string;
    readonly contentType: string | null;
    readonly requestUrl: string;
  }
):
  | { readonly ok: true; readonly items: readonly SportsRecipeItem[] }
  | { readonly ok: false; readonly reason: "recipe_drift" | "unsupported" } {
  if (!/(?:text\/html|application\/xhtml\+xml)/i.test(response.contentType ?? "")) {
    return { ok: false, reason: "unsupported" };
  }
  if (!hasBoundedHtmlStructure(response.body)) return { ok: false, reason: "unsupported" };
  const document = parseDocument(response.body, { decodeEntities: true });
  const collection = selectOne(recipe.extraction.collectionSelector, document);
  if (!collection) return { ok: false, reason: "recipe_drift" };
  const selectedItems = selectAll(recipe.extraction.itemSelector, collection).slice(
    0,
    recipe.itemLimit
  );
  const items: SportsRecipeItem[] = [];
  for (const item of selectedItems) {
    const headline = normalizedText(
      htmlFieldValue(item, recipe.extraction.headline),
      recipe.extraction.normalize,
      300
    );
    if (!headline) continue;
    const url = recipe.extraction.url
      ? safeOutputUrl(htmlFieldValue(item, recipe.extraction.url), response.requestUrl)
      : undefined;
    const publishedAt = recipe.extraction.publishedAt
      ? normalizedDate(htmlFieldValue(item, recipe.extraction.publishedAt))
      : undefined;
    items.push({
      headline,
      ...(url ? { url } : {}),
      ...(publishedAt ? { publishedAt } : {})
    });
  }
  return selectedItems.length > 0 && items.length === 0
    ? { ok: false, reason: "recipe_drift" }
    : { ok: true, items };
}

export function extractSportsSourceRecipe(
  recipe: SportsSourceRecipe,
  response: {
    readonly body: string;
    readonly contentType: string | null;
    readonly requestUrl: string;
  }
):
  | { readonly ok: true; readonly items: readonly SportsRecipeItem[] }
  | { readonly ok: false; readonly reason: "recipe_drift" | "unsupported" } {
  if (recipe.kind === "html") return extractHtmlRecipe(recipe, response);
  if (!/(?:application|text)\/json/i.test(response.contentType ?? "")) {
    return { ok: false, reason: "unsupported" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  const collection = valueAtPath(parsed, recipe.extraction.itemsPath);
  if (!Array.isArray(collection)) return { ok: false, reason: "recipe_drift" };
  const items: SportsRecipeItem[] = [];
  for (const item of collection.slice(0, recipe.itemLimit)) {
    const headline = normalizedText(
      valueAtPath(item, recipe.extraction.headlinePath),
      recipe.extraction.normalize,
      300
    );
    if (!headline) continue;
    const url = recipe.extraction.urlPath
      ? safeOutputUrl(valueAtPath(item, recipe.extraction.urlPath), response.requestUrl)
      : undefined;
    const publishedAt = recipe.extraction.publishedAtPath
      ? normalizedDate(valueAtPath(item, recipe.extraction.publishedAtPath))
      : undefined;
    items.push({
      headline,
      ...(url ? { url } : {}),
      ...(publishedAt ? { publishedAt } : {})
    });
  }
  return collection.length > 0 && items.length === 0
    ? { ok: false, reason: "recipe_drift" }
    : { ok: true, items };
}
