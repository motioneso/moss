import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner, JsonSecretCipher } from "@moss/db";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import type {
  CreateIntegrationRequest,
  CredentialPlacement,
  IntegrationDetail,
  IntegrationKind,
  IntegrationSummary,
  ListIntegrationsResponse
} from "@moss/shared";

import { createIntegrationsCipher } from "./credentials.js";
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

export interface IntegrationsRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: IntegrationsRepository;
  readonly cipher?: JsonSecretCipher;
}

interface IdParams {
  readonly id: string;
}

export function registerIntegrationsRoutes(
  server: FastifyInstance,
  dependencies: IntegrationsRouteDependencies
): void {
  const repository = dependencies.repository ?? new IntegrationsRepository();
  const cipher = dependencies.cipher ?? createIntegrationsCipher();

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

      const credentialEnvelope =
        body.credential !== undefined ? cipher.encryptJson({ secret: body.credential }) : null;

      const detail = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
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
      const patch = buildUpdatePatch(value, cipher);
      const updated = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.updateConnection(scopedDb, request.params.id, patch)
      );
      if (!updated) return reply.code(404).send({ error: "Integration not found" });
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
          const secret = envelope
            ? (cipher.decryptJson(cipher.parseEnvelope(envelope)).secret as string)
            : null;
          return refreshWith(scopedDb, row, () =>
            discoverTools(row.kind, row.url, secret, row.credentialPlacement)
          );
        }
      );

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
      return reply.code(204).send();
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
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

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    mappers: [
      (e, r) =>
        e instanceof IntegrationUserError ? r.code(422).send({ error: e.message }) : undefined
    ],
    invalidRequestMessage: "Integration request is invalid"
  });
}
