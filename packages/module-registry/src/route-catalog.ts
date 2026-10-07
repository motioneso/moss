import {
  canonicalAppPath,
  type CapturedRouteSchema,
  type CatalogRoute,
  type CatalogRouteInputShape,
  type ChatContentClass,
  type ModuleRouteManifest,
  type MossModuleManifest,
  type RouteCatalog,
  type RouteCatalogHolder,
  type RouteChatPolicy,
  type SelfOperationExclusionCategory
} from "@moss/module-sdk";

import { routeKey } from "./route-guard.js";

export type {
  CapturedRouteSchema,
  CatalogRoute,
  RouteCatalog,
  RouteCatalogHolder
} from "@moss/module-sdk";

/**
 * #3065: the catalog of built-in module routes Moss may call from chat, and the boot assertion
 * that every route declares whether it may. External modules cannot declare routes, so the
 * catalog is built-in only. Platform-allowlisted routes have no manifest entry and never appear.
 */

import {
  CHAT_BLOCKED_PATH_RULES,
  DEFAULT_TABLES,
  type ChatBlockedPathRule,
  type JulyExcludedRoute,
  type RouteChatRuleTables
} from "./route-chat-rules.js";

export {
  CHAT_BLOCKED_PATH_RULES,
  DESTRUCTIVE_WORD_POST_ALLOWLIST,
  JULY_EXCLUDED_ROUTES,
  JULY_PREFIXES_WITHOUT_ROUTES,
  type ChatBlockedPathRule,
  type DestructiveWordPostAllowed,
  type JulyExcludedRoute,
  type JulyPrefixWithoutRoutes,
  type RouteChatRuleTables
} from "./route-chat-rules.js";

const DESTRUCTIVE_WORD = /clear|reset|purge|delete|remove/i;

function ruleMatches(rule: ChatBlockedPathRule, method: string, path: string): boolean {
  if (rule.writesOnly && method.toUpperCase() === "GET") return false;
  return rule.pattern.test(path);
}

export function matchChatBlockedPathRule(
  method: string,
  path: string,
  rules: readonly ChatBlockedPathRule[] = CHAT_BLOCKED_PATH_RULES
): ChatBlockedPathRule | undefined {
  return rules.find((rule) => ruleMatches(rule, method, path));
}

function findJulyRow(
  rows: readonly JulyExcludedRoute[],
  method: string,
  path: string
): JulyExcludedRoute | undefined {
  return rows.find((row) => row.method.toUpperCase() === method && row.path === path);
}

/** The route's own `chat` block over the module's `chatDefaults`, field by field. */
function declaredPolicy(
  manifest: MossModuleManifest,
  route: ModuleRouteManifest
): Partial<RouteChatPolicy> {
  return { ...manifest.chatDefaults, ...route.chat };
}

function inputShapeFor(
  route: ModuleRouteManifest,
  captured: CapturedRouteSchema | undefined
): CatalogRouteInputShape | null {
  if (captured) {
    const shape: { body?: unknown; querystring?: unknown; params?: unknown } = {};
    if (captured.body !== undefined) shape.body = captured.body;
    if (captured.querystring !== undefined) shape.querystring = captured.querystring;
    if (captured.params !== undefined) shape.params = captured.params;
    if (Object.keys(shape).length > 0) return shape;
  }
  if (route.requestSchema === undefined) return null;
  return route.method === "GET"
    ? { querystring: route.requestSchema }
    : { body: route.requestSchema };
}

function normalizeWord(word: string): string {
  // Keep singular/plural wording equivalent without applying broad stemming rules.
  if (word === "memories") return "memory";
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .map(normalizeWord);
}

function searchTokens(route: CatalogRoute): ReadonlySet<string> {
  const staticPath = route.path
    .split("/")
    .filter((segment) => !segment.startsWith(":"))
    .join("/");
  return new Set([
    ...words(route.policy.title ?? ""),
    ...words(staticPath),
    ...words(route.moduleId),
    ...words(route.method)
  ]);
}

const SCHEMA_WALK_DEPTH = 6;
const SCHEMA_COMBINERS = ["anyOf", "oneOf", "allOf"] as const;

function camelWords(text: string): string[] {
  return words(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

/** Field names and string enum or const values, so a user's value word finds its route. */
function collectSchemaTokens(schema: unknown, into: Set<string>, depth: number): void {
  if (depth > SCHEMA_WALK_DEPTH || schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const item of schema) collectSchemaTokens(item, into, depth + 1);
    return;
  }
  const node = schema as Record<string, unknown>;
  const values = [...(Array.isArray(node.enum) ? node.enum : []), node.const];
  for (const value of values) {
    if (typeof value === "string") camelWords(value).forEach((word) => into.add(word));
  }
  if (node.properties !== null && typeof node.properties === "object") {
    for (const [key, child] of Object.entries(node.properties)) {
      camelWords(key).forEach((word) => into.add(word));
      collectSchemaTokens(child, into, depth + 1);
    }
  }
  collectSchemaTokens(node.items, into, depth + 1);
  for (const combiner of SCHEMA_COMBINERS) collectSchemaTokens(node[combiner], into, depth + 1);
}

function inputShapeTokens(route: CatalogRoute): ReadonlySet<string> {
  const tokens = new Set<string>();
  const shape = route.inputShape;
  if (!shape) return tokens;
  for (const part of [shape.body, shape.querystring, shape.params]) {
    collectSchemaTokens(part, tokens, 0);
  }
  return tokens;
}

/** A title, path or module word counts double a word found only in the input shape. */
function searchScore(route: CatalogRoute, wanted: readonly string[]): number {
  const primary = searchTokens(route);
  const secondary = inputShapeTokens(route);
  return wanted.reduce(
    (score, word) => score + (primary.has(word) ? 2 : secondary.has(word) ? 1 : 0),
    0
  );
}

/** A decoded parameter must not carry a separator, a backslash or a control character. */
function hasPathSyntax(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "/" || char === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Splits a concrete path the way the router will see it, or null when it could route elsewhere. */
function concreteSegments(concretePath: string): string[] | null {
  if (canonicalAppPath(concretePath) === null) return null;
  const raw = concretePath.slice(1).split("/");
  const decoded: string[] = [];
  for (const segment of raw) {
    if (segment.length === 0) return null;
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (value === "." || value === ".." || hasPathSyntax(value)) return null;
    decoded.push(value);
  }
  return decoded;
}

interface IndexedRoute {
  readonly route: CatalogRoute;
  readonly segments: readonly string[];
}

/** Static segments outrank parameters, segment by segment, as Fastify's router does. */
function compareSpecificity(a: IndexedRoute, b: IndexedRoute): number {
  for (let i = 0; i < a.segments.length; i += 1) {
    const aParam = a.segments[i]!.startsWith(":");
    const bParam = b.segments[i]!.startsWith(":");
    if (aParam !== bParam) return aParam ? 1 : -1;
  }
  return 0;
}

export function buildRouteCatalog(
  manifests: readonly MossModuleManifest[],
  captured: readonly CapturedRouteSchema[],
  tables: RouteChatRuleTables = DEFAULT_TABLES
): RouteCatalog {
  const pathRules = tables.pathRules ?? CHAT_BLOCKED_PATH_RULES;
  const capturedByKey = new Map(
    captured.map((entry) => [routeKey(entry.method, entry.url), entry])
  );
  const routes: CatalogRoute[] = [];
  const pathRuleBlocked = new Set<CatalogRoute>();

  for (const manifest of manifests) {
    for (const route of manifest.routes ?? []) {
      const declared = declaredPolicy(manifest, route);
      const pathRule = matchChatBlockedPathRule(route.method, route.path, pathRules);
      const forcedCategory =
        pathRule?.category ??
        findJulyRow(tables.julyExcludedRoutes, route.method, route.path)?.category;
      if (forcedCategory === undefined && declared.access === undefined) continue;

      const content: ChatContentClass = declared.content ?? "outside";
      const policy =
        forcedCategory === undefined
          ? { ...declared, access: declared.access!, content }
          : { ...declared, access: "blocked" as const, blockedBecause: forcedCategory, content };
      const entry: CatalogRoute = {
        moduleId: manifest.id,
        method: route.method,
        path: route.path,
        policy,
        inputShape: inputShapeFor(route, capturedByKey.get(routeKey(route.method, route.path)))
      };
      routes.push(entry);
      if (pathRule) pathRuleBlocked.add(entry);
    }
  }

  const indexed: IndexedRoute[] = routes.map((route) => ({
    route,
    segments: route.path.slice(1).split("/")
  }));

  return {
    routes,
    resolve(method, concretePath) {
      const segments = concreteSegments(concretePath);
      if (!segments) return null;
      const upper = method.toUpperCase();
      const candidates = indexed
        .filter(
          (candidate) =>
            candidate.route.method === upper &&
            candidate.segments.length === segments.length &&
            candidate.segments.every(
              (segment, i) => segment.startsWith(":") || segment === segments[i]
            )
        )
        .sort(compareSpecificity);
      const best = candidates[0];
      if (!best) return null;
      const params: Record<string, string> = {};
      best.segments.forEach((segment, i) => {
        if (segment.startsWith(":")) params[segment.slice(1)] = segments[i]!;
      });
      return { route: best.route, params };
    },
    search(query, limit) {
      if (limit <= 0) return [];
      const queryWords = words(query);
      // Memory-review wording is a query synonym, not a schema-value synonym: task status
      // "suggested" must remain searchable without matching requests for memory suggestions.
      const wanted = [
        ...new Set(
          queryWords.includes("memory")
            ? queryWords.map((word) => (word === "suggested" ? "suggestion" : word))
            : queryWords
        )
      ];
      if (wanted.length === 0) return [];
      return routes
        .filter((route) => !pathRuleBlocked.has(route))
        .map((route, order) => ({ route, order, score: searchScore(route, wanted) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, limit)
        .map((hit) => hit.route);
    }
  };
}

function hasPathParam(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(":"));
}

export interface RouteChatAssertionOptions {
  readonly tables?: RouteChatRuleTables;
  /** Tool names `coveredBy` may name. Defaults to every tool in `manifests`. */
  readonly toolNames?: ReadonlySet<string>;
}

/**
 * Boot assertion (decisions 2.17, 2.22, 2.25): every built-in route declares how Moss may call
 * it, and the declaration is consistent with the path rules and the July tables. Throws one
 * error listing every violation, each naming its route.
 */
export function assertRouteChatClassification(
  manifests: readonly MossModuleManifest[],
  options: RouteChatAssertionOptions = {}
): void {
  const tables = options.tables ?? DEFAULT_TABLES;
  const pathRules = tables.pathRules ?? CHAT_BLOCKED_PATH_RULES;
  const toolNames =
    options.toolNames ??
    new Set(manifests.flatMap((m) => (m.assistantTools ?? []).map((tool) => tool.name)));
  const allowlisted = new Set(tables.destructiveWordPostAllowlist.map((entry) => entry.path));
  const errors: string[] = [];

  for (const manifest of manifests) {
    for (const route of manifest.routes ?? []) {
      const key = routeKey(route.method, route.path);
      const policy = declaredPolicy(manifest, route);
      const { access } = policy;
      if (access === undefined) {
        errors.push(`${key}: no chat access class; declare chat or chatDefaults`);
        continue;
      }

      if (route.method === "GET" && (access === "write" || access === "destructive")) {
        errors.push(`${key}: GET may not be classed ${access}`);
      }
      if (route.method === "DELETE" && (access === "read" || access === "write")) {
        errors.push(`${key}: DELETE may not be classed ${access}`);
      }
      if (access === "blocked" && policy.blockedBecause === undefined) {
        errors.push(`${key}: access blocked needs blockedBecause`);
      }
      if ((access === "write" || access === "destructive") && !policy.title) {
        errors.push(`${key}: access ${access} needs a title`);
      }

      const forced = [
        matchChatBlockedPathRule(route.method, route.path, pathRules),
        findJulyRow(tables.julyExcludedRoutes, route.method, route.path)
      ];
      for (const rule of forced) {
        if (!rule) continue;
        if (access !== "blocked" || policy.blockedBecause !== rule.category) {
          errors.push(
            `${key}: must be blocked with ${rule.category}, declared ${access}` +
              (policy.blockedBecause ? ` with ${policy.blockedBecause}` : "")
          );
        }
      }

      if (policy.outbound && !(route.method === "GET" && access === "read")) {
        errors.push(`${key}: outbound is allowed only on a GET classed read`);
      }
      if (
        route.method === "POST" &&
        DESTRUCTIVE_WORD.test(route.path) &&
        access !== "destructive" &&
        access !== "blocked" &&
        !allowlisted.has(route.path)
      ) {
        errors.push(
          `${key}: path names a destructive word; class it destructive or blocked, or allowlist it`
        );
      }
      if (manifest.aiConsent && policy.consent !== manifest.aiConsent.key) {
        errors.push(`${key}: module has AI consent; declare consent "${manifest.aiConsent.key}"`);
      }
      if (access === "destructive" && hasPathParam(route.path) && !policy.target) {
        errors.push(`${key}: destructive route with a path parameter needs a target resolver`);
      }
      if (policy.coveredBy !== undefined && !toolNames.has(policy.coveredBy)) {
        errors.push(`${key}: coveredBy "${policy.coveredBy}" names no built-in tool`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Route chat classification failed:\n${errors.join("\n")}`);
  }
}

/**
 * Decision 2.20: every built-in read tool says whether its result is the user's own record or
 * outside text. External tools are skipped; they always count as outside.
 */
export function assertReadToolContentDeclared(manifests: readonly MossModuleManifest[]): void {
  const errors: string[] = [];
  for (const manifest of manifests) {
    for (const tool of manifest.assistantTools ?? []) {
      if (tool.isExternal) continue;
      if (tool.risk === "read" && tool.content === undefined) {
        errors.push(`${tool.name}: read tool must declare content`);
      }
      if (tool.content === "user_authored" && tool.externalContent) {
        errors.push(`${tool.name}: content user_authored conflicts with externalContent`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Read tool content declaration failed:\n${errors.join("\n")}`);
  }
}

export interface JulyRuleForWalk {
  readonly category: SelfOperationExclusionCategory;
  readonly toolNamePrefixes: readonly string[];
}

/**
 * The July walk (decision 2.22), prefix by prefix. A prefix is mapped when a path rule or a
 * `JULY_EXCLUDED_ROUTES` row of the rule's category names it and blocks at least one catalog
 * route with that category, or when it is listed as having no routes. Returns the rest.
 */
export function findUnmappedJulyPrefixes(
  rules: readonly JulyRuleForWalk[],
  catalog: RouteCatalog,
  tables: RouteChatRuleTables = DEFAULT_TABLES
): string[] {
  const pathRules = tables.pathRules ?? CHAT_BLOCKED_PATH_RULES;
  const withoutRoutes = new Set(tables.julyPrefixesWithoutRoutes.map((entry) => entry.prefix));
  const unmapped: string[] = [];

  for (const rule of rules) {
    const blocked = catalog.routes.filter(
      (route) => route.policy.access === "blocked" && route.policy.blockedBecause === rule.category
    );
    for (const prefix of rule.toolNamePrefixes) {
      if (withoutRoutes.has(prefix)) continue;
      const viaPathRule = pathRules.some(
        (pathRule) =>
          pathRule.category === rule.category &&
          pathRule.julyPrefixes?.includes(prefix) &&
          blocked.some((route) => ruleMatches(pathRule, route.method, route.path))
      );
      const viaRow = tables.julyExcludedRoutes.some(
        (row) =>
          row.category === rule.category &&
          row.julyPrefixes.includes(prefix) &&
          blocked.some((route) => route.method === row.method && route.path === row.path)
      );
      if (!viaPathRule && !viaRow) unmapped.push(prefix);
    }
  }
  return unmapped;
}

export function createRouteCatalogHolder(): RouteCatalogHolder {
  let current: RouteCatalog | null = null;
  return {
    get: () => current,
    set(catalog) {
      if (current !== null) throw new Error("Route catalog is already set");
      current = catalog;
    }
  };
}
