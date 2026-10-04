import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import {
  type AccessContext,
  type DataContextDb,
  type DataContextRunner,
  type JsonSecretCipher,
  type Keyring
} from "@moss/db";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
  type CreateIntegrationRequest,
  type CredentialPlacement,
  type IntegrationDetail,
  type IntegrationKind,
  type IntegrationSummary,
  type ListIntegrationsResponse,
  type PrepareIntegrationClassifierResponse,
  type SetIntegrationKeptOutRequest,
  type SetIntegrationSendWithoutAskingRequest,
  type SortIntegrationClassifierResponse
} from "@moss/shared";

import { resolveIntegrationsCipher } from "./credentials.js";
import { candidateCache } from "./classifier-candidates.js";
import { enqueueClassifierSort, type ClassifierSortJobOp } from "./classifier-sort-jobs.js";
import { enqueueClassifierPreparation } from "./classifier-preparation-jobs.js";
import { INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES, toolSortState } from "./classifier-settings.js";
import { effectiveEnabledTools } from "./curation.js";
import { discoverTools, resolveOpenApiBase, toDetail } from "./discovery.js";
import { IntegrationUserError } from "./errors.js";
import { discoverMcpTools } from "./mcp-client.js";
import { convertOpenApiSpec, type DiscoveredTool } from "./openapi-convert.js";
import { fetchOpenApiSpec } from "./openapi-invoke.js";
import {
  IntegrationsRepository,
  type ConnectionRow,
  type UpdateConnectionInput
} from "./repository.js";
import { resolverCache, type ResolverCache } from "./resolver-cache.js";

export interface IntegrationsRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: IntegrationsRepository;
  readonly cipher?: JsonSecretCipher;
  /**
   * Master key store (#2312): loads the family keyring per request when no cipher
   * is injected and no env key is set. Injected by the composition root; omitted in
   * tests, which pass a cipher directly.
   */
  readonly resolveKeyring?: (scopedDb: DataContextDb) => Promise<Keyring | null>;
  /** Test seam — defaults to the module-level `resolverCache` singleton (#2175 Task 8). */
  readonly resolverCache?: ResolverCache;
  /**
   * #2984 R2.2, R2.4: queues the background tool sort and preparation. Absent (older wiring/tests)
   * means nothing is queued and the Try again requests answer 503.
   */
  readonly boss?: PgBoss;
}

interface IdParams {
  readonly id: string;
}

/** Patch fields that change which of a connection's tools chat can use. */
const TOOL_CHOICE_FIELDS = ["enabledGroups", "enabledTools", "mutedTools", "unsuppressedTools"];

export function registerIntegrationsRoutes(
  server: FastifyInstance,
  dependencies: IntegrationsRouteDependencies
): void {
  const repository = dependencies.repository ?? new IntegrationsRepository();
  const cache = dependencies.resolverCache ?? resolverCache;

  /**
   * Cipher for this request: injected cipher wins (tests), else the env key with
   * its existing semantics, else the family key from the master store. Missing
   * everywhere means the feature is paused for setup — a 503 naming the fix,
   * never a boot-style throw and never key material.
   */
  async function cipherForRequest(scopedDb: DataContextDb): Promise<JsonSecretCipher> {
    const cipher = await resolveIntegrationsCipher(scopedDb, dependencies);
    if (cipher) return cipher;
    throw new HttpError(
      503,
      "Integration credentials are paused until an encryption key is set up. " +
        "Ask an admin to open Settings, Encryption keys, and press Generate."
    );
  }

  /**
   * Queue the tool sort after the request's transaction commits. The row is already saved, so a
   * queue failure is logged and the request still succeeds; the worker's start-up sweep catches
   * any tool left never tried.
   */
  async function queueSort(
    request: FastifyRequest,
    actorUserId: string,
    connectionId: string,
    op: ClassifierSortJobOp = "sort"
  ): Promise<void> {
    if (!dependencies.boss) return;
    try {
      await enqueueClassifierSort(dependencies.boss, actorUserId, connectionId, op);
    } catch (error) {
      request.log.warn(
        { connectionId, error: error instanceof Error ? error.message : "unknown" },
        "integrations: could not queue tool sorting"
      );
    }
  }

  /**
   * Queue preparation for tools that became available to chat. Failed tools still wait for the
   * owner's Try again. A queue failure is logged; the next sort queues preparation again.
   */
  async function queuePreparation(
    request: FastifyRequest,
    actorUserId: string,
    connectionId: string
  ): Promise<void> {
    if (!dependencies.boss) return;
    try {
      await enqueueClassifierPreparation(dependencies.boss, actorUserId, connectionId, "prepare");
    } catch (error) {
      request.log.warn(
        { connectionId, error: error instanceof Error ? error.message : "unknown" },
        "integrations: could not queue tool preparation"
      );
    }
  }

  server.get("/api/integrations", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const rows = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.listConnections(scopedDb)
      );
      const integrations: IntegrationSummary[] = rows.map(toSummary);
      return { integrations } satisfies ListIntegrationsResponse;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.post("/api/integrations", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = parseCreateBody(request.body);
      const credentialPlacement =
        body.credential !== undefined ? (body.credentialPlacement ?? null) : null;

      let tools: DiscoveredTool[];
      let baseUrl: string | null = null;
      let specPasted = false;
      try {
        if (body.kind === "mcp") {
          tools = await discoverMcpTools(body.url, body.credential ?? null, credentialPlacement);
        } else if (body.spec !== undefined) {
          const parsed = parseJson(body.spec);
          tools = convertOpenApiSpec(parsed);
          baseUrl = body.url;
          specPasted = true;
        } else {
          const spec = await fetchOpenApiSpec(
            body.url,
            body.credential ?? null,
            credentialPlacement
          );
          tools = convertOpenApiSpec(spec);
          baseUrl = resolveOpenApiBase(spec, body.url);
        }
      } catch (error) {
        return reply.code(422).send({ error: sanitizedMessage(error) });
      }

      const detail = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const cipher = await cipherForRequest(scopedDb);
          const credentialEnvelope =
            body.credential !== undefined ? cipher.encryptJson({ secret: body.credential }) : null;
          const created = await repository.createConnection(scopedDb, {
            name: body.name,
            kind: body.kind,
            url: body.url,
            baseUrl,
            specPasted,
            credentialEnvelope,
            credentialPlacement
          });
          await repository.saveDiscovery(scopedDb, created.id, tools, null);
          const refreshed = await repository.getConnection(scopedDb, created.id);
          return toDetail(refreshed ?? created, tools);
        }
      );

      cache.drop(accessContext.actorUserId);
      await queueSort(request, accessContext.actorUserId, detail.id);
      return reply.code(201).send(detail);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get<{ Params: IdParams }>("/api/integrations/:id", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const row = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.getConnection(scopedDb, request.params.id)
      );
      if (!row) return reply.code(404).send({ error: "Integration not found" });
      return toDetail(row, row.discoveredTools);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch<{ Params: IdParams }>("/api/integrations/:id", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const value = requireObject(request.body);
      const updated = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const cipher = await cipherForRequest(scopedDb);
          const patch = buildUpdatePatch(value, cipher);
          return repository.updateConnection(scopedDb, request.params.id, patch);
        }
      );
      if (!updated) return reply.code(404).send({ error: "Integration not found" });
      cache.drop(accessContext.actorUserId);
      candidateCache.dropConnection(accessContext.actorUserId, request.params.id);
      // Turning the switch on queues a sort, and every sort is followed by preparation. With the
      // switch already on, a change to which tools chat can use queues preparation alone.
      if (value.classifierEnabled === true) {
        await queueSort(request, accessContext.actorUserId, updated.id);
      } else if (updated.classifierEnabled && TOOL_CHOICE_FIELDS.some((field) => field in value)) {
        await queuePreparation(request, accessContext.actorUserId, updated.id);
      }
      return toDetail(updated, updated.discoveredTools);
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.post<{ Params: IdParams }>("/api/integrations/:id/refresh", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = (request.body ?? {}) as { spec?: unknown };
      const pastedSpec = body.spec === undefined ? undefined : requiredString(body.spec, "spec");

      const detail = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const row = await repository.getConnection(scopedDb, request.params.id);
          if (!row) throw new HttpError(404, "Integration not found");

          if (row.specPasted) {
            if (pastedSpec === undefined) {
              throw new IntegrationUserError("Paste an updated spec to refresh.");
            }
            const parsed = parseJson(pastedSpec);
            return refreshWith(scopedDb, row, () => Promise.resolve(convertOpenApiSpec(parsed)));
          }

          const envelope = await repository.loadCredentialEnvelope(scopedDb, row.id);
          const cipher = await cipherForRequest(scopedDb);
          const secret = envelope
            ? (cipher.decryptJson(cipher.parseEnvelope(envelope)).secret as string)
            : null;
          return refreshWith(scopedDb, row, () =>
            discoverTools(row.kind, row.url, secret, row.credentialPlacement)
          );
        }
      );

      cache.drop(accessContext.actorUserId);
      candidateCache.dropConnection(accessContext.actorUserId, request.params.id);
      await queueSort(request, accessContext.actorUserId, request.params.id);
      return detail;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  async function refreshWith(
    scopedDb: DataContextDb,
    row: ConnectionRow,
    run: () => Promise<DiscoveredTool[]>
  ): Promise<IntegrationDetail> {
    try {
      const tools = await run();
      await repository.saveDiscovery(scopedDb, row.id, tools, null);
      const refreshed = await repository.getConnection(scopedDb, row.id);
      return toDetail(refreshed ?? row, tools);
    } catch (error) {
      const message = sanitizedMessage(error);
      await repository.saveDiscovery(scopedDb, row.id, null, message);
      const refreshed = await repository.getConnection(scopedDb, row.id);
      return toDetail(refreshed ?? row, (refreshed ?? row).discoveredTools);
    }
  }

  server.delete<{ Params: IdParams }>("/api/integrations/:id", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const deleted = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.deleteConnection(scopedDb, request.params.id)
      );
      if (!deleted) return reply.code(404).send({ error: "Integration not found" });
      cache.drop(accessContext.actorUserId);
      candidateCache.dropConnection(accessContext.actorUserId, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  /**
   * #2984 R2.5b: the owner keeps tools out of the classifier, or lets them back in. Only
   * discovered tool names are accepted, all or nothing. Letting tools back in with the switch on
   * queues their preparation, and a sort first when any of them has no current sort.
   */
  server.put<{ Params: IdParams }>(
    "/api/integrations/:id/classifier/kept-out",
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseKeptOut(request.body);
        const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.setClassifierToolsKeptOut(
            scopedDb,
            request.params.id,
            body.toolNames,
            body.keptOut
          )
        );
        if (result.status === "not_found") throw new HttpError(404, "Integration not found");
        if (result.status === "unknown_tool") {
          throw new HttpError(400, "That tool is not on this connection.");
        }
        const updated = result.connection;
        cache.drop(accessContext.actorUserId);
        candidateCache.dropConnection(accessContext.actorUserId, updated.id);
        if (!body.keptOut && updated.classifierEnabled) {
          const names = new Set(body.toolNames);
          const needsSort = updated.discoveredTools.some(
            (tool) =>
              names.has(tool.name) &&
              toolSortState(updated.classifierSort, tool).status !== "current"
          );
          // Every sort is followed by preparation, so a sort alone covers both.
          if (needsSort) await queueSort(request, accessContext.actorUserId, updated.id);
          else await queuePreparation(request, accessContext.actorUserId, updated.id);
        }
        return toDetail(updated, updated.discoveredTools);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  /**
   * #2984 R2.2: the owner's Try again. Queues a background sort that also re-sends tools whose
   * last sort failed; nothing else resends them.
   */
  server.post<{ Params: IdParams }>(
    "/api/integrations/:id/classifier/sort",
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        if (!dependencies.boss) throw new HttpError(503, "Tool sorting is not available.");
        const row = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getConnection(scopedDb, request.params.id)
        );
        if (!row) throw new HttpError(404, "Integration not found");
        await enqueueClassifierSort(dependencies.boss, accessContext.actorUserId, row.id, "retry");
        return reply
          .code(202)
          .send({ status: "queued" } satisfies SortIntegrationClassifierResponse);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  /**
   * #2984 R2.3: the owner allows or undoes sending without asking, for one tool or a whole group.
   * All or nothing: any tool not currently sorted as sending things out refuses the whole request,
   * so a Sensitive tool can never carry the flag.
   */
  server.put<{ Params: IdParams }>(
    "/api/integrations/:id/classifier/send-without-asking",
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseSendWithoutAsking(request.body);
        const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.setClassifierSendWithoutAsking(
            scopedDb,
            request.params.id,
            body.toolNames,
            body.allow
          )
        );
        if (result.status === "not_found") throw new HttpError(404, "Integration not found");
        if (result.status === "refused") {
          throw new HttpError(
            409,
            "Only a tool sorted as sending things out can send without asking."
          );
        }
        cache.drop(accessContext.actorUserId);
        return toDetail(result.connection, result.connection.discoveredTools);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  /**
   * #2984 R2.4: the owner's Try again for preparation. Queues a background run that also re-sends
   * tools whose last preparation failed; nothing else resends them. The reply keeps the earlier
   * draft shape with nothing in it, because the job saves each prepared tool itself.
   */
  server.post<{ Params: IdParams }>(
    "/api/integrations/:id/classifier/prepare",
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = requireObject(request.body ?? {});
        if ("force" in body && typeof body.force !== "boolean") {
          throw new HttpError(400, "force must be a boolean");
        }
        if (!dependencies.boss) throw new HttpError(503, "Tool preparation is not available.");
        const row = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getConnection(scopedDb, request.params.id)
        );
        if (!row) throw new HttpError(404, "Integration not found");
        if (!row.classifierEnabled) {
          throw new HttpError(409, "Turn on the connection classifier before preparing its tools.");
        }
        await enqueueClassifierPreparation(
          dependencies.boss,
          accessContext.actorUserId,
          row.id,
          "retry"
        );
        return reply.code(202).send({
          disclosure: INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
          status: "ok",
          drafts: [],
          reused: [],
          failed: [],
          remaining: 0
        } satisfies PrepareIntegrationClassifierResponse);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function toSummary(row: ConnectionRow): IntegrationSummary {
  const tools = row.discoveredTools;
  const enabled = effectiveEnabledTools(tools, {
    enabledGroups: row.enabledGroups,
    enabledTools: row.enabledTools,
    mutedTools: row.mutedTools
  });
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    enabled: row.enabled,
    hasCredential: row.hasCredential,
    toolCount: tools.length,
    enabledToolCount: enabled.length,
    lastDiscoveryAt: row.lastDiscoveryAt ? row.lastDiscoveryAt.toISOString() : null,
    lastError: row.lastError
  };
}

function sanitizedMessage(error: unknown): string {
  return error instanceof IntegrationUserError ? error.message : "Could not reach the service.";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new IntegrationUserError("That is not valid JSON.");
  }
}

function parseCreateBody(body: unknown): CreateIntegrationRequest {
  const value = requireObject(body);
  const name = requiredString(value.name, "name");
  const kind = requiredKind(value.kind);
  const url = parseHttpUrl(value.url, "url");
  const spec = value.spec === undefined ? undefined : requiredString(value.spec, "spec");
  const credential =
    value.credential === undefined ? undefined : requiredString(value.credential, "credential");
  const credentialPlacement =
    value.credentialPlacement === undefined
      ? undefined
      : (parsePlacement(value.credentialPlacement) ?? undefined);
  return { name, kind, url, spec, credential, credentialPlacement };
}

function buildUpdatePatch(
  value: Record<string, unknown>,
  cipher: JsonSecretCipher
): UpdateConnectionInput {
  let patch: UpdateConnectionInput = {};
  if ("name" in value) patch = { ...patch, name: requiredString(value.name, "name") };
  if ("url" in value) patch = { ...patch, url: parseHttpUrl(value.url, "url") };
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    patch = { ...patch, enabled: value.enabled };
  }
  if ("credential" in value) {
    const credentialEnvelope =
      value.credential === null
        ? null
        : cipher.encryptJson({ secret: requiredString(value.credential, "credential") });
    patch = { ...patch, credentialEnvelope };
  }
  if ("credentialPlacement" in value) {
    patch = { ...patch, credentialPlacement: parsePlacement(value.credentialPlacement) };
  }
  if ("enabledGroups" in value) {
    patch = { ...patch, enabledGroups: requiredStringArray(value.enabledGroups, "enabledGroups") };
  }
  if ("enabledTools" in value) {
    patch = { ...patch, enabledTools: requiredStringArray(value.enabledTools, "enabledTools") };
  }
  if ("mutedTools" in value) {
    patch = { ...patch, mutedTools: requiredStringArray(value.mutedTools, "mutedTools") };
  }
  if ("unsuppressedTools" in value) {
    patch = {
      ...patch,
      unsuppressedTools: requiredStringArray(value.unsuppressedTools, "unsuppressedTools")
    };
  }
  if ("classifierEnabled" in value) {
    if (typeof value.classifierEnabled !== "boolean") {
      throw new HttpError(400, "classifierEnabled must be a boolean");
    }
    patch = { ...patch, classifierEnabled: value.classifierEnabled };
  }
  return patch;
}

function parsePlacement(value: unknown): CredentialPlacement | null {
  if (value === null || value === undefined) return null;
  const obj = requireObject(value, "credentialPlacement");
  const kind = obj.kind;
  if (kind !== "bearer" && kind !== "header" && kind !== "query") {
    throw new HttpError(400, "credentialPlacement.kind must be bearer, header, or query");
  }
  if (obj.name !== undefined && typeof obj.name !== "string") {
    throw new HttpError(400, "credentialPlacement.name must be a string");
  }
  return { kind, ...(obj.name !== undefined ? { name: obj.name as string } : {}) };
}

function requiredKind(value: unknown): IntegrationKind {
  if (value === "mcp" || value === "openapi") return value;
  throw new HttpError(400, 'kind must be "mcp" or "openapi"');
}

function parseHttpUrl(value: unknown, fieldName: string): string {
  const str = requiredString(value, fieldName);
  let parsed: URL;
  try {
    parsed = new URL(str);
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `${fieldName} must be an http or https URL`);
  }
  return str;
}

function requireObject(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      label === "body" ? "Expected JSON object body" : `${label} must be a JSON object`
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${fieldName} must be a string`);
  const trimmed = fieldName === "name" ? value.trim() : value;
  if (!trimmed) throw new HttpError(400, `${fieldName} must not be empty`);
  return trimmed;
}

function requiredStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${fieldName} must be an array`);
  return value.map((item, index) => requiredString(item, `${fieldName}[${index}]`));
}

const SEND_WITHOUT_ASKING_MAX_TOOLS = 500;
const TOOL_NAME_MAX_LENGTH = 200;

function parseSendWithoutAsking(body: unknown): SetIntegrationSendWithoutAskingRequest {
  const value = requireObject(body);
  if (typeof value.allow !== "boolean") throw new HttpError(400, "allow must be a boolean");
  const toolNames = requiredStringArray(value.toolNames, "toolNames");
  if (toolNames.length === 0 || toolNames.length > SEND_WITHOUT_ASKING_MAX_TOOLS) {
    throw new HttpError(400, `toolNames must hold 1 to ${SEND_WITHOUT_ASKING_MAX_TOOLS} names`);
  }
  if (toolNames.some((name) => name.length > TOOL_NAME_MAX_LENGTH)) {
    throw new HttpError(400, "A tool name is too long");
  }
  return { allow: value.allow, toolNames: [...new Set(toolNames)] };
}

function parseKeptOut(body: unknown): SetIntegrationKeptOutRequest {
  const value = requireObject(body);
  if (typeof value.keptOut !== "boolean") throw new HttpError(400, "keptOut must be a boolean");
  const toolNames = requiredStringArray(value.toolNames, "toolNames");
  if (toolNames.length === 0 || toolNames.length > INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES) {
    throw new HttpError(
      400,
      `toolNames must hold 1 to ${INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES} names`
    );
  }
  if (toolNames.some((name) => name.length > TOOL_NAME_MAX_LENGTH)) {
    throw new HttpError(400, "A tool name is too long");
  }
  return { keptOut: value.keptOut, toolNames: [...new Set(toolNames)] };
}

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    mappers: [
      (e, r) =>
        e instanceof IntegrationUserError ? r.code(422).send({ error: e.message }) : undefined
    ],
    invalidRequestMessage: "Integration request is invalid"
  });
}
