import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parsePositiveIntEnv } from "@moss/shared";

import {
  resolveMossEnv,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner,
  type MossActionAuditLog
} from "@moss/db";

// Per-user rate-limit key for the assistant-tools invoke endpoint via the shared module-sdk
// helper: a UUID-shaped session bearer or a valid session cookie is hashed (a one-way
// fingerprint, never the raw secret) so each LAN user gets a separate counter. Any other
// bearer shape (or none) falls back to the shared per-IP bucket so junk credentials can't
// mint fresh buckets (#207); such requests get a 401 before any AI spend.
//
// Override the limit via env: JARVIS_RL_AI_TOOLS_MAX=<n> (requests per minute, default 60).
const AI_TOOLS_MAX = parsePositiveIntEnv(resolveMossEnv(process.env, "JARVIS_RL_AI_TOOLS_MAX"), 60);
import {
  HttpError,
  handleRouteError as handleModuleRouteError,
  type MossActionPermissionTier,
  type ToolResult,
  type ToolServices
} from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";

import type { ActiveModulesResolver } from "./gateway/types.js";
import {
  AI_MODEL_CAPABILITIES,
  createAiConfiguredModelRouteSchema,
  createAiProviderConfigRouteSchema,
  getChatModelOverrideSettingsRouteSchema,
  invokeAiAssistantToolRouteSchema,
  listAiAssistantActionsRouteSchema,
  listAiAssistantToolsRouteSchema,
  putAdminChatModelOverrideSettingsRouteSchema,
  putChatModelOverrideSettingsRouteSchema,
  resolveAiAssistantActionRouteSchema,
  revokeAiProviderConfigRouteSchema,
  updateAiConfiguredModelRouteSchema,
  deleteAiConfiguredModelRouteSchema,
  updateAiProviderConfigRouteSchema,
  type AiAssistantToolBlockedReason,
  type AiAssistantActionDto,
  type AiAssistantActionStatus,
  type AiAssistantToolDto,
  type AiAssistantToolInvocationDto,
  type AiAuthMethod,
  type AiModelCapability,
  type AiModelStatus,
  type AiModelTier,
  type AiProviderConfigDto,
  type AiProviderExecutionMode,
  type AiProviderKind,
  type AiProviderStatus,
  type CreateAiConfiguredModelRequest,
  type CreateAiProviderConfigRequest,
  type InvokeAiAssistantToolRequest,
  type PutAdminChatModelOverrideRequest,
  type PutChatModelOverrideRequest,
  type ResolveAiAssistantActionRequest,
  type UpdateAiConfiguredModelRequest,
  type UpdateAiProviderConfigRequest,
  listActionAuditLogRouteSchema,
  type ActionAuditLogEntryDto,
  type ListActionAuditLogResponse
} from "@moss/shared";

import {
  findAssistantToolFromManifests,
  listAssistantToolsFromManifests,
  summarizeAssistantToolInput
} from "./assistant-tools.js";
import {
  sanitizeAssistantToolResult,
  boundedAssistantToolResultData
} from "./gateway/output-validation.js";
import { ToolInputValidationError, validateToolInput } from "./gateway/input-validation.js";
import { cliAvailable, type ProviderKind as CliProviderKind } from "./cli-availability.js";
import { registerAiAdminPinRoutes } from "./admin-ai-pin-routes.js";
import { registerAiServiceRoutes } from "./capability-route-routes.js";
import { registerAiTranscriptionRoutes } from "./transcription-routes.js";
import { registerAiVoiceEndpointRoutes } from "./voice-endpoint-routes.js";
import { registerActionPolicyRoutes } from "./action-policy-routes.js";
import { registerModuleBuildRoutes } from "./module-build-routes.js";
import { registerProviderVisibilityRoutes } from "./provider-visibility-routes.js";
import { createAiSecretCipher, type AiSecretCipher } from "./crypto.js";
import { discoverAndPersistModels } from "./discover-and-persist-models.js";
import { serializeModel } from "./serialize-model.js";
export { serializeModel } from "./serialize-model.js";
import { ModelDiscoveryService } from "./model-discovery.js";
import { registerAiProviderValidationRoutes } from "./provider-validation-routes.js";
import {
  registerTerminalRoutes,
  type TerminalRpcConnectOptions,
  type TerminalRpcHandle
} from "./terminal-routes.js";
import {
  AiRepository,
  NotAGenericProviderError,
  type AiAssistantActionRequestSafeRow,
  type ChatModelOverrideSettings,
  type AiProviderConfigSafeRow
} from "./repository.js";

export interface AiRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly resolveActiveModules: ActiveModulesResolver;
  // #915 D6: install-level ids for validating module.<id> binding keys.
  readonly listInstalledModuleIds?: () => readonly string[];
  readonly repository?: AiRepository;
  readonly secretCipher?: AiSecretCipher;
  readonly modelDiscovery?: ModelDiscoveryService;
  readonly tasksCompatibility?: {
    getResolvedTaskChangesPolicy: (db: DataContextDb) => Promise<MossActionPermissionTier>;
    setTaskChangesPolicy: (db: DataContextDb, tier: MossActionPermissionTier) => Promise<void>;
  };
  /** Passed to read-tool execute on the REST invoke path; gates email/calendar reads to granted accounts. */
  readonly readToolServices?: ToolServices;
  // #1059 — injected by the composition root (packages/module-registry) so packages/ai never
  // needs a direct @moss/chat dependency (that edge was tried and reverted: it creates real
  // cycles, see terminal-routes.ts's file-header comment). Absent in tests/deployments that
  // don't wire a cli-runner — the WS handler degrades gracefully (close code 1011) rather than
  // crashing when this is undefined.
  readonly connectTerminalRpc?: (options: TerminalRpcConnectOptions) => Promise<TerminalRpcHandle>;
  // #1256 — injected by the composition root so the resolve route can go through the same live
  // confirmation-registry gate as the chat action-requests resolve path, instead of persisting a
  // decision directly with no check that a waiter is actually pending on it.
  readonly resolveActionRequest?: (
    actorUserId: string,
    actionRequestId: string,
    status: "confirmed" | "rejected" | "cancelled"
  ) => Promise<"resolved" | "expired" | "not_found">;
  // #1888 — injected by the composition root: approving a module build starts it, which needs
  // the job queue. packages/ai owns the rule (ownership check, status transition) but not the
  // queue, so the wiring is handed in the same way resolveActionRequest is. Absent means the
  // approve route answers 503 rather than pretending the build started.
  readonly approveModuleBuild?: (
    scopedDb: DataContextDb,
    buildId: string,
    actorUserId: string
  ) => Promise<void>;
  readonly cancelModuleBuild?: (
    scopedDb: DataContextDb,
    buildId: string,
    actorUserId: string
  ) => Promise<boolean>;
}

type IdParams = { readonly id: string };
type AssistantToolParams = { readonly name: string };

const AI_PROVIDER_KINDS = new Set<AiProviderKind>([
  "openai-compatible",
  "anthropic",
  "google",
  "ollama",
  "custom"
]);
const WRITABLE_PROVIDER_STATUSES = new Set<Exclude<AiProviderStatus, "revoked">>([
  "active",
  "error",
  "disabled"
]);
const AUTH_METHODS = new Set<AiAuthMethod>(["cli", "api_key"]);
const EXECUTION_MODES = new Set<AiProviderExecutionMode>(["interactive", "non_interactive"]);
const CLI_PROVIDER_KINDS = new Set<CliProviderKind>(["anthropic", "openai-compatible", "google"]);
const MODEL_STATUSES = new Set<AiModelStatus>(["active", "disabled"]);
const MODEL_TIERS = new Set<AiModelTier>(["reasoning", "interactive", "economy"]);
const MODEL_CAPABILITIES = new Set<AiModelCapability>(AI_MODEL_CAPABILITIES);

export function registerAiRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies
): void {
  const repository = dependencies.repository ?? new AiRepository();
  const secretCipher = dependencies.secretCipher ?? createAiSecretCipher();
  const modelDiscovery = dependencies.modelDiscovery ?? new ModelDiscoveryService();

  registerProviderVisibilityRoutes(server, dependencies, repository, secretCipher, modelDiscovery);

  server.post(
    "/api/ai/providers",
    { schema: createAiProviderConfigRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseCreateProviderBody(request.body);
        const authMethod = body.authMethod ?? "api_key";
        const encryptedCredential =
          authMethod === "cli"
            ? secretCipher.encryptJson({ cli: true })
            : secretCipher.encryptJson(body.credentialPayload ?? {});
        const provider = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const created = await repository.createProvider(scopedDb, {
              providerKind: body.providerKind,
              displayName: body.displayName,
              baseUrl: body.baseUrl ?? null,
              status: body.status ?? "active",
              authMethod,
              executionMode: body.executionMode,
              encryptedCredential
            });

            // #982/#869 D1/D2/D6: every connect-shaped path uses one reconciler. CLI statics are
            // active and replace stale/manual concrete rows; API fallback guesses remain unpersisted.
            // Best-effort keeps provider creation usable during network/provider outages.
            try {
              await discoverAndPersistModels(
                scopedDb,
                {
                  actorUserId: accessContext.actorUserId,
                  providerId: created.id,
                  providerKind: created.provider_kind,
                  authMethod: created.auth_method,
                  baseUrl: created.base_url,
                  credential: authMethod === "cli" ? { cli: true } : (body.credentialPayload ?? {})
                },
                { repository, modelDiscovery }
              );
            } catch {
              // Soft-fail: leave the provider with no auto-discovered models.
            }

            // #870/H1: if this is the sole active admin-owned provider and none is flagged yet, adopt
            // it as the instance-default so a single-provider instance "just works" without an extra
            // click; a second provider added later leaves this flag untouched (admin chooses).
            if (created.status === "active") {
              const providers = await repository.listProviders(scopedDb);
              const activeCount = providers.filter((p) => p.status === "active").length;
              // #2207: only an active flagged row counts; a revoked row still carrying the flag
              // (installs from before the revoke fix) must not block adoption.
              const anyFlagged = providers.some(
                (p) => p.is_instance_default && p.status === "active"
              );
              if (!anyFlagged && activeCount === 1) {
                const flagged = await repository.setInstanceDefaultProvider(scopedDb, created.id);
                if (flagged) return flagged;
              }
            }

            return created;
          }
        );

        return reply.code(201).send({ provider: await serializeProvider(provider) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: IdParams }>(
    "/api/ai/providers/:id",
    { schema: updateAiProviderConfigRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseUpdateProviderBody(request.body);
        const encryptedCredential =
          body.authMethod === "cli"
            ? secretCipher.encryptJson({ cli: true })
            : body.credentialPayload === undefined
              ? undefined
              : secretCipher.encryptJson(body.credentialPayload);
        const reconnectChanged =
          body.credentialPayload !== undefined ||
          body.baseUrl !== undefined ||
          body.authMethod !== undefined;
        const provider = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const updated = await repository.updateProvider(scopedDb, request.params.id, {
              providerKind: body.providerKind,
              displayName: body.displayName,
              baseUrl: body.baseUrl,
              status: body.status,
              authMethod: body.authMethod,
              executionMode: body.executionMode,
              encryptedCredential
            });
            if (!updated || !reconnectChanged) return updated;

            // #982/#869 D2: saving credential/auth/base-url is a connect event. Invalidate before
            // probing so a corrected key cannot reuse the failed credential's cached result.
            modelDiscovery.invalidate(accessContext.actorUserId, updated.id);
            try {
              const sealed = await repository.selectProviderWithCredential(scopedDb, updated.id);
              if (sealed) {
                const credential =
                  updated.auth_method === "cli"
                    ? { cli: true }
                    : (body.credentialPayload ??
                      secretCipher.decryptJson(sealed.encrypted_credential));
                await discoverAndPersistModels(
                  scopedDb,
                  {
                    actorUserId: accessContext.actorUserId,
                    providerId: updated.id,
                    providerKind: updated.provider_kind,
                    authMethod: updated.auth_method,
                    baseUrl: updated.base_url,
                    credential
                  },
                  { repository, modelDiscovery }
                );
              }
            } catch {
              // #982: discovery/decrypt failures stay internal and never reject a valid settings save.
            }
            return updated;
          }
        );

        if (!provider) {
          return reply.code(404).send({ error: "AI provider config not found" });
        }

        if (!reconnectChanged) {
          modelDiscovery.invalidate(accessContext.actorUserId, request.params.id);
        }
        return { provider: await serializeProvider(provider) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: IdParams }>(
    "/api/ai/providers/:id/revoke",
    { schema: revokeAiProviderConfigRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const encryptedCredential = secretCipher.encryptJson({ revoked: true });
        const provider = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            return repository.revokeProvider(scopedDb, request.params.id, encryptedCredential);
          }
        );

        if (!provider) {
          return reply.code(404).send({ error: "AI provider config not found" });
        }

        modelDiscovery.invalidate(accessContext.actorUserId, request.params.id);
        return { provider: await serializeProvider(provider) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  registerAiProviderValidationRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    dataContext: dependencies.dataContext,
    repository,
    secretCipher,
    modelDiscovery
  });

  // #1059 — the LOCAL `repository` const (line ~144, above), not `dependencies.repository`
  // (usually undefined at this call site — every other registerXRoutes call in this function
  // uses the same local const for the same reason).
  registerTerminalRoutes(server, {
    resolveAccessContext: dependencies.resolveAccessContext,
    dataContext: dependencies.dataContext,
    repository,
    connectTerminalRpc: dependencies.connectTerminalRpc
  });

  server.post(
    "/api/ai/models",
    { schema: createAiConfiguredModelRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseCreateModelBody(request.body);
        const model = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            return repository.createModel(scopedDb, {
              providerConfigId: body.providerConfigId,
              providerModelId: body.providerModelId,
              displayName: body.displayName,
              capabilities: body.capabilities,
              status: body.status ?? "active",
              tier: body.tier,
              allowUserOverride: body.allowUserOverride
            });
          }
        );

        modelDiscovery.invalidate(accessContext.actorUserId, body.providerConfigId);
        return reply.code(201).send({ model: serializeModel(model, accessContext.actorUserId) });
      } catch (error) {
        // #886 MED-2: attaching a model to the hidden voice provider is refused. The voice row is not
        // a *generic* provider, so a 404 (it doesn't exist on this surface) is the right answer.
        if (error instanceof NotAGenericProviderError) {
          return handleRouteError(new HttpError(404, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: IdParams }>(
    "/api/ai/models/:id",
    { schema: updateAiConfiguredModelRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseUpdateModelBody(request.body);
        const model = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            return repository.updateModel(scopedDb, request.params.id, {
              providerModelId: body.providerModelId,
              displayName: body.displayName,
              capabilities: body.capabilities,
              status: body.status,
              tier: body.tier,
              allowUserOverride: body.allowUserOverride
            });
          }
        );

        if (!model) {
          return reply.code(404).send({ error: "AI model config not found" });
        }

        return { model: serializeModel(model, accessContext.actorUserId) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #2208 follow-up: the Remove button on a model row. The provider's `default` sentinel is kept
  // (400) so a CLI provider can always launch without --model.
  server.delete<{ Params: IdParams }>(
    "/api/ai/models/:id",
    { schema: deleteAiConfiguredModelRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const outcome = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const existing = (await repository.listModels(scopedDb)).find(
              (row) => row.id === request.params.id
            );
            if (!existing) {
              return { kind: "missing" as const };
            }
            if (existing.provider_model_id === "default") {
              return { kind: "sentinel" as const };
            }
            const id = await repository.deleteModel(scopedDb, request.params.id);
            return id ? { kind: "deleted" as const, id } : { kind: "missing" as const };
          }
        );
        if (outcome.kind === "missing") {
          return reply.code(404).send({ error: "AI model config not found" });
        }
        if (outcome.kind === "sentinel") {
          return reply
            .code(400)
            .send({ error: "The provider's default entry cannot be removed; disable it instead" });
        }
        return { id: outcome.id };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  registerAiServiceRoutes(server, dependencies, repository);
  registerAiTranscriptionRoutes(server, dependencies, repository, secretCipher);
  // #874: dedicated admin GET/PUT for the single instance-wide Voice (STT) endpoint (no discovery).
  registerAiVoiceEndpointRoutes(server, dependencies, repository, secretCipher);
  registerActionPolicyRoutes(server, dependencies, repository);
  registerModuleBuildRoutes(server, dependencies);
  registerAiAdminPinRoutes(server, dependencies, repository);

  server.get(
    "/api/ai/chat-model-override",
    { schema: getChatModelOverrideSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const settings = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getChatModelOverrideSettings(scopedDb)
        );

        return {
          settings: serializeChatModelOverrideSettings(settings, accessContext.actorUserId)
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/ai/chat-model-override",
    { schema: putChatModelOverrideSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parsePutChatModelOverrideBody(request.body);
        const settings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            if (await repository.getAdminPinnedModelId(scopedDb)) {
              throw new HttpError(
                409,
                "An admin has pinned your AI provider; contact them to change it"
              );
            }

            if (body.modelId !== null) {
              const current = await repository.getChatModelOverrideSettings(scopedDb);
              const allowed = current.selectableOverrideModels.some(
                (model) => model.id === body.modelId
              );
              if (!current.overrideEnabled || !allowed) {
                throw new HttpError(400, "Chat model override is not allowed for this model");
              }
            }

            return repository.setChatModelOverridePreference(scopedDb, body.modelId);
          }
        );

        return {
          settings: serializeChatModelOverrideSettings(settings, accessContext.actorUserId)
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/ai/chat-model-override",
    { schema: putAdminChatModelOverrideSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parsePutAdminChatModelOverrideBody(request.body);
        const settings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            return repository.setChatModelOverrideEnabled(scopedDb, {
              enabled: body.enabled,
              actorUserId: accessContext.actorUserId
            });
          }
        );

        return {
          settings: serializeChatModelOverrideSettings(settings, accessContext.actorUserId)
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/ai/assistant-actions",
    { schema: listAiAssistantActionsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const actions = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listAssistantActions(scopedDb)
        );

        return { actions: actions.map(serializeAssistantAction) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: IdParams }>(
    "/api/ai/assistant-actions/:id/resolve",
    { schema: resolveAiAssistantActionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseResolveAssistantActionBody(request.body);
        if (!dependencies.resolveActionRequest) {
          return reply.code(503).send({ error: "Assistant action resolution is not available" });
        }
        const outcome = await dependencies.resolveActionRequest(
          accessContext.actorUserId,
          request.params.id,
          body.status
        );
        if (outcome === "expired") {
          return reply.code(409).send({ error: "This request expired — ask again." });
        }
        if (outcome === "not_found") {
          return reply.code(404).send({ error: "Assistant action request not found" });
        }
        const action = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getAssistantAction(scopedDb, request.params.id)
        );
        if (!action) {
          return reply.code(404).send({ error: "Assistant action request not found" });
        }

        return { action: serializeAssistantAction(action) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  const AUDIT_RETENTION_DAYS = 90;
  const AUDIT_MAX_LIMIT = 500;
  const AUDIT_DEFAULT_LIMIT = 200;

  server.get<{ Querystring: { since?: string; family?: string; limit?: number } }>(
    "/api/ai/action-audit",
    { schema: listActionAuditLogRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const retentionFloor = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

        let since: Date;
        if (request.query.since) {
          const parsed = new Date(request.query.since);
          since = isNaN(parsed.getTime()) ? retentionFloor : parsed;
          if (since < retentionFloor) since = retentionFloor;
        } else {
          since = retentionFloor;
        }

        let familyFilter: { moduleId: string; familyId: string } | null = null;
        if (request.query.family) {
          const parts = request.query.family.split("/");
          if (parts.length === 2 && parts[0] && parts[1]) {
            familyFilter = { moduleId: parts[0], familyId: parts[1] };
          }
        }

        const limit = Math.min(request.query.limit ?? AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);

        const entries = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listActionAuditLog(scopedDb, { since, familyFilter, limit })
        );

        const response: ListActionAuditLogResponse = {
          entries: entries.map(serializeAuditLogEntry)
        };
        return response;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/ai/assistant-tools",
    { schema: listAiAssistantToolsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        // resolveActiveModules opens its OWN withDataContext (RLS-scoped to the actor),
        // so it must NOT be nested inside another withDataContext — that double-acquires
        // the pool and deadlocks at maxConnections:1. listAssistantToolsFromManifests is a
        // pure transform over the manifests (no DB), so no outer data context is needed.
        const activeModules = await dependencies.resolveActiveModules(accessContext.actorUserId);
        const tools = listAssistantToolsFromManifests(activeModules);

        return { tools };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: AssistantToolParams }>(
    "/api/ai/assistant-tools/:name/invoke",
    {
      schema: invokeAiAssistantToolRouteSchema,
      config: {
        rateLimit: {
          max: AI_TOOLS_MAX,
          timeWindow: "1 minute",
          keyGenerator: sessionRateLimitKey
        }
      }
    },
    async (request, reply) => {
      let tool: AiAssistantToolDto | undefined;

      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const activeModules = await dependencies.resolveActiveModules(accessContext.actorUserId);
        tool = findAssistantToolFromManifests(activeModules, request.params.name);

        if (!tool) {
          return reply.code(404).send({ error: "Assistant tool is not declared" });
        }

        const body = parseInvokeAssistantToolBody(request.body);

        if (tool.risk !== "read") {
          const pendingTool = tool as AiAssistantToolDto & {
            readonly risk: "write" | "outbound" | "destructive";
          };
          const action = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
            repository.createPendingAssistantAction(scopedDb, {
              toolModuleId: pendingTool.moduleId,
              toolModuleName: pendingTool.moduleName,
              toolName: pendingTool.name,
              permissionId: pendingTool.permissionId,
              risk: pendingTool.risk,
              inputSummary: summarizeAssistantToolInput(body.input ?? {}),
              requestId: accessContext.requestId
            })
          );

          return reply.code(403).send({
            invocation: serializeAssistantToolInvocation(
              pendingTool,
              "blocked",
              null,
              "confirmation_required",
              action.id
            )
          });
        }

        const selectedTool = tool;
        const manifestTool = activeModules
          .flatMap((m) => m.assistantTools ?? [])
          .find((t) => t.name === selectedTool.name);

        if (!manifestTool?.execute) {
          return reply.code(403).send({
            invocation: serializeAssistantToolInvocation(
              selectedTool,
              "blocked",
              null,
              "unsupported_tool",
              null
            )
          });
        }

        // Validate caller-supplied input before execution.
        // Invariant: validateToolInput gates every caller-supplied-input execute call on REST paths.
        const validatedInput = await validateToolInput(manifestTool.inputSchema, body.input ?? {}, {
          // Missing provenance is untrusted: only the registry's explicit false marker gets the
          // built-in synchronous path.
          external: manifestTool.isExternal !== false,
          toolName: selectedTool.name
        });
        // Read-only services (no write-capable entries) are passed here so read tools can access
        // informational services like featureGrants. The write→confirm floor remains structurally
        // un-bypassable: this path only reaches execute() for read tools (every write/destructive
        // tool 403s above with "confirmation_required"), and readToolServices carries no write-capable
        // services (calendarWrite, notesSync, etc.). Any service-backed write tool must be invoked
        // via the gateway/CLI path, which threads per-tool ToolServices only after an Approve.
        const readServices = dependencies.readToolServices ?? {};
        const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          manifestTool.execute!(
            scopedDb,
            validatedInput,
            {
              actorUserId: accessContext.actorUserId,
              requestId: accessContext.requestId ?? "",
              chatSessionId: ""
            },
            readServices
          ).then((rawResult): Record<string, unknown> => {
            const toolResult: ToolResult = { ...rawResult, data: rawResult.data ?? {} };
            const sanitized = sanitizeAssistantToolResult(manifestTool.outputSchema, toolResult);
            return boundedAssistantToolResultData(sanitized);
          })
        );

        return {
          invocation: serializeAssistantToolInvocation(
            selectedTool,
            "succeeded",
            result,
            null,
            null
          )
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function parseCreateProviderBody(body: unknown): CreateAiProviderConfigRequest {
  const value = requireObject(body);
  const authMethod = optionalAuthMethod(value.authMethod);

  if (authMethod !== "cli" && value.credentialPayload === undefined) {
    throw new HttpError(400, "credentialPayload is required for api_key auth method");
  }

  return {
    providerKind: requiredProviderKind(value.providerKind, "providerKind"),
    displayName: requiredString(value.displayName, "displayName"),
    baseUrl: optionalNullableString(value.baseUrl, "baseUrl"),
    status: optionalProviderStatus(value.status),
    authMethod,
    executionMode: optionalExecutionMode(value.executionMode),
    credentialPayload:
      value.credentialPayload === undefined
        ? undefined
        : requiredJsonObject(value.credentialPayload, "credentialPayload")
  };
}

function parseUpdateProviderBody(body: unknown): UpdateAiProviderConfigRequest {
  const value = requireObject(body);

  return {
    providerKind: optionalProviderKind(value.providerKind, "providerKind"),
    displayName: optionalString(value.displayName, "displayName"),
    baseUrl: optionalNullableString(value.baseUrl, "baseUrl"),
    status: optionalProviderStatus(value.status),
    authMethod: optionalAuthMethod(value.authMethod),
    executionMode: optionalExecutionMode(value.executionMode),
    credentialPayload:
      value.credentialPayload === undefined
        ? undefined
        : requiredJsonObject(value.credentialPayload, "credentialPayload")
  };
}

function parseCreateModelBody(body: unknown): CreateAiConfiguredModelRequest {
  const value = requireObject(body);

  return {
    providerConfigId: requiredString(value.providerConfigId, "providerConfigId"),
    providerModelId: requiredString(value.providerModelId, "providerModelId"),
    displayName: requiredString(value.displayName, "displayName"),
    capabilities: requiredCapabilities(value.capabilities, "capabilities"),
    status: optionalModelStatus(value.status),
    tier: optionalModelTier(value.tier),
    allowUserOverride: optionalBoolean(value.allowUserOverride, "allowUserOverride")
  };
}

function parseUpdateModelBody(body: unknown): UpdateAiConfiguredModelRequest {
  const value = requireObject(body);

  return {
    providerModelId: optionalString(value.providerModelId, "providerModelId"),
    displayName: optionalString(value.displayName, "displayName"),
    capabilities:
      value.capabilities === undefined
        ? undefined
        : requiredCapabilities(value.capabilities, "capabilities"),
    status: optionalModelStatus(value.status),
    tier: optionalModelTier(value.tier),
    allowUserOverride: optionalBoolean(value.allowUserOverride, "allowUserOverride")
  };
}

function parseInvokeAssistantToolBody(body: unknown): InvokeAiAssistantToolRequest {
  if (body === undefined) {
    return { input: {} };
  }

  const value = requireObject(body);

  return {
    input: value.input === undefined ? {} : requiredJsonObject(value.input, "input")
  };
}

function parseResolveAssistantActionBody(body: unknown): ResolveAiAssistantActionRequest {
  const value = requireObject(body);

  return {
    status: requiredResolvableAssistantActionStatus(value.status)
  };
}

function parsePutChatModelOverrideBody(body: unknown): PutChatModelOverrideRequest {
  const value = requireObject(body);
  const modelId = value.modelId;
  if (modelId !== null && typeof modelId !== "string") {
    throw new HttpError(400, "modelId must be a string or null");
  }

  return { modelId };
}

function parsePutAdminChatModelOverrideBody(body: unknown): PutAdminChatModelOverrideRequest {
  const value = requireObject(body);

  return {
    enabled: requiredBoolean(value.enabled, "enabled")
  };
}

function requiredResolvableAssistantActionStatus(
  value: unknown
): Exclude<AiAssistantActionStatus, "pending"> {
  if (value === "confirmed" || value === "rejected" || value === "cancelled") {
    return value;
  }

  throw new HttpError(400, "status must be confirmed, rejected, or cancelled");
}

function serializeAssistantToolInvocation(
  tool: AiAssistantToolDto,
  status: AiAssistantToolInvocationDto["status"],
  result: Record<string, unknown> | null,
  blockedReason: AiAssistantToolBlockedReason | null,
  actionRequestId: string | null
): AiAssistantToolInvocationDto {
  return {
    moduleId: tool.moduleId,
    moduleName: tool.moduleName,
    name: tool.name,
    description: tool.description,
    permissionId: tool.permissionId,
    risk: tool.risk,
    status,
    blockedReason,
    actionRequestId,
    result
  };
}

function serializeAssistantAction(action: AiAssistantActionRequestSafeRow): AiAssistantActionDto {
  return {
    id: action.id,
    ownerUserId: action.owner_user_id,
    toolModuleId: action.tool_module_id,
    toolModuleName: action.tool_module_name,
    toolName: action.tool_name,
    permissionId: action.permission_id,
    risk: action.risk,
    status: action.status,
    inputSummary: action.input_summary,
    requestedAt: serializeDate(action.requested_at),
    resolvedAt: toIsoString(action.resolved_at),
    updatedAt: serializeDate(action.updated_at)
  };
}

export async function serializeProvider(
  provider: AiProviderConfigSafeRow
): Promise<AiProviderConfigDto> {
  const isCli = provider.auth_method === "cli";
  const isCliProvider = CLI_PROVIDER_KINDS.has(provider.provider_kind as CliProviderKind);
  const cliAvailableFlag =
    isCli && isCliProvider ? await cliAvailable(provider.provider_kind as CliProviderKind) : false;

  return {
    id: provider.id,
    providerKind: provider.provider_kind,
    displayName: provider.display_name,
    baseUrl: provider.base_url,
    status: provider.status,
    authMethod: provider.auth_method,
    executionMode: provider.execution_mode,
    hasCredential: isCli ? false : provider.has_credential,
    cliAvailable: cliAvailableFlag,
    // #870/H1: expose the single instance-default flag so the admin UI can render the radio state.
    isInstanceDefault: provider.is_instance_default,
    revokedAt: toIsoString(provider.revoked_at),
    createdAt: serializeDate(provider.created_at),
    updatedAt: serializeDate(provider.updated_at)
  };
}

function serializeChatModelOverrideSettings(
  settings: ChatModelOverrideSettings,
  actorUserId: string
) {
  return {
    overrideEnabled: settings.overrideEnabled,
    currentOverrideModelId: settings.currentOverrideModelId,
    effectiveOverrideModelId: settings.effectiveOverrideModelId,
    defaultModel: settings.defaultModel ? serializeModel(settings.defaultModel, actorUserId) : null,
    selectedModel: settings.selectedModel
      ? serializeModel(settings.selectedModel, actorUserId)
      : null,
    selectableOverrideModels: settings.selectableOverrideModels.map((m) =>
      serializeModel(m, actorUserId)
    )
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }

  return value as Record<string, unknown>;
}

function requiredJsonObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, fieldName: string): string {
  const parsed = optionalString(value, fieldName);

  if (!parsed) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  return parsed;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} must not be empty`);
  }

  return trimmed;
}

function optionalNullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === null) {
    return null;
  }

  return optionalString(value, fieldName);
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${fieldName} must be a boolean`);
  }

  return value;
}

function requiredBoolean(value: unknown, fieldName: string): boolean {
  const parsed = optionalBoolean(value, fieldName);
  if (parsed === undefined) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  return parsed;
}

function requiredProviderKind(value: unknown, fieldName: string): AiProviderKind {
  const providerKind = optionalProviderKind(value, fieldName);

  if (!providerKind) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  return providerKind;
}

function optionalProviderKind(value: unknown, fieldName: string): AiProviderKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !AI_PROVIDER_KINDS.has(value as AiProviderKind)) {
    throw new HttpError(400, `${fieldName} is not a supported AI provider kind`);
  }

  return value as AiProviderKind;
}

function optionalAuthMethod(value: unknown): AiAuthMethod | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && AUTH_METHODS.has(value as AiAuthMethod)) {
    return value as AiAuthMethod;
  }

  throw new HttpError(400, "authMethod must be cli or api_key");
}

function optionalExecutionMode(value: unknown): AiProviderExecutionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && EXECUTION_MODES.has(value as AiProviderExecutionMode)) {
    return value as AiProviderExecutionMode;
  }

  throw new HttpError(400, "executionMode must be interactive or non_interactive");
}

function optionalProviderStatus(value: unknown): Exclude<AiProviderStatus, "revoked"> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && WRITABLE_PROVIDER_STATUSES.has(value as never)) {
    return value as Exclude<AiProviderStatus, "revoked">;
  }

  throw new HttpError(400, "status must be active, error, or disabled");
}

function optionalModelStatus(value: unknown): AiModelStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && MODEL_STATUSES.has(value as AiModelStatus)) {
    return value as AiModelStatus;
  }

  throw new HttpError(400, "status must be active or disabled");
}

function optionalModelTier(value: unknown): AiModelTier | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && MODEL_TIERS.has(value as AiModelTier)) {
    return value as AiModelTier;
  }

  throw new HttpError(400, "tier must be reasoning, interactive, or economy");
}

function requiredCapabilities(value: unknown, fieldName: string): AiModelCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${fieldName} must be a non-empty array`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new HttpError(400, `${fieldName}[${index}] must be a string`);
    }

    return parseCapability(item);
  });
}

function parseCapability(value: string): AiModelCapability {
  if (MODEL_CAPABILITIES.has(value as AiModelCapability)) {
    return value as AiModelCapability;
  }

  throw new HttpError(400, "capability is not supported");
}

function serializeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function serializeAuditLogEntry(row: MossActionAuditLog): ActionAuditLogEntryDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    toolModuleId: row.tool_module_id,
    toolName: row.tool_name,
    actionFamilyId: row.action_family_id ?? null,
    actionKind: row.action_kind as "write" | "outbound" | "destructive",
    approvalMode: row.approval_mode as ActionAuditLogEntryDto["approvalMode"],
    outcome: row.outcome as ActionAuditLogEntryDto["outcome"],
    errorClass: row.error_class ?? null,
    requestId: row.request_id ?? null,
    chatSessionId: row.chat_session_id ?? null,
    sourceSurface: row.source_surface as ActionAuditLogEntryDto["sourceSurface"],
    inputSummary: row.input_summary as ActionAuditLogEntryDto["inputSummary"],
    durationMs: row.duration_ms ?? null,
    occurredAt:
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at)
  };
}

export function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    mappers: [
      (e, r) =>
        e instanceof ToolInputValidationError ? r.code(400).send({ error: e.message }) : undefined
    ],
    invalidRequestMessage: "AI configuration request is invalid"
  });
}

export async function assertInstanceAdmin(
  repository: AiRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<void> {
  const user = await repository.getUserById(scopedDb, userId);

  if (!user) {
    throw new HttpError(401, "Session is missing or expired");
  }
  if (!user.is_instance_admin) {
    throw new HttpError(403, "Instance admin permission is required");
  }
}
