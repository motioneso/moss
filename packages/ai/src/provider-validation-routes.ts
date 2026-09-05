import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import {
  aiDiscoverModelsRouteSchema,
  discoverAiProviderModelsRouteSchema,
  refreshAiProviderModelsRouteSchema,
  testAiProviderConfigRouteSchema
} from "@moss/shared";

import type { AiSecretCipher } from "./crypto.js";
import { discoverAndPersistModels } from "./discover-and-persist-models.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import { discoverProviderModels, testProviderCredential } from "./provider-validation.js";
import type { AiRepository } from "./repository.js";
import { serializeModel } from "./serialize-model.js";

interface IdParams {
  readonly id: string;
}

export interface AiProviderValidationRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository: AiRepository;
  readonly secretCipher: AiSecretCipher;
  readonly modelDiscovery: ModelDiscoveryService;
}

export function registerAiProviderValidationRoutes(
  server: FastifyInstance,
  dependencies: AiProviderValidationRouteDependencies
): void {
  server.post<{ Params: IdParams }>(
    "/api/ai/providers/:id/test",
    { schema: testAiProviderConfigRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const provider = await loadTestableProvider(
              dependencies,
              scopedDb,
              accessContext,
              request.params.id
            );
            return testProviderCredential({
              providerKind: provider.provider_kind,
              authMethod: provider.auth_method,
              baseUrl: provider.base_url,
              credential: dependencies.secretCipher.decryptJson(provider.encrypted_credential)
            });
          }
        );

        return { result };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: IdParams }>(
    "/api/ai/providers/:id/discover-models",
    { schema: discoverAiProviderModelsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const models = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const provider = await loadTestableProvider(
              dependencies,
              scopedDb,
              accessContext,
              request.params.id
            );
            return discoverProviderModels({
              providerKind: provider.provider_kind,
              authMethod: provider.auth_method,
              baseUrl: provider.base_url,
              credential: dependencies.secretCipher.decryptJson(provider.encrypted_credential)
            });
          }
        );

        return { models };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: IdParams }>(
    "/api/ai/providers/:id/models/discover",
    { schema: aiDiscoverModelsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const provider = await loadTestableProvider(
              dependencies,
              scopedDb,
              accessContext,
              request.params.id
            );
            const cacheKey = `${accessContext.actorUserId}:${provider.id}`;
            return dependencies.modelDiscovery.discoverModels(cacheKey, {
              providerKind: provider.provider_kind,
              authMethod: provider.auth_method,
              baseUrl: provider.base_url,
              credential: dependencies.secretCipher.decryptJson(provider.encrypted_credential)
            });
          }
        );

        return {
          models: result.models.map((m) => ({
            ...m,
            fromCache: result.fromCache,
            fromFallback: result.fromFallback
          })),
          fromFallback: result.fromFallback,
          cacheExpiresAt: result.cacheExpiresAt
            ? new Date(result.cacheExpiresAt).toISOString()
            : null,
          // #2208: surface why a CLI provider listed nothing so Settings can say so in plain English.
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.message !== undefined ? { message: result.message } : {})
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #2208: admin "Refresh models". Drops the cached list, asks the vendor again (CLI providers go
  // through the runner), persists the answer, and returns the provider's rows as now stored.
  // When the list could not be fetched nothing changes and `reason` says why.
  server.post<{ Params: IdParams }>(
    "/api/ai/providers/:id/models/refresh",
    { schema: refreshAiProviderModelsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const provider = await loadTestableProvider(
              dependencies,
              scopedDb,
              accessContext,
              request.params.id
            );
            dependencies.modelDiscovery.invalidate(accessContext.actorUserId, provider.id);
            const outcome = await discoverAndPersistModels(
              scopedDb,
              {
                actorUserId: accessContext.actorUserId,
                providerId: provider.id,
                providerKind: provider.provider_kind,
                authMethod: provider.auth_method,
                baseUrl: provider.base_url,
                credential: dependencies.secretCipher.decryptJson(provider.encrypted_credential)
              },
              { repository: dependencies.repository, modelDiscovery: dependencies.modelDiscovery }
            );
            const models = (await dependencies.repository.listModels(scopedDb)).filter(
              (model) => model.provider_config_id === provider.id
            );
            return { models, outcome };
          }
        );

        return {
          models: result.models.map((model) => serializeModel(model, accessContext.actorUserId)),
          ...(result.outcome.reason !== undefined ? { reason: result.outcome.reason } : {}),
          ...(result.outcome.message !== undefined ? { message: result.outcome.message } : {})
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

async function loadTestableProvider(
  dependencies: AiProviderValidationRouteDependencies,
  scopedDb: DataContextDb,
  accessContext: AccessContext,
  providerId: string
) {
  await assertInstanceAdmin(dependencies.repository, scopedDb, accessContext.actorUserId);
  const provider = await dependencies.repository.selectProviderWithCredential(scopedDb, providerId);
  if (!provider) {
    throw new HttpError(404, "AI provider config not found");
  }
  // #886 MED-2: the test / discovery probes run a live /models (or auth) call against the provider's
  // host. The voice endpoint must never be reachable from these generic routes — otherwise an admin
  // could aim a discovery probe at the STT host. Treat the voice row as absent on this surface (404).
  // This also closes the discovery NIT: no auto-discovery can ever run against the voice endpoint.
  if (provider.purpose !== "assistant") {
    throw new HttpError(404, "AI provider config not found");
  }
  if (provider.status === "revoked") {
    throw new HttpError(400, "AI provider config is revoked");
  }
  return provider;
}

async function assertInstanceAdmin(
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

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    invalidRequestMessage: "AI configuration request is invalid"
  });
}
