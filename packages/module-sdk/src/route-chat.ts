import type { RouteApprovalPresentation } from "./action-presentation.js";

/**
 * #3065: how Moss may call a built-in module's HTTP route from chat. Each route declares a
 * `chat` policy (or inherits the module's `chatDefaults`); the route catalog in
 * `@moss/module-registry` resolves and asserts them at boot. The catalog types live here so
 * chat can hold a catalog without importing the registry, which depends on chat.
 */

/**
 * Server-owned reasons Moss may never operate a surface. The seven tool-name families live in
 * `SELF_OPERATION_EXCLUSIONS` (`@moss/ai`). `module_promise` covers routes a module has promised
 * the assistant will not use; it has no tool family.
 */
export type SelfOperationExclusionCategory =
  | "self_authority"
  | "prompt_shaping"
  | "secrets"
  | "identity_auth_registration"
  | "data_scope_consent"
  | "assistant_brain"
  | "external_effect"
  | "module_promise";

export type RouteChatAccess = "read" | "write" | "destructive" | "blocked";

/** Whether a response carries only the user's own record, or may carry outside text. */
export type ChatContentClass = "user_authored" | "outside";

/**
 * Reads the label of a destructive route's target under the actor's data context.
 * A structured target also carries a server-only identity snapshot, never rendered on the card. `db` is a
 * DataContextDb typed `unknown`, the same convention as ToolExecute.
 */
export type RouteChatTargetResolver = (
  db: unknown,
  params: Readonly<Record<string, string>>
) => Promise<string | { readonly label: string; readonly version: string } | null>;

export interface RouteChatPolicy {
  readonly access: RouteChatAccess;
  /** Required when access is "blocked". */
  readonly blockedBecause?: SelfOperationExclusionCategory;
  /** Required unless access is "read" or "blocked". */
  readonly title?: string;
  /** Governs every response, not only reads. Default "outside". */
  readonly content?: ChatContentClass;
  /** Must equal the module's `aiConsent.key` when the module has one. */
  readonly consent?: string;
  /** Required for destructive routes with a path parameter. */
  readonly target?: RouteChatTargetResolver;
  /** Authored exhaustive human disclosure; no inferred labels or hidden submitted values. */
  readonly presentation?: RouteApprovalPresentation;
  /** Disclosure provenance is independent of response content; defaults to outside. */
  readonly presentationContent?: ChatContentClass;
  /** Explicitly mirrors an owning route preValidation that replaces a nullish body with {}. */
  readonly emptyBody?: "object";
  /** Name of a dedicated assistant tool that does the same job. */
  readonly coveredBy?: string;
  /** GET only: the route sends model-chosen input to a third party. */
  readonly outbound?: boolean;
}

/** A module-level AI consent switch. `db` is a DataContextDb typed `unknown`. */
export interface ModuleAiConsent {
  readonly key: string;
  isGranted(db: unknown, actorUserId: string): Promise<boolean>;
}

/** A route's Fastify schema as captured by the server's `onRoute` hook. */
export interface CapturedRouteSchema {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly querystring?: unknown;
  readonly params?: unknown;
}

export interface CatalogRouteInputShape {
  readonly body?: unknown;
  readonly querystring?: unknown;
  readonly params?: unknown;
}

export interface CatalogRoute {
  readonly moduleId: string;
  readonly method: string;
  readonly path: string;
  readonly policy: RouteChatPolicy & { readonly content: ChatContentClass };
  readonly inputShape: CatalogRouteInputShape | null;
}

export interface RouteCatalog {
  readonly routes: readonly CatalogRoute[];
  resolve(
    method: string,
    concretePath: string
  ): { route: CatalogRoute; params: Record<string, string> } | null;
  search(query: string, limit: number): readonly CatalogRoute[];
}

export interface RouteCatalogHolder {
  /** Null until the server's `onReady` fills it. */
  get(): RouteCatalog | null;
  /** Once; a second call throws. */
  set(catalog: RouteCatalog): void;
}

/**
 * Raw path characters the app may dispatch: RFC 3986 path characters only. Backslashes,
 * whitespace and control characters are refused because WHATWG URL parsing rewrites or strips
 * them, so the router would see a different path than the catalog authorized.
 */
const CANONICAL_PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/;

/**
 * Returns the path unchanged when the router will dispatch exactly what the catalog matched,
 * or null when parsing could rewrite it. Callers authorize and dispatch this same string.
 */
export function canonicalAppPath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || !CANONICAL_PATH_CHARS.test(path)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(path, "http://app.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://app.invalid" || parsed.search || parsed.hash) return null;
  return parsed.pathname === path ? path : null;
}
