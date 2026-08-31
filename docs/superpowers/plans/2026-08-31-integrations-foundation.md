# Integrations Foundation (MCP + OpenAPI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can connect Moss to any MCP server or OpenAPI-specced service from Settings, see everything it exposes, and use its tools from chat — with zero Moss code changes for integration #2..#N.

**Architecture:** New built-in module `packages/integrations` with an owner-only RLS table of connections (credential AES-256-GCM encrypted), an MCP client (official SDK) and an OpenAPI→tools adapter, and a per-user resolver wrapper that injects each enabled connection's curated tools into the chat gateway's `resolveActiveModules` output as synthetic module manifests. UI is a new Integrations pane inside Settings (list / add / detail drill-in).

**Tech Stack:** TypeScript, Fastify, postgres.js + RLS, `@modelcontextprotocol/sdk`, vitest, React + TanStack Query, authored `jds-*`/pane design system.

**Spec:** `docs/superpowers/specs/2026-08-31-integrations-mcp-client-foundation.md` (issue #2162)

## Global Constraints

- **Plain English to humans.** Chat, status updates, handoffs, and every spawn prompt you write carry the no-jargon rule (box-wide CLAUDE.md). Commit messages and code stay technical.
- **Shared checkout.** Do branch work in a temp worktree (`superpowers:using-git-worktrees`). Never `git add -A`/`.` or bare `git commit`; commit explicit paths (shared-checkout skill).
- **Secrets never escape** (hard invariant): the credential never appears in API responses, logs, job payloads, exports, or AI prompts. Frontend only ever sees `hasCredential: boolean`.
- **New required env vars ship with their configs**: `JARVIS_INTEGRATIONS_SECRET_KEY` / `_SECRET_KEY_ID` / `_SECRET_KEYS` added to dev AND prod compose in this same PR ("a PR must never break prod").
- **Never edit an applied migration.** New SQL file in `packages/integrations/sql/`, 4-digit version globally unique across every module `sql/` dir and `infra/postgres/migrations/`.
- **Every route in the manifest.** `assertRouteCoverage` fails boot on any endpoint not declared in the module manifest `routes[]` (and vice versa).
- **Tool schema trap (#1363):** a tool whose input schema has a top-level `anyOf`/`oneOf`/`allOf`/`not` is silently dropped by the CLI. The proxy must log-and-skip such tools; the OpenAPI converter always emits `{ type: "object", ... }` roots.
- **Numbers fixed by spec:** live threshold **30 tools**; discovery timeout **15s**; tool-call timeout **30s**; response body cap **64,000 chars**.
- **UI:** authored primitives only (`design-system` skill). No accent left-border on active/selected items. Copy stays tight: field titles, no explainer hints, no service-name examples, one-line notes only where load-bearing. Run the invented-class audit before the PR.
- **Testing:** unit tests in `tests/unit/`, integration in `tests/integration/`. Any DB-touching test command ONLY via the `verify-gate` skill. Known: `module-sdk-worker` tests fail locally but are green in CI — never bisect over it.
- **Provider-agnostic AI, module isolation, AccessContext = {actorUserId, requestId}** — all per CLAUDE.md hard invariants.
- **PR:** fill the Release note section (Category: Added; plain-English description). Live-path gate needs BOTH proofs recorded on the PR: Home Assistant over MCP and Radarr/Sonarr over OpenAPI, exercised on the live dev instance.
- Merge with `gh pr merge --squash --auto` (never `--admin`).

---

### Task 1: Package skeleton, shared contracts, curation logic

**Files:**
- Create: `packages/shared/src/integrations-api.ts`
- Modify: `packages/shared/src/index.ts` (barrel export)
- Create: `packages/integrations/package.json`, `packages/integrations/src/index.ts`, `packages/integrations/src/curation.ts`
- Modify: `vitest.config.ts` (resolve.alias), root `tsconfig.json` (paths)
- Test: `tests/unit/integrations-curation.test.ts`

**Interfaces:**
- Produces: all DTO types below, `INTEGRATION_LIVE_TOOL_THRESHOLD = 30`, `effectiveEnabledTools(tools, state)`, `isGroupOptIn(toolCount)`. Every later task imports these from `@moss/shared` / `@moss/integrations`.

- [ ] **Step 1: Write the shared contracts** in `packages/shared/src/integrations-api.ts` (types are the contract both API and web import — follow the `notes-api.ts` house pattern of readonly interfaces):

```ts
export type IntegrationKind = "mcp" | "openapi";
export type CredentialPlacementKind = "bearer" | "header" | "query";

export interface CredentialPlacement {
  readonly kind: CredentialPlacementKind;
  /** Header or query parameter name; required for kind "header" | "query". */
  readonly name?: string;
}

export interface IntegrationToolDescriptor {
  readonly name: string; // remote tool name / sanitized operationId (no connection prefix)
  readonly description: string;
  readonly group: string; // OpenAPI tag; "" for MCP/ungrouped
  readonly inputSchema: Record<string, unknown> | null;
}

export interface IntegrationSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: IntegrationKind;
  readonly url: string;
  readonly enabled: boolean;
  readonly hasCredential: boolean;
  readonly toolCount: number;
  readonly enabledToolCount: number;
  readonly lastDiscoveryAt: string | null;
  readonly lastError: string | null;
}

export interface IntegrationGroupSummary {
  readonly name: string;
  readonly toolCount: number;
  readonly enabled: boolean;
}

export interface IntegrationDetail extends IntegrationSummary {
  readonly credentialPlacement: CredentialPlacement | null;
  readonly tools: readonly IntegrationToolDescriptor[];
  readonly groups: readonly IntegrationGroupSummary[];
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
  /** True when toolCount > threshold: groups start off, user opts in per group. */
  readonly groupOptIn: boolean;
}

export interface CreateIntegrationRequest {
  readonly name: string;
  readonly kind: IntegrationKind;
  /** MCP: the server URL. OpenAPI: the spec URL — unless `spec` is pasted, then the service base URL. */
  readonly url: string;
  /** OpenAPI only: paste the spec document (JSON text) instead of fetching it from `url`. */
  readonly spec?: string;
  readonly credential?: string;
  readonly credentialPlacement?: CredentialPlacement;
}

export interface UpdateIntegrationRequest {
  readonly name?: string;
  readonly url?: string;
  readonly enabled?: boolean;
  readonly credential?: string | null; // null clears
  readonly credentialPlacement?: CredentialPlacement | null;
  readonly enabledGroups?: readonly string[];
  readonly enabledTools?: readonly string[];
  readonly mutedTools?: readonly string[];
}

export interface ListIntegrationsResponse {
  readonly integrations: readonly IntegrationSummary[];
}

export const INTEGRATION_LIVE_TOOL_THRESHOLD = 30;
```

Export from `packages/shared/src/index.ts` alongside the other `*-api.ts` barrels.

- [ ] **Step 2: Create the package skeleton.** `packages/integrations/package.json` copies the shape of `packages/goals/package.json` exactly (no build step, `"exports": { ".": "./src/index.ts" }`, same typecheck script), name `@moss/integrations`, deps: `@moss/shared`, `@moss/db`, `@moss/module-sdk`. Add alias `"@moss/integrations": resolve(rootDir, "packages/integrations/src/index.ts")` to `vitest.config.ts` and the matching entry to root `tsconfig.json` `paths` (mirror the `@moss/goals` lines in both). `src/index.ts` re-exports `./curation.ts` for now.

- [ ] **Step 3: Write the failing curation test** `tests/unit/integrations-curation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { effectiveEnabledTools, isGroupOptIn } from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";

const tool = (name: string, group = ""): IntegrationToolDescriptor => ({
  name, description: name, group, inputSchema: null
});

describe("integration tool curation", () => {
  it("small sets are live minus mutes", () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const out = effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: [], mutedTools: ["b"] });
    expect(out.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("over the threshold nothing is enabled until a group is flipped", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, i < 5 ? "Queue" : "Series"));
    expect(isGroupOptIn(tools.length)).toBe(true);
    expect(effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: [], mutedTools: [] })).toEqual([]);
    const queueOn = effectiveEnabledTools(tools, { enabledGroups: ["Queue"], enabledTools: [], mutedTools: [] });
    expect(queueOn).toHaveLength(5);
  });

  it("per-tool override enables a tool inside a disabled group, mute wins over both", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, "Series"));
    const out = effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: ["t3", "t4"], mutedTools: ["t4"] });
    expect(out.map((t) => t.name)).toEqual(["t3"]);
  });

  it("exactly at the threshold stays live", () => {
    expect(isGroupOptIn(30)).toBe(false);
  });
});
```

- [ ] **Step 4: Run it, confirm it fails** (module not found / functions undefined): `pnpm vitest run tests/unit/integrations-curation.test.ts`

- [ ] **Step 5: Implement** `packages/integrations/src/curation.ts`:

```ts
import { INTEGRATION_LIVE_TOOL_THRESHOLD } from "@moss/shared";
import type { IntegrationToolDescriptor } from "@moss/shared";

export interface CurationState {
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
}

export function isGroupOptIn(toolCount: number): boolean {
  return toolCount > INTEGRATION_LIVE_TOOL_THRESHOLD;
}

export function effectiveEnabledTools(
  tools: readonly IntegrationToolDescriptor[],
  state: CurationState
): IntegrationToolDescriptor[] {
  const muted = new Set(state.mutedTools);
  if (!isGroupOptIn(tools.length)) {
    return tools.filter((t) => !muted.has(t.name));
  }
  const groups = new Set(state.enabledGroups);
  const explicit = new Set(state.enabledTools);
  return tools.filter((t) => (groups.has(t.group) || explicit.has(t.name)) && !muted.has(t.name));
}
```

- [ ] **Step 6: Run test green, then `pnpm check:package-deps` and typecheck; commit** the listed files with message `feat(integrations): package skeleton, shared contracts, tool curation (#2162)`.

---

### Task 2: Module manifest, SQL migration, built-in registration

**Files:**
- Create: `packages/integrations/sql/NNNN_integration_connections.sql` (number: run `ls packages/*/sql/*.sql infra/postgres/migrations/*.sql | grep -oE '[0-9]{4}' | sort -n | tail -1` and use max+1)
- Create: `packages/integrations/src/manifest.ts`
- Modify: `packages/module-registry/src/index.ts` (BUILT_IN_MODULES entry), `packages/module-registry/package.json` (add `@moss/integrations` dep)
- Modify: `tests/integration/test-database.ts` (`expectedBuiltInModuleIds` — add `"integrations"`)
- Test: existing boot/registration integration tests (they pin the module id list)

**Interfaces:**
- Produces: module id `"integrations"`; table `app.integration_connections`; `integrationsModule: BuiltInModuleRegistration` (routes registered in Task 7).

- [ ] **Step 1: Write the migration.** Copy the RLS/GRANT shape from `packages/goals/sql/0123_*.sql` verbatim (same roles, same FORCE pattern; confirm the FK target used there for the owner column and mirror it), with this table:

```sql
CREATE TABLE app.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mcp', 'openapi')),
  transport text NOT NULL DEFAULT 'http' CHECK (transport IN ('http')),
  url text NOT NULL,
  credential jsonb,
  credential_placement jsonb,
  enabled boolean NOT NULL DEFAULT true,
  base_url text,
  spec_pasted boolean NOT NULL DEFAULT false,
  enabled_groups text[] NOT NULL DEFAULT '{}',
  enabled_tools text[] NOT NULL DEFAULT '{}',
  muted_tools text[] NOT NULL DEFAULT '{}',
  discovered_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_discovery_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

ALTER TABLE app.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_connections_owner ON app.integration_connections
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY integration_connections_worker_read ON app.integration_connections
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.integration_connections TO jarvis_app_runtime;
GRANT SELECT ON app.integration_connections TO jarvis_worker_runtime;
```

- [ ] **Step 2: Write `packages/integrations/src/manifest.ts`.** Model it field-for-field on `packages/goals/src/manifest.ts`: id `"integrations"`, human name `"Integrations"`, `sqlMigrationDirectories: [fileURLToPath(new URL("../sql", import.meta.url))]`, empty `routes: []` for now (Task 7 fills it), no queues/workers, `dataLifecycle.deletion.tables: ["integration_connections"]`, no `assistantTools` (chat tools are dynamic — Task 8). Export a `BuiltInModuleRegistration` object (`{ manifest, sqlMigrationDirectories, queueDefinitions: [], registerRoutes }` — match the exact registration type in `packages/module-registry/src/index.ts:676-689`).

- [ ] **Step 3: Register it.** Add the entry to `BUILT_IN_MODULES` in `packages/module-registry/src/index.ts` (alongside the goals entry at ~:1488), add `@moss/integrations` to `packages/module-registry/package.json`, and add `"integrations"` to `expectedBuiltInModuleIds` in `tests/integration/test-database.ts:62`.

- [ ] **Step 4: Verify via gate.** Use the `verify-gate` skill to run the foundation gate (migration applies, module-id pin test green, boot assertions pass).

- [ ] **Step 5: Commit** explicit paths, message `feat(integrations): integrations module with owner-only connections table (#2162)`.

---

### Task 3: Credential cipher wiring and placement rendering

**Files:**
- Create: `packages/integrations/src/credentials.ts`
- Modify: `apps/api/src/server.ts` (build cipher — see the connectors cipher construction for the exact call site), dev compose env file(s) and prod compose env file(s) that carry the connectors secret triple (add the integrations triple next to it)
- Test: `tests/unit/integrations-credentials.test.ts`

**Interfaces:**
- Consumes: `JsonSecretCipher`, `resolveKeyring` from `@moss/db` (`packages/db/src/secret-cipher.ts:63`, `keyring.ts:22`).
- Produces: `createIntegrationsCipher(env)`, `applyCredential(placement, secret, url, headers)`. Tasks 5-8 use `applyCredential`; Task 7 uses the cipher in routes.

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, expect, it } from "vitest";
import { applyCredential, createIntegrationsCipher } from "@moss/integrations";

describe("integration credentials", () => {
  it("encrypts and decrypts round-trip with the dev keyring", () => {
    const cipher = createIntegrationsCipher({});
    const envelope = cipher.encryptJson({ secret: "tok-123" });
    expect(JSON.stringify(envelope)).not.toContain("tok-123");
    expect(cipher.decryptJson(cipher.parseEnvelope(JSON.stringify(envelope)))).toEqual({ secret: "tok-123" });
  });

  it("renders bearer, named header, and query placements", () => {
    const cases = [
      { placement: { kind: "bearer" as const }, header: ["authorization", "Bearer tok"] },
      { placement: { kind: "header" as const, name: "X-Api-Key" }, header: ["x-api-key", "tok"] }
    ];
    for (const c of cases) {
      const url = new URL("https://svc.local/api");
      const headers = new Headers();
      applyCredential(c.placement, "tok", url, headers);
      expect(headers.get(c.header[0])).toBe(c.header[1]);
    }
    const url = new URL("https://svc.local/api");
    applyCredential({ kind: "query", name: "apikey" }, "tok", url, new Headers());
    expect(url.searchParams.get("apikey")).toBe("tok");
  });

  it("does nothing without a secret", () => {
    const url = new URL("https://svc.local/api");
    const headers = new Headers();
    applyCredential({ kind: "bearer" }, null, url, headers);
    expect([...headers.keys()]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, confirm failure**, then implement `packages/integrations/src/credentials.ts`:

```ts
import { JsonSecretCipher, resolveKeyring } from "@moss/db";
import type { CredentialPlacement } from "@moss/shared";

export function createIntegrationsCipher(env: Record<string, string | undefined>): JsonSecretCipher {
  return new JsonSecretCipher(
    resolveKeyring(
      "JARVIS_INTEGRATIONS_SECRET_KEY",
      "JARVIS_INTEGRATIONS_SECRET_KEY_ID",
      "JARVIS_INTEGRATIONS_SECRET_KEYS",
      "jarvis-integrations-dev-secret",
      env
    )
  );
}

export function applyCredential(
  placement: CredentialPlacement | null,
  secret: string | null,
  url: URL,
  headers: Headers
): void {
  if (!secret) return;
  const kind = placement?.kind ?? "bearer";
  if (kind === "bearer") headers.set("authorization", `Bearer ${secret}`);
  else if (kind === "header") headers.set(placement?.name ?? "X-Api-Key", secret);
  else url.searchParams.set(placement?.name ?? "apikey", secret);
}
```

(Check `resolveKeyring`'s actual parameter order in `packages/db/src/keyring.ts:22` before writing the call — the five arguments are keyEnvVar, keyIdEnvVar, keysEnvVar, devDefault, env; match whatever the connectors cipher construction does.)

- [ ] **Step 3: Add the env triple to every deployment config** that carries the connectors secret triple — dev and prod compose/env files, same PR. Grep for `JARVIS_CONNECTORS_SECRET_KEY` to find every file; add `JARVIS_INTEGRATIONS_SECRET_KEY(_ID/_KEYS)` beside it in each.

- [ ] **Step 4: Run the test green; commit** with `feat(integrations): credential cipher and placement rendering (#2162)`.

---

### Task 4: Repository — CRUD with the credential kept out of reads

**Files:**
- Create: `packages/integrations/src/repository.ts`
- Test: `tests/integration/integrations-repository.test.ts`

**Interfaces:**
- Consumes: `DataContextDb` brand, `resetFoundationDatabase()` / withDataContext harness — copy the setup from `tests/integration/connectors.test.ts:38-60`.
- Produces (all take `scopedDb: DataContextDb` first):
  - `createConnection(scopedDb, input: { name; kind; url; credentialEnvelope: unknown | null; credentialPlacement: CredentialPlacement | null }): Promise<ConnectionRow>`
  - `listConnections(scopedDb): Promise<ConnectionRow[]>` — never selects `credential`
  - `getConnection(scopedDb, id): Promise<ConnectionRow | null>` — never selects `credential`
  - `updateConnection(scopedDb, id, patch): Promise<ConnectionRow | null>`
  - `deleteConnection(scopedDb, id): Promise<boolean>`
  - `loadCredentialEnvelope(scopedDb, id): Promise<unknown | null>` — the ONLY function that reads the `credential` column
  - `saveDiscovery(scopedDb, id, tools: DiscoveredTool[] | null, error: string | null): Promise<void>`
  - `ConnectionRow` = every column except `credential`, camelCased (includes `baseUrl: string | null`, `specPasted: boolean`, `discoveredTools: DiscoveredTool[]`), plus `hasCredential: boolean` (selected as `credential IS NOT NULL`).
  - `createConnection` input also takes `baseUrl: string | null` and `specPasted: boolean`.

- [ ] **Step 1: Write the failing integration test.** Two users; user A creates a connection with a fake envelope; assert: A lists/gets it with `hasCredential: true` and no `credential` key anywhere in the row object; user B's scoped context lists empty and gets null for A's id (RLS proof); update flips `enabled` and curation arrays; `loadCredentialEnvelope` returns the envelope for A and null for B; delete removes it; duplicate `(owner, name)` insert rejects. Follow `tests/integration/connectors.test.ts` for harness setup, per-user contexts, and cleanup.

- [ ] **Step 2: Run it via the `verify-gate` skill scoped to this test file; confirm failure.**

- [ ] **Step 3: Implement `repository.ts`.** Follow `packages/connectors/src/repository.ts:133-156` for the insert idiom — `owner_user_id` is set with `` sql`app.current_actor_user_id()` ``, never a JS-passed id. Insert-time columns: name, kind, url, credential (envelope as jsonb or null), credential_placement. Every SELECT lists columns explicitly and omits `credential`; include `(credential IS NOT NULL) AS has_credential`. `updateConnection` builds a partial SET (only provided keys; `credential: null` clears the column; always `updated_at = now()`). `saveDiscovery` writes `discovered_tools`, `last_discovery_at = now()` on success, `last_error` (null on success).

- [ ] **Step 4: Gate-run the test green (verify-gate skill); commit** `feat(integrations): connection repository with owner-only RLS (#2162)`.

---

### Task 5: OpenAPI spec → tools converter

**Files:**
- Create: `packages/integrations/src/openapi-convert.ts`, `packages/integrations/src/errors.ts`
- Test: `tests/unit/integrations-openapi-convert.test.ts`

**Interfaces:**
- Produces:
  - `class IntegrationUserError extends Error` (plain-English message safe to show the user; routes map it to 422)
  - `interface OpenApiInvocation { readonly method: string; readonly path: string; readonly params: readonly { name: string; in: "path" | "query" | "header" }[]; readonly hasBody: boolean }`
  - `interface DiscoveredTool extends IntegrationToolDescriptor { readonly invoke?: OpenApiInvocation }` — this is what `discovered_tools` jsonb stores for both kinds (`invoke` absent for MCP)
  - `convertOpenApiSpec(spec: unknown): DiscoveredTool[]`
  - `sanitizeToolName(raw: string): string`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, expect, it } from "vitest";
import { convertOpenApiSpec, IntegrationUserError } from "@moss/integrations";

const spec = {
  openapi: "3.0.0",
  components: {
    schemas: { Movie: { type: "object", properties: { title: { type: "string" } } } }
  },
  paths: {
    "/api/v3/movie/{id}": {
      get: {
        operationId: "getMovieById",
        summary: "Get one movie",
        tags: ["Movie"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }]
      }
    },
    "/api/v3/movie": {
      post: {
        operationId: "createMovie",
        tags: ["Movie"],
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Movie" } } }
        }
      }
    },
    "/api/v3/queue": {
      get: { summary: "Queue", parameters: [{ name: "page", in: "query", schema: { type: "integer" } }] }
    }
  }
};

describe("convertOpenApiSpec", () => {
  it("converts operations to tools with tag groups and object-root schemas", () => {
    const tools = convertOpenApiSpec(spec);
    expect(tools).toHaveLength(3);
    const get = tools.find((t) => t.name === "getMovieById")!;
    expect(get.group).toBe("Movie");
    expect(get.description).toBe("Get one movie");
    expect(get.inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(get.invoke).toEqual({
      method: "GET", path: "/api/v3/movie/{id}",
      params: [{ name: "id", in: "path" }], hasBody: false
    });
  });

  it("resolves local $refs into the body schema and names untagged ops into a default group", () => {
    const tools = convertOpenApiSpec(spec);
    const post = tools.find((t) => t.name === "createMovie")!;
    const props = post.inputSchema!.properties as Record<string, any>;
    expect(props.body.properties.title).toEqual({ type: "string" });
    expect(post.invoke!.hasBody).toBe(true);
    const queue = tools.find((t) => t.name === "get_api_v3_queue")!;
    expect(queue.group).toBe("Other");
  });

  it("never emits a top-level combinator", () => {
    for (const t of convertOpenApiSpec(spec)) {
      for (const k of ["anyOf", "oneOf", "allOf", "not"]) expect(k in (t.inputSchema ?? {})).toBe(false);
    }
  });

  it("rejects a non-OpenAPI document with a plain message", () => {
    expect(() => convertOpenApiSpec({ hello: 1 })).toThrow(IntegrationUserError);
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement.** `errors.ts`:

```ts
export class IntegrationUserError extends Error {}
```

`openapi-convert.ts`:

```ts
import type { IntegrationToolDescriptor } from "@moss/shared";
import { IntegrationUserError } from "./errors";

export interface OpenApiInvocation {
  readonly method: string;
  readonly path: string;
  readonly params: readonly { name: string; in: "path" | "query" | "header" }[];
  readonly hasBody: boolean;
}

export interface DiscoveredTool extends IntegrationToolDescriptor {
  readonly invoke?: OpenApiInvocation;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "op";
}

function resolveRefs(node: unknown, doc: Record<string, unknown>, depth: number): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, depth + 1));
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      target = (target as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return resolveRefs(target ?? {}, doc, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, doc, depth + 1);
  return out;
}

export function convertOpenApiSpec(spec: unknown): DiscoveredTool[] {
  const doc = spec as Record<string, unknown> | null;
  const paths = doc?.paths;
  if (!doc || typeof doc !== "object" || !paths || typeof paths !== "object") {
    throw new IntegrationUserError("That URL did not return an OpenAPI document.");
  }
  const tools: DiscoveredTool[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(paths as Record<string, Record<string, unknown>>)) {
    if (!item || typeof item !== "object") continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;
      const rawName = typeof op.operationId === "string" && op.operationId
        ? op.operationId
        : `${method}_${path}`;
      let name = sanitizeToolName(rawName);
      for (let i = 2; seen.has(name); i += 1) name = `${sanitizeToolName(rawName)}_${i}`;
      seen.add(name);

      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolveRefs(p, doc, 0) as Record<string, unknown>)
        .filter((p) => typeof p?.name === "string" && ["path", "query", "header"].includes(p.in as string));

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name as string] = resolveRefs(p.schema ?? { type: "string" }, doc, 0);
        if (p.required === true) required.push(p.name as string);
      }
      const bodySchema = (op.requestBody as Record<string, any> | undefined)?.content?.["application/json"]?.schema;
      if (bodySchema) properties.body = resolveRefs(bodySchema, doc, 0);

      const tags = Array.isArray(op.tags) ? op.tags : [];
      tools.push({
        name,
        description: String(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).slice(0, 500),
        group: typeof tags[0] === "string" && tags[0] ? tags[0] : "Other",
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        invoke: {
          method: method.toUpperCase(),
          path,
          params: params.map((p) => ({ name: p.name as string, in: p.in as "path" | "query" | "header" })),
          hasBody: Boolean(bodySchema)
        }
      });
    }
  }
  if (tools.length === 0) throw new IntegrationUserError("The spec has no operations Moss can turn into tools.");
  return tools;
}
```

- [ ] **Step 4: Run green; commit** `feat(integrations): OpenAPI spec to tool conversion (#2162)`.

---

### Task 6: Remote invocation — OpenAPI HTTP renderer and MCP client

**Files:**
- Create: `packages/integrations/src/openapi-invoke.ts`, `packages/integrations/src/mcp-client.ts`, `packages/integrations/src/limits.ts`
- Modify: `packages/integrations/package.json` (add `@modelcontextprotocol/sdk`)
- Test: `tests/unit/integrations-openapi-invoke.test.ts`, `tests/integration/integrations-mcp-client.test.ts`

**Interfaces:**
- Consumes: `applyCredential` (Task 3), `OpenApiInvocation`/`DiscoveredTool` (Task 5).
- Produces:
  - `limits.ts`: `DISCOVERY_TIMEOUT_MS = 15_000`, `TOOL_CALL_TIMEOUT_MS = 30_000`, `RESPONSE_CHAR_CAP = 64_000`
  - `invokeOpenApiTool(baseUrl: string, invoke: OpenApiInvocation, input: Record<string, unknown>, secret: string | null, placement: CredentialPlacement | null): Promise<{ ok: boolean; data: Record<string, unknown> }>`
  - Both invokers retry ONCE, quietly, when the transport throws (network drop / abort) — never on an HTTP error status. Helper `retryOnce<T>(fn: () => Promise<T>): Promise<T>` (catch → one immediate re-attempt → rethrow). Spec's "#1709 resilience philosophy": transient drops retried within bounds, real failures surface honestly.
  - `fetchOpenApiSpec(specUrl: string, secret, placement): Promise<unknown>` (15s timeout, JSON only — a non-JSON body throws `IntegrationUserError("The spec URL must return JSON.")`)
  - `discoverMcpTools(url: string, secret, placement): Promise<DiscoveredTool[]>`
  - `callMcpTool(url: string, secret, placement, toolName: string, input: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }>`

- [ ] **Step 1: Write the failing OpenAPI-invoke unit test.** Start a throwaway `node:http` server inside the test (listen on port 0). Cases: (a) path template `/api/v3/movie/{id}` with `input.id = 7` hits `/api/v3/movie/7`; (b) query params land in the URL, header params in headers, `X-Api-Key` placement header present; (c) `input.body` is sent as JSON body with `content-type: application/json`; (d) JSON response comes back parsed under `data.result`; (e) a body longer than `RESPONSE_CHAR_CAP` comes back truncated with `data.truncated === true`; (f) HTTP 401 returns `{ ok: false, data: { status: 401, ... } }` without throwing; (g) a fixture that destroys the first socket then serves normally succeeds via the single retry, and one that always drops still throws.

- [ ] **Step 2: Implement `openapi-invoke.ts`:**

```ts
import type { CredentialPlacement } from "@moss/shared";
import { applyCredential } from "./credentials";
import { IntegrationUserError } from "./errors";
import { DISCOVERY_TIMEOUT_MS, RESPONSE_CHAR_CAP, TOOL_CALL_TIMEOUT_MS } from "./limits";
import type { OpenApiInvocation } from "./openapi-convert";

export async function fetchOpenApiSpec(
  specUrl: string, secret: string | null, placement: CredentialPlacement | null
): Promise<unknown> {
  const url = new URL(specUrl);
  const headers = new Headers({ accept: "application/json" });
  applyCredential(placement, secret, url, headers);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new IntegrationUserError(`The spec URL answered with status ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new IntegrationUserError("The spec URL must return JSON.");
  }
}

export async function invokeOpenApiTool(
  baseUrl: string,
  invoke: OpenApiInvocation,
  input: Record<string, unknown>,
  secret: string | null,
  placement: CredentialPlacement | null
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let path = invoke.path;
  const headers = new Headers({ accept: "application/json" });
  const query = new URLSearchParams();
  for (const p of invoke.params) {
    const value = input[p.name];
    if (value === undefined || value === null) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === "query") query.set(p.name, String(value));
    else headers.set(p.name, String(value));
  }
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of query) url.searchParams.set(k, v);
  applyCredential(placement, secret, url, headers);

  let body: string | undefined;
  if (invoke.hasBody && input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  const res = await retryOnce(() =>
    fetch(url, { method: invoke.method, headers, body, signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS) })
  );
  const text = await res.text();
  const truncated = text.length > RESPONSE_CHAR_CAP;
  const capped = truncated ? text.slice(0, RESPONSE_CHAR_CAP) : text;
  let parsed: unknown = capped;
  if (!truncated) {
    try { parsed = JSON.parse(capped); } catch { /* keep text */ }
  }
  return {
    ok: res.ok,
    data: { status: res.status, result: parsed, ...(truncated ? { truncated: true } : {}) }
  };
}
```

- [ ] **Step 3: Write the failing MCP client integration test.** Build an in-test MCP server with the SDK (`McpServer` + `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, mounted on a throwaway `node:http` server) registering two tools, one with a valid object schema and one whose input schema is `{ anyOf: [...] }` at the root. Assert `discoverMcpTools` returns both as `DiscoveredTool`s (group `""`, no `invoke`), and `callMcpTool` on the valid tool returns its content. (The root-combinator skip happens at registration time in Task 8, not here — discovery reports everything, per spec.)

- [ ] **Step 4: Implement `mcp-client.ts`:**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { CredentialPlacement } from "@moss/shared";
import { applyCredential } from "./credentials";
import { IntegrationUserError } from "./errors";
import { DISCOVERY_TIMEOUT_MS, TOOL_CALL_TIMEOUT_MS } from "./limits";
import type { DiscoveredTool } from "./openapi-convert";

async function connect(rawUrl: string, secret: string | null, placement: CredentialPlacement | null) {
  const url = new URL(rawUrl);
  const headers = new Headers();
  applyCredential(placement, secret, url, headers);
  const requestInit = { headers: Object.fromEntries(headers.entries()) };
  const client = new Client({ name: "moss-integrations", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  } catch {
    await client.connect(new SSEClientTransport(url, { requestInit }));
  }
  return client;
}

export async function discoverMcpTools(
  url: string, secret: string | null, placement: CredentialPlacement | null
): Promise<DiscoveredTool[]> {
  const client = await connect(url, secret, placement).catch(() => {
    throw new IntegrationUserError("Could not reach an MCP server at that URL.");
  });
  try {
    const res = await client.listTools({}, { timeout: DISCOVERY_TIMEOUT_MS });
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      group: "",
      inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? null
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callMcpTool(
  url: string, secret: string | null, placement: CredentialPlacement | null,
  toolName: string, input: Record<string, unknown>
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const client = await connect(url, secret, placement);
  try {
    const res = await client.callTool({ name: toolName, arguments: input }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS });
    const text = (res.content as { type: string; text?: string }[] | undefined)
      ?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
    return { ok: res.isError !== true, data: { result: text } };
  } finally {
    await client.close().catch(() => {});
  }
}
```

Wrap the `callTool` invocation in the same `retryOnce` helper (a thrown transport error only — an `isError: true` result is a real answer, never retried). Put `retryOnce` in `limits.ts`:

```ts
export async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}
```

(Verify the SDK's exact option names — `requestInit`, `timeout` — against the installed version's types before finishing; adjust to the real API, keeping the behavior above.)

- [ ] **Step 5: Run both test files green (verify-gate skill for the integration one); commit** `feat(integrations): MCP client and OpenAPI invocation (#2162)`.

---

### Task 7: Discovery service, REST routes, manifest route coverage

**Files:**
- Create: `packages/integrations/src/discovery.ts`, `packages/integrations/src/routes.ts`
- Modify: `packages/integrations/src/manifest.ts` (fill `routes[]`, wire `registerRoutes`), `packages/integrations/src/index.ts` (exports)
- Test: `tests/integration/integrations-routes.test.ts`

**Interfaces:**
- Consumes: repository (Task 4), converter/clients (Tasks 5-6), cipher (Task 3), route deps pattern from `packages/goals/src/routes.ts:112-124` (`deps.resolveAccessContext`, `deps.dataContext.withDataContext`), error mapping pattern from `packages/connectors/src/routes.ts:295-298` (`handleRouteError`).
- Produces REST API (all under `/api/integrations`, all declared in manifest `routes[]`):
  - `GET /api/integrations` → `ListIntegrationsResponse`
  - `POST /api/integrations` (`CreateIntegrationRequest`) → `IntegrationDetail`; 422 + plain message on discovery failure, nothing saved
  - `GET /api/integrations/:id` → `IntegrationDetail` (404 if not owner's)
  - `PATCH /api/integrations/:id` (`UpdateIntegrationRequest`) → `IntegrationDetail`
  - `POST /api/integrations/:id/refresh` → `IntegrationDetail` (re-discovery; on failure saves `last_error`, keeps old tools, returns 200 with `lastError` set)
  - `DELETE /api/integrations/:id` → 204
  - `discovery.ts`: `discoverTools(kind, url, secret, placement): Promise<DiscoveredTool[]>`, `toDetail(row, tools): IntegrationDetail` (computes groups, counts, `groupOptIn` via `isGroupOptIn`, `enabledToolCount` via `effectiveEnabledTools`), and `resolveOpenApiBase(spec, specUrl): string`.

**OpenAPI base-URL ruling (locked here so tasks agree):** for a fetched spec, `url` stores the spec URL and `base_url` is computed at discovery time from the spec's `servers[0].url` resolved against the spec URL (`new URL(server ?? "/", specUrl)`, trailing slashes stripped) — this survives reverse-proxy path prefixes. For a pasted spec (`spec` in the request), `url` IS the service base URL: `base_url = url`, `spec_pasted = true`. Invocation always uses `base_url`. Refresh on a pasted-spec connection replies 422 `Paste an updated spec to refresh.` unless the PATCH/refresh body carries a new `spec` (accept optional `spec` on the refresh POST body for this).

- [ ] **Step 1: Write the failing route integration test.** Spin the test server the way `tests/integration/connectors.test.ts` does. Point a connection at an in-test OpenAPI fixture (reuse the Task 5 spec served by a throwaway `node:http` server, guarded by an `X-Api-Key` check). Cases: create → 200 with discovered tools and `hasCredential: true`, and the raw DB row's `credential` column is an envelope (assert the token string does not appear anywhere in the JSON response); create against a dead URL → 422, list stays empty; wrong API key → 422 with a message that does not contain the key; PATCH curation arrays round-trip; refresh after the fixture changes its spec updates the tool list; second user gets 404 on the first user's id; DELETE → 204 then 404.

- [ ] **Step 2: Implement `discovery.ts`:**

```ts
import type { CredentialPlacement, IntegrationDetail, IntegrationKind } from "@moss/shared";
import { effectiveEnabledTools, isGroupOptIn } from "./curation";
import { discoverMcpTools } from "./mcp-client";
import { convertOpenApiSpec, type DiscoveredTool } from "./openapi-convert";
import { fetchOpenApiSpec } from "./openapi-invoke";
import type { ConnectionRow } from "./repository";

export async function discoverTools(
  kind: IntegrationKind, url: string, secret: string | null, placement: CredentialPlacement | null
): Promise<DiscoveredTool[]> {
  if (kind === "mcp") return discoverMcpTools(url, secret, placement);
  return convertOpenApiSpec(await fetchOpenApiSpec(url, secret, placement));
}

export function toDetail(row: ConnectionRow, tools: readonly DiscoveredTool[]): IntegrationDetail {
  const state = { enabledGroups: row.enabledGroups, enabledTools: row.enabledTools, mutedTools: row.mutedTools };
  const enabled = effectiveEnabledTools(tools, state);
  const groupNames = [...new Set(tools.map((t) => t.group))];
  return {
    id: row.id, name: row.name, kind: row.kind, url: row.url, enabled: row.enabled,
    hasCredential: row.hasCredential,
    toolCount: tools.length, enabledToolCount: enabled.length,
    lastDiscoveryAt: row.lastDiscoveryAt, lastError: row.lastError,
    credentialPlacement: row.credentialPlacement,
    tools: tools.map(({ invoke: _invoke, ...t }) => t),
    groups: groupNames.map((name) => ({
      name,
      toolCount: tools.filter((t) => t.group === name).length,
      enabled: row.enabledGroups.includes(name)
    })),
    enabledGroups: row.enabledGroups, enabledTools: row.enabledTools, mutedTools: row.mutedTools,
    groupOptIn: isGroupOptIn(tools.length)
  };
}

export function resolveOpenApiBase(spec: unknown, specUrl: string): string {
  const server = (spec as { servers?: { url?: unknown }[] } | null)?.servers?.[0]?.url;
  const base = new URL(typeof server === "string" && server ? server : "/", specUrl);
  return base.toString().replace(/\/+$/, "");
}
```

- [ ] **Step 3: Implement `routes.ts`.** Handler skeleton per route (goals pattern), with the invariant-critical parts:
  - **Create:** validate body (name non-empty, kind in enum, URL parses http/https); encrypt the credential OUTSIDE `withDataContext` (`cipher.encryptJson({ secret })` — only the envelope crosses into the repository, matching `packages/connectors/src/routes.ts:301-322`); discover BEFORE inserting — for a pasted `spec`, `JSON.parse` it (bad JSON → `IntegrationUserError("That is not valid JSON.")`) and convert directly instead of fetching; compute `baseUrl`/`specPasted` per the base-URL ruling above; on `IntegrationUserError` reply 422 `{ error: message }` and save nothing; on success insert + `saveDiscovery`, reply `toDetail`.
  - **Refresh:** load row + envelope, decrypt, `discoverTools`; on success `saveDiscovery(tools, null)`; on failure `saveDiscovery(null, sanitizedMessage)` keeping the old `discovered_tools` (repository treats `tools: null` as "don't touch the column"), reply 200 with the updated detail.
  - Sanitized error text: `IntegrationUserError.message` passes through; any other error becomes `"Could not reach the service."` — never a raw transport dump, and never string-interpolate the secret anywhere.
  - **Errors:** wrap every handler with the module's `handleRouteError(error, reply)` copied in shape from connectors.
  - Declare all six routes in the manifest `routes[]` (exact `method`/`path` strings matching registration — `assertRouteCoverage` is bidirectional) and wire `registerRoutes(server, deps)` in the registration object.
- [ ] **Step 4: Gate-run the route test green (verify-gate skill).**
- [ ] **Step 5: Commit** `feat(integrations): connection routes with connect-time discovery (#2162)`.

---

### Task 8: Chat tool proxy — per-user synthetic modules in the gateway

**Files:**
- Create: `packages/integrations/src/tool-manifests.ts`
- Modify: `apps/api/src/server.ts` (wrap the resolver — currently built at `apps/api/src/server.ts:427-441`)
- Test: `tests/unit/integrations-tool-manifests.test.ts`, plus extend `tests/integration/integrations-routes.test.ts` with a gateway listing assertion

**Interfaces:**
- Consumes: `ToolExecute`/`ToolContext`/`ToolResult` (`packages/module-sdk/src/index.ts:90-140`), `ModuleAssistantToolManifest` (`:565`), the resolver type used by `createActiveModulesResolver`, repository + curation + invokers.
- Produces: `createIntegrationsActiveModulesResolver(base, deps)` where `deps = { dataContext, cipher, logger }`. Wrapped resolver output feeds `executableTools` → `tools/list` automatically (CLI already has the `mcp__jarvis__*` wildcard grant — no launch-flag change).

- [ ] **Step 1: Write the failing unit test.** Feed a fake repository listing (inject via deps a `listEnabledConnections(scopedDb)` override or fake `dataContext`) returning: one enabled MCP connection "home-assistant" with 3 tools, one of which has a root `anyOf` schema; one disabled connection; one large (31-tool) OpenAPI connection with one group enabled. Assert the resolver: appends synthetic modules to the base list without touching base entries; tool names are `home-assistant.turn_on` style (`<slug>.<tool>`, slug = connection name lowercased, non `[a-z0-9-]` → `-`); the root-combinator tool is ABSENT and the logger got a warning naming connection + tool; the disabled connection contributes nothing; the large connection contributes exactly its enabled group's tools; every manifest has `isExternal: true`, `externalContent: true`, `risk: "outbound"`, an `execute` function.

- [ ] **Step 2: Implement `tool-manifests.ts`:**

```ts
import type { JsonSecretCipher } from "@moss/db";
import { effectiveEnabledTools } from "./curation";
import { callMcpTool } from "./mcp-client";
import type { DiscoveredTool } from "./openapi-convert";
import { invokeOpenApiTool } from "./openapi-invoke";
import { listConnections, loadCredentialEnvelope, type ConnectionRow } from "./repository";

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

export function connectionSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "connection";
}

function hasRootCombinator(schema: Record<string, unknown> | null): boolean {
  return schema !== null && ROOT_COMBINATORS.some((k) => k in schema);
}
```

Then the resolver factory. Shape (fill types from the actual resolver signature in `packages/module-registry/src/active-modules-resolver.ts` and the manifest type — the synthetic manifest needs every field `MossModuleManifest` requires; set the minimum honest values, `supportsUserDisable: false`, no routes/sql/queues):

```ts
export function createIntegrationsActiveModulesResolver(base, deps) {
  return async (actorUserId: string) => {
    const modules = await base(actorUserId);
    const accessContext = { actorUserId, requestId: `int_${crypto.randomUUID()}` };
    const connections = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
      listConnections(scopedDb)
    );
    const synthetic = [];
    for (const conn of connections.filter((c) => c.enabled && c.discoveredTools.length > 0)) {
      const slug = connectionSlug(conn.name);
      const state = { enabledGroups: conn.enabledGroups, enabledTools: conn.enabledTools, mutedTools: conn.mutedTools };
      const tools = [];
      for (const tool of effectiveEnabledTools(conn.discoveredTools, state)) {
        if (hasRootCombinator(tool.inputSchema)) {
          deps.logger.warn({ connection: conn.name, tool: tool.name }, "integration tool skipped: top-level schema combinator");
          continue; // #1363: the CLI would silently drop it anyway; skip loudly instead
        }
        tools.push(buildToolManifest(conn, slug, tool as DiscoveredTool, deps));
      }
      if (tools.length > 0) synthetic.push(buildSyntheticModule(conn, slug, tools));
    }
    return [...modules, ...synthetic];
  };
}

function buildToolManifest(conn: ConnectionRow, slug: string, tool: DiscoveredTool, deps) {
  return {
    name: `${slug}.${tool.name}`,
    description: tool.description,
    permissionId: `integrations.${conn.id}`,
    risk: "outbound" as const,
    executionPolicy: "auto" as const, // Ben's ruling: connecting grants normal use
    isExternal: true,   // remote input validation + error hygiene in the gateway
    externalContent: true, // remote results get the gateway's trust wrapper
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    execute: (async (scopedDb, input, _ctx) => {
      const envelope = await loadCredentialEnvelope(scopedDb as never, conn.id);
      const secret = envelope ? (deps.cipher.decryptJson(envelope) as { secret: string }).secret : null;
      const outcome = tool.invoke
        ? await invokeOpenApiTool(conn.url, tool.invoke, input as Record<string, unknown>, secret, conn.credentialPlacement)
        : await callMcpTool(conn.url, secret, conn.credentialPlacement, tool.name, input as Record<string, unknown>);
      return { data: outcome.ok ? outcome.data : { error: true, ...outcome.data } };
    })
  };
}
```

  For the OpenAPI branch, the invocation base is `conn.baseUrl ?? conn.url` (Task 7's base-URL ruling — `base_url` is always set for openapi connections at discovery time).

  `buildSyntheticModule(conn, slug, tools)` returns a `MossModuleManifest` carrying `id: \`integration-${slug}\``, `name: conn.name`, `assistantTools: tools`, `supportsUserDisable: false`, and no routes/sql/queues/workers — fill the remaining REQUIRED fields of `MossModuleManifest` (`packages/module-sdk/src/index.ts:663` area) with minimum honest values; the gateway only reads `id`, `name`, and `assistantTools` (`gateway.ts:829-870`), and synthetic modules never pass through boot-time built-in assertions because they exist only in resolver output.

  Notes to preserve: the `execute` closure must never put `secret` in a thrown error or log line; a timeout/network throw is fine to let propagate — the gateway treats `isExternal` tools' thrown errors as opaque (`gateway.ts:644-661`).

- [ ] **Step 3: Wire it in `apps/api/src/server.ts`.** Wrap the OUTERMOST existing resolver (after the external-modules layering that ends at `:441`): `const resolveActiveModulesWithIntegrations = createIntegrationsActiveModulesResolver(resolveActiveModules, { dataContext, cipher: integrationsCipher, logger: server.log });` and pass the wrapped one into the chat wiring. Build `integrationsCipher = createIntegrationsCipher(process.env)` next to the connectors cipher.

- [ ] **Step 4: Extend the route integration test:** after creating the fixture OpenAPI connection, call `gateway.listToolsForActor(userA)` (or the equivalent seam used by existing chat integration tests — find one with `grep -l listToolsForActor tests/integration/`) and assert the namespaced tools appear for user A and NOT for user B; then execute one tool end-to-end against the fixture server and assert the fixture saw the API key header while the gateway result contains no key material.

- [ ] **Step 5: Gate-run unit + integration green (verify-gate skill); commit** `feat(integrations): chat tool proxy for connection tools (#2162)`.

---

### Task 9: Web plumbing — API client, query keys, section registration

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/query-keys.ts`
- Modify: `packages/shared/src/app-map-core.ts` (`CORE_APP_SETTINGS` — required or the settings page THROWS at render, `settings-page.tsx:56`)
- Modify: `apps/web/src/settings/settings-page.tsx` (section id + group entry + lazy pane)
- Create: `apps/web/src/settings/settings-integrations-pane.tsx` (stub this task; real UI Tasks 10-11)

**Interfaces:**
- Consumes: `requestJson` (`apps/web/src/api/client.ts:1407`), DTOs from `@moss/shared` (Task 1).
- Produces: `listIntegrations() / createIntegration(body) / getIntegration(id) / updateIntegration(id, body) / refreshIntegration(id) / deleteIntegration(id)`; `queryKeys.integrations.list` and `queryKeys.integrations.detail(id)`; Settings section id `"integrations"`.

- [ ] **Step 1: API client functions** (append near the connectors block in `client.ts`, types imported from `@moss/shared`):

```ts
export async function listIntegrations(): Promise<ListIntegrationsResponse> {
  return requestJson<ListIntegrationsResponse>("/api/integrations");
}
export async function createIntegration(body: CreateIntegrationRequest): Promise<IntegrationDetail> {
  return requestJson<IntegrationDetail>("/api/integrations", { method: "POST", body });
}
export async function getIntegration(id: string): Promise<IntegrationDetail> {
  return requestJson<IntegrationDetail>(`/api/integrations/${encodeURIComponent(id)}`);
}
export async function updateIntegration(id: string, body: UpdateIntegrationRequest): Promise<IntegrationDetail> {
  return requestJson<IntegrationDetail>(`/api/integrations/${encodeURIComponent(id)}`, { method: "PATCH", body });
}
export async function refreshIntegration(id: string): Promise<IntegrationDetail> {
  return requestJson<IntegrationDetail>(`/api/integrations/${encodeURIComponent(id)}/refresh`, { method: "POST" });
}
export async function deleteIntegration(id: string): Promise<void> {
  return requestJson<void>(`/api/integrations/${encodeURIComponent(id)}`, { method: "DELETE" });
}
```

Query keys, following the existing nesting style in `query-keys.ts`:

```ts
integrations: {
  list: ["integrations"] as const,
  detail: (id: string) => ["integrations", id] as const
}
```

- [ ] **Step 2: Register the section.** In `packages/shared/src/app-map-core.ts` add to `CORE_APP_SETTINGS` (match neighboring entries exactly):

```ts
{
  id: "integrations",
  label: "Integrations",
  description: "Connect external tools and services.",
  path: "/settings?section=integrations",
  scope: "user"
}
```

In `settings-page.tsx`: add `"integrations"` to the `PersonalSectionId` union (`:60`), add a `lazyPane` const, and add the section to the **Connections** group after "Data sources" (`:194-212`):

```tsx
{
  id: "integrations",
  icon: Plug,
  label: "Integrations",
  description: coreSettingDescription("integrations"),
  Pane: IntegrationsPane
}
```

(`Plug` from `lucide-react`, imported alongside `Link2`/`Database`.)

- [ ] **Step 3: Stub pane** so the app compiles and the section renders:

```tsx
import { PaneHead } from "./settings-ui";

export function SettingsIntegrationsPane() {
  return <PaneHead title="Integrations" />;
}
```

- [ ] **Step 4: Verify** — web typecheck plus any app-map/settings contract test (`grep -rl CORE_APP_SETTINGS tests/` and run what it finds via the appropriate runner; verify-gate skill if DB-touching). Open the dev instance and confirm the Integrations row appears under Connections and the pane renders.

- [ ] **Step 5: Commit** `feat(integrations): settings section, web client, query keys (#2162)`.

---

### Task 10: Settings pane — list and add

**Files:**
- Modify: `apps/web/src/settings/settings-integrations-pane.tsx`
- Modify: `apps/web/src/styles/settings-panes-3.css` (new classes under a `/* ---- Integrations (#2162) ---- */` banner — do NOT create a new CSS file; a new file needs `WEB_DEFINITION_FILES` + import wiring)
- Test: extend `tests/unit/unstyled-surfaces-css.test.ts` (pin the new non-jds classes; it's the only guard that covers them)

**Interfaces:**
- Consumes: Task 9 client functions + query keys; primitives `{ Badge, Field, Group, Note, PaneHead, Row, Switch }` and `Button`, `Select`, `Segmented` from `./settings-ui` / `@moss/ui`; `useFeedback` toast/confirm; `readError` from `./settings-types`.
- Produces: view routing on search param `integration` (`null` = list, `"new"` = add, else detail — Task 11 consumes `openIntegration(id)` / `closeToList()`).

**Copy (verbatim — Ben's tight-copy ruling; do not add hints, examples, or extra sentences):**
- Pane head title: `Integrations`. No desc.
- List: group title `Connections`, action button `Add connection`. Empty state one line: `No connections yet.`
- Add form: segmented kind choice `MCP server` / `API`; fields `Name`, `URL`, `Credential`, and for API kind a placement `Select` labeled `Send as` with options `Bearer token` / `Header` / `Query parameter` plus a `Header name` / `Parameter name` field when applicable. API kind also gets a plain link `Paste the spec` that reveals a `Spec` textarea (sent as `spec`; the URL field then holds the service address). Submit `Connect`, cancel `Cancel`.
- The one load-bearing note (add form): `Credentials are encrypted and never shown again.`

- [ ] **Step 1: Build the pane.** Structure (mirror `settings-skills-pane.tsx` conventions — `retry: false` queries, mutation + invalidate + toast on error):

```tsx
export function SettingsIntegrationsPane() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("integration"); // null | "new" | id
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const listQuery = useQuery({ queryKey: queryKeys.integrations.list, queryFn: listIntegrations, retry: false });

  const openIntegration = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("integration", id);
    setSearchParams(next);
  };
  const closeToList = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("integration");
    setSearchParams(next, { replace: true }); // replace so back doesn't ping-pong (ModulesPane pattern)
  };

  if (view === "new") return <AddIntegrationView onDone={openIntegration} onCancel={closeToList} />;
  if (view) return <IntegrationDetailView id={view} onBack={closeToList} />; // Task 11
  // list body...
}
```

Unknown/stale `integration` ids: `IntegrationDetailView`'s query 404s → render the list-return path via a `Note` + back action, mirroring the deep-link fall-back philosophy of `module-settings-deep-link.ts` (unknown → list, never an error screen).

List row per connection: `Row` with `name` = connection name + `Badge` (`MCP` / `API`), `desc` = URL host plus status — `Connected` / `Error` / `Off`, and the enabled-tool count as `N tools on`; `control` = `Switch` bound to a `updateIntegration(id, { enabled })` mutation and a `Configure` `Button` calling `openIntegration(id)`. Status derives: `!enabled` → Off; `lastError` → Error; else Connected. No accent left-border anywhere; layout only via existing `.set-row`/`.pane__card` classes plus new `.intg__*` classes for anything genuinely new (badge spacing, status line).

Add view: local `useState` for kind/name/url/credential/placement; `createIntegration` mutation; on success `toast` nothing (the landing detail IS the feedback) and `onDone(detail.id)`; on `ApiError` show `err.message` inline in a `Note` on the form (the 422 body carries the plain-English discovery failure — a failed first attempt never saves a card, so no cleanup path needed). Placement defaults: MCP kind sends no placement (bearer default server-side); API kind defaults to `Header` + name `X-Api-Key`.

- [ ] **Step 2: CSS.** Add only classes actually needed under the banner comment in `settings-panes-3.css`; pin each new selector in `tests/unit/unstyled-surfaces-css.test.ts` (add `settings-panes-3.css` to its read list if absent).

- [ ] **Step 3: Run the invented-class audit** (design-system skill commands) over `apps/web/src/settings/` — zero output required. Run web typecheck + the unstyled-surfaces test.

- [ ] **Step 4: Live check on the dev instance:** add a connection against a junk URL → inline plain-English error, no card saved; leave the form → list unchanged.

- [ ] **Step 5: Commit** `feat(integrations): settings list and add views (#2162)`.

---

### Task 11: Settings pane — connection detail

**Files:**
- Modify: `apps/web/src/settings/settings-integrations-pane.tsx` (add `IntegrationDetailView`)
- Modify: `apps/web/src/styles/settings-panes-3.css` (same banner block)

**Interfaces:**
- Consumes: `getIntegration/updateIntegration/refreshIntegration/deleteIntegration`, `queryKeys.integrations.detail(id)`, Task 10's `onBack`.

**Copy (verbatim):** back link `Back to integrations`; actions `Refresh` and `Remove`; remove confirm title `Remove connection?`, body `Its tools disappear from chat.`, confirm label `Remove`; group-opt-in note (shown only when `groupOptIn` and no groups enabled): `Groups start off. Turn on the ones Moss should use.`

- [ ] **Step 1: Build the detail view.** Do NOT reuse `ModuleSub` (its back label is hardcoded `Back to modules`, `settings-module-subviews.tsx:70-93`); build a small local header with the same `.gflow`/`.gflow__back` classes and `ArrowLeft` icon, label `Back to integrations`.
  - Query: `useQuery({ queryKey: queryKeys.integrations.detail(id), queryFn: () => getIntegration(id), retry: false })`; on `ApiError` 404 render `Note` `Connection not found.` + the back link.
  - Header block: name, kind `Badge`, URL host, status line, `Refresh` button (mutation → invalidate detail + list; while pending, disable), `Remove` button (`confirm` then `deleteIntegration` → invalidate list → `onBack()`).
  - `lastError` present → one `Note` with the sanitized message and the `Refresh` button beside it (this is the "test connection" retry from the spec).
  - Tool list: when `groupOptIn` is false, one `Group` (`title` = `Tools`) with a `Row` per tool — `name` = tool name, `desc` = description, `control` = `Switch` checked when not muted, toggling via `updateIntegration(id, { mutedTools })` (compute next array locally from `detail.mutedTools`).
  - When `groupOptIn` is true: one `Group` per spec tag (title = group name + `toolCount`), group-level `Switch` in the `Group` `action` slot driving `enabledGroups`; rows inside get per-tool switches whose checked state = membership in `effectiveEnabledTools` semantics (group on → checked unless muted; group off → checked only if in `enabledTools`), toggling the matching array. Mutations all `updateIntegration` + invalidate detail.
  - Mutation errors → `toast(readError(error), { tone: "drift" })` (house pattern).
- [ ] **Step 2: Audit + tests** — invented-class audit again, unstyled-surfaces pins for any new selectors, web typecheck.
- [ ] **Step 3: Live check on dev:** connect the fixture (or a real Sonarr if reachable) and click through: groups toggle, per-tool override inside an off group, mute inside an on group, refresh, remove.
- [ ] **Step 4: Commit** `feat(integrations): connection detail view with tool curation (#2162)`.

---

### Task 12: Full gate, PR, live-path proof, merge

**Files:**
- Modify: PR description (Release note section), `docs/coordination/*` only if a coordinator asks

- [ ] **Step 1: Full gate** via the `verify-gate` skill (`pnpm verify:foundation` semantics — never raw). Known-acceptable local red: `module-sdk-worker` unit tests (green in CI; never bisect over it).
- [ ] **Step 2: Open the PR** from the worktree branch. Release note: Category **Added**, Title `Connect Moss to external tools`, Description: `You can now connect Moss to services that speak MCP or publish an OpenAPI spec from Settings, and use their features from chat.` Body links spec + #2162.
- [ ] **Step 3: Live-path proof — BOTH kinds, on the live dev instance (http://192.168.50.36:5173), recorded on the PR:**
  - **Home Assistant (MCP):** add the connection with Ben's HA MCP URL + long-lived token (if credentials aren't on hand, add an AWAITING-BEN entry AND run `needs-ben` per the box rules — do not fake this proof). Detail view lists HA's tools; from chat, drive a real entity (e.g. toggle a light) and quote the tool call + result on the PR.
  - **Radarr/Sonarr (OpenAPI):** add the connection with the spec URL + API key; enable a group (e.g. Queue or Series); from chat, answer a real query (e.g. what's in the queue) and record it.
  - Dev-instance traps to remember: a new module's tables need the manual reconcile step after install, and a stale server can hold the port while health still reads 200 — memory notes `dev-module-install-needs-manual-reconcile` and `stale-server-holds-the-port` cover both.
- [ ] **Step 4: CI green → `gh pr merge --squash --auto`.** After merge, verify the release-notes workflow picked up the note. Update the GitHub issue #2162 / project board status.
- [ ] **Step 5: Save memory** (`memory_save`, project `jarv1s`): the resolver-wrapper injection seam for dynamic per-user tools, and the openapi `url`-is-the-spec-URL / base-is-origin decision.
