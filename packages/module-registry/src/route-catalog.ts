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

export interface ChatBlockedPathRule {
  /** Tested against the manifest route pattern, e.g. `/api/me/modules/:id`. */
  readonly pattern: RegExp;
  readonly category: SelfOperationExclusionCategory;
  /** True: GET on the path stays classifiable. */
  readonly writesOnly?: boolean;
  /** `SELF_OPERATION_EXCLUSIONS` prefixes this rule covers, for the July walk. */
  readonly julyPrefixes?: readonly string[];
}

export interface JulyExcludedRoute {
  readonly method: string;
  readonly path: string;
  readonly category: SelfOperationExclusionCategory;
  readonly julyPrefixes: readonly string[];
}

export interface JulyPrefixWithoutRoutes {
  /** A `toolNamePrefixes` entry in `SELF_OPERATION_EXCLUSIONS`. */
  readonly prefix: string;
  readonly reason: string;
}

export interface DestructiveWordPostAllowed {
  readonly path: string;
  readonly reason: string;
}

/**
 * Paths Moss may never call, whatever the manifest says. First match wins. The July families
 * (decision 2.22) match by pattern so a new route in a family is caught without a table row.
 */
export const CHAT_BLOCKED_PATH_RULES: readonly ChatBlockedPathRule[] = [
  {
    pattern: /^\/api\/admin(\/|$)/,
    category: "self_authority",
    julyPrefixes: [
      "settings.module.install.",
      "settings.module.remove.",
      "settings.module.purge.",
      "ai.adminPin."
    ]
  },
  { pattern: /^\/api\/auth(\/|$)/, category: "identity_auth_registration" },
  {
    pattern: /^\/api\/onboarding\/provider-(login|install)(\/|$)/,
    category: "secrets",
    julyPrefixes: ["settings.onboarding.login.", "settings.onboarding.install."]
  },
  { pattern: /^\/api\/onboarding(\/|$)/, category: "identity_auth_registration" },
  { pattern: /^\/api\/companion(\/|$)/, category: "identity_auth_registration" },
  { pattern: /^\/api\/mcp(\/|$)/, category: "self_authority" },
  { pattern: /^\/internal(\/|$)/, category: "self_authority" },
  { pattern: /^\/api\/ai\/assistant-tools\/[^/]+\/invoke$/, category: "self_authority" },
  {
    pattern: /^\/api\/(ai\/assistant-actions|chat\/action-requests)\/[^/]+\/resolve$/,
    category: "self_authority"
  },
  { pattern: /^\/api\/workflows\/approvals\/[^/]+\/resolve$/, category: "self_authority" },

  {
    pattern: /^\/api\/(settings\/me\/data-export|me\/export\/download\/[^/]+)$/,
    category: "data_scope_consent"
  },
  {
    pattern: /^\/api\/ai\/action-policy(\/|$)/,
    category: "self_authority",
    julyPrefixes: ["settings.actionPolicy.tier."]
  },
  {
    pattern: /^\/api\/ai\/chat-model-override$/,
    category: "self_authority",
    julyPrefixes: ["ai.chatModelOverride."]
  },
  {
    pattern: /^\/api\/ai\/(service-bindings|services\/[^/]+\/binding)$/,
    category: "self_authority",
    julyPrefixes: ["ai.serviceBinding."]
  },
  { pattern: /^\/api\/me\/yolo$/, category: "self_authority", julyPrefixes: ["settings.yolo."] },
  {
    pattern: /^\/api\/connectors\/accounts\/[^/]+\/feature-grants$/,
    category: "self_authority",
    julyPrefixes: ["settings.connector.featureGrant."]
  },
  {
    pattern: /^\/api\/ai\/providers\/[^/]+\/default$/,
    category: "self_authority",
    julyPrefixes: ["ai.defaultProvider."]
  },
  {
    pattern: /^\/api\/ai\/providers(\/[^/]+)?$/,
    category: "secrets",
    writesOnly: true,
    julyPrefixes: ["settings.provider.create.", "settings.provider.update."]
  },
  {
    pattern:
      /^\/api\/ai\/providers\/[^/]+\/(test|cli-check|discover-models|models\/discover|models\/refresh)$/,
    category: "external_effect",
    julyPrefixes: ["settings.providerTest.", "settings.providerDiscovery."]
  },
  {
    pattern: /^\/api\/ai\/providers(\/|$)/,
    category: "assistant_brain",
    julyPrefixes: ["ai.providerRevoke.", "ai.modelDisable."]
  },
  {
    pattern: /^\/api\/me\/persona(\/|$)/,
    category: "prompt_shaping",
    julyPrefixes: ["settings.persona.", "settings.assistantName."]
  },
  {
    pattern: /^\/api\/chat\/skills(\/|$)/,
    category: "prompt_shaping",
    julyPrefixes: ["settings.chatSkill.mutate.", "settings.chatSkill.import."]
  },
  {
    pattern: /^\/api\/me\/modules\/[^/]+$/,
    category: "self_authority",
    writesOnly: true,
    julyPrefixes: ["settings.module.enable."]
  },
  {
    pattern: /^\/api\/tasks\/agency-auto-execute$/,
    category: "self_authority",
    writesOnly: true,
    julyPrefixes: ["settings.taskAgency.autoExecution."]
  },
  {
    pattern: /^\/api\/chat\/memory\/settings$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.memorySettings."]
  },
  {
    pattern: /^\/api\/chat\/page-context$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.pageContext.write."]
  },
  {
    pattern: /^\/api\/me\/source-behaviors(\/|$)/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.sourceBehavior."]
  },
  {
    pattern: /^\/api\/me\/priority-model$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.priorityRanking."]
  },
  {
    pattern: /^\/api\/me\/notes-source(\/|$)/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.notesSourceSelection."]
  },
  {
    pattern: /^\/api\/ai\/voice-endpoint$/,
    category: "secrets",
    julyPrefixes: ["settings.voiceEndpoint."]
  },
  {
    pattern: /^\/api\/ai\/terminal\/(password|ticket)$/,
    category: "secrets",
    julyPrefixes: ["settings.terminal.password.", "settings.terminal.ticket."]
  },
  {
    pattern: /^\/api\/news\/(credentials|sources\/credentialed|sources\/[^/]+\/credential)$/,
    category: "secrets"
  },
  {
    pattern: /^\/api\/wellness\/ai-consent$/,
    category: "data_scope_consent",
    writesOnly: true,
    julyPrefixes: ["settings.wellnessAiConsent."]
  }
];

/** Routes doing what an excluded tool family does that no path rule covers. Slices 3 and 4. */
export const JULY_EXCLUDED_ROUTES: readonly JulyExcludedRoute[] = [
  // The original UI actions can remove calendar follow-through, dismiss cards, create memory
  // candidates or enqueue feed refreshes. The separate /signals route records only safe pairs.
  {
    method: "POST",
    path: "/api/me/usefulness-feedback",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "PATCH",
    path: "/api/me/usefulness-feedback/:id",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/me/usefulness-feedback/:id/undo",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/connectors/google/authorize",
    category: "secrets",
    julyPrefixes: ["settings.connector.authorize."]
  },
  {
    method: "POST",
    path: "/api/connectors/google/complete",
    category: "secrets",
    julyPrefixes: ["settings.connector.complete."]
  },
  {
    method: "POST",
    path: "/api/connectors/imap/connect",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/connectors/imap/test-connection",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/connectors/accounts",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "PATCH",
    path: "/api/connectors/accounts/:id",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/integrations",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "PATCH",
    path: "/api/integrations/:id",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "DELETE",
    path: "/api/me/account",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.account.lifecycle."]
  },
  {
    method: "DELETE",
    path: "/api/me/sessions/others",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.session.revoke."]
  },
  {
    method: "DELETE",
    path: "/api/me/sessions/:id",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.session.revoke."]
  },
  {
    method: "PUT",
    path: "/api/integrations/:id/classifier/send-without-asking",
    category: "self_authority",
    julyPrefixes: ["settings.permissions."]
  },
  {
    method: "POST",
    path: "/api/ai/module-builds/:buildId/approve",
    category: "self_authority",
    julyPrefixes: ["settings.module.install."]
  },
  {
    method: "POST",
    path: "/api/ai/models",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "PATCH",
    path: "/api/ai/models/:id",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "DELETE",
    path: "/api/ai/models/:id",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "POST",
    path: "/api/connectors/google/sync",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/connectors/email-refresh",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/integrations/:id/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/connectors/accounts/:id/revoke",
    category: "external_effect",
    julyPrefixes: ["settings.connectorRevoke."]
  },
  {
    method: "DELETE",
    path: "/api/integrations/:id",
    category: "external_effect",
    julyPrefixes: ["settings.connectorRevoke."]
  },
  {
    method: "PUT",
    path: "/api/me/notification-digest-preference",
    category: "external_effect",
    julyPrefixes: ["settings.digest."]
  },
  {
    method: "PATCH",
    path: "/api/me/proactive-monitoring-settings",
    category: "external_effect",
    julyPrefixes: ["settings.proactive."]
  },
  {
    method: "POST",
    path: "/api/me/proactive-cards/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.proactive."]
  },
  {
    method: "POST",
    path: "/api/me/export",
    category: "external_effect",
    julyPrefixes: ["settings.export."]
  },
  {
    method: "POST",
    path: "/api/ai/transcriptions",
    category: "external_effect",
    julyPrefixes: ["settings.transcription."]
  },
  {
    method: "POST",
    path: "/api/workflows/runs/:id/cancel",
    category: "external_effect",
    julyPrefixes: ["settings.cancelledWork."]
  },
  {
    method: "POST",
    path: "/api/ai/module-builds/:buildId/cancel",
    category: "external_effect",
    julyPrefixes: ["settings.cancelledWork."]
  }
];

/** July prefixes with no route to block, each with its reason. Slices 3 and 4. */
export const JULY_PREFIXES_WITHOUT_ROUTES: readonly JulyPrefixWithoutRoutes[] = [
  {
    prefix: "settings.secretRegistry.",
    reason:
      "Its only route, PATCH /api/admin/settings/:key, is blocked by the admin path rule as self_authority."
  },
  { prefix: "settings.webSearchKey.", reason: "Platform route; never in the catalog." },
  {
    prefix: "settings.admin.promote.",
    reason: "Platform admin user routes; never in the catalog."
  },
  {
    prefix: "settings.registration.flag.",
    reason: "Platform admin registration route; never in the catalog."
  },
  {
    prefix: "settings.onboarding.state.",
    reason: "Onboarding status, complete and skip are platform routes; never in the catalog."
  },
  {
    prefix: "settings.moduleQueueRun.",
    reason: "Platform module queue route; never in the catalog."
  },
  {
    prefix: "settings.hostInstall.",
    reason: "Platform host install and restart routes; never in the catalog."
  },
  { prefix: "ai.multiplexer.", reason: "Platform chat-multiplexer route; never in the catalog." },
  { prefix: "settings.promptDataWidening.", reason: "No prompt data widening flag exists yet." },
  {
    prefix: "ai.embedProvider.",
    reason: "An admin setting, blocked by the admin path rule as self_authority."
  },
  {
    prefix: "ai.chatModelOverride.",
    reason:
      "Listed under both self_authority and assistant_brain; its routes are blocked as self_authority by the chat-model-override path rule, which a named-route test pins."
  }
];

/** POST paths naming a destructive word that are not destructive, each with its reason. */
export const DESTRUCTIVE_WORD_POST_ALLOWLIST: readonly DestructiveWordPostAllowed[] = [];

export interface RouteChatRuleTables {
  readonly pathRules?: readonly ChatBlockedPathRule[];
  readonly julyExcludedRoutes: readonly JulyExcludedRoute[];
  readonly julyPrefixesWithoutRoutes: readonly JulyPrefixWithoutRoutes[];
  readonly destructiveWordPostAllowlist: readonly DestructiveWordPostAllowed[];
}

const DEFAULT_TABLES: RouteChatRuleTables = {
  pathRules: CHAT_BLOCKED_PATH_RULES,
  julyExcludedRoutes: JULY_EXCLUDED_ROUTES,
  julyPrefixesWithoutRoutes: JULY_PREFIXES_WITHOUT_ROUTES,
  destructiveWordPostAllowlist: DESTRUCTIVE_WORD_POST_ALLOWLIST
};

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
      const wanted = [...new Set(words(query))];
      if (wanted.length === 0) return [];
      return routes
        .filter((route) => !pathRuleBlocked.has(route))
        .map((route, order) => {
          const tokens = searchTokens(route);
          return { route, order, score: wanted.filter((word) => tokens.has(word)).length };
        })
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
