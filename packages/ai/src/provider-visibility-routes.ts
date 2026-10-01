import type { FastifyInstance } from "fastify";
import type { DataContextDb } from "@moss/db";

import {
  getAiSummaryRouteSchema,
  listAiConfiguredModelsRouteSchema,
  listAiProviderConfigsRouteSchema
} from "@moss/shared";

import { cliToolsDto, readCliToolVersions } from "./cli-tool-versions.js";
import type { AiSecretCipher } from "./crypto.js";
import { discoverAndPersistModels } from "./discover-and-persist-models.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import type { AiRepository } from "./repository.js";
import type { AiRoutesDependencies } from "./routes.js";
import {
  assertInstanceAdmin,
  handleRouteError,
  serializeModel,
  serializeProvider
} from "./routes.js";

export function registerProviderVisibilityRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies,
  repository: AiRepository,
  secretCipher: AiSecretCipher,
  modelDiscovery: ModelDiscoveryService
): void {
  server.get("/api/ai/summary", { schema: getAiSummaryRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const [hasPersonalAiProvider, defaultChatModel] =
        await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          Promise.all([
            repository.hasPersonalProvider(scopedDb, accessContext.actorUserId),
            repository.selectModelForCapability(scopedDb, "chat")
          ])
        );

      return {
        summary: {
          hasPersonalAiProvider,
          sharedAssistantAvailable: defaultChatModel !== undefined
        }
      };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/ai/providers",
    { schema: listAiProviderConfigsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const providers = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const providers = await repository.listProviders(scopedDb);
            await selfHealEmptyProviders(
              scopedDb,
              accessContext.actorUserId,
              providers,
              repository,
              secretCipher,
              modelDiscovery
            );
            return repository.listProviders(scopedDb);
          }
        );

        const versions = await readCliToolVersions(dependencies.cliToolVersionReader);
        return {
          providers: await Promise.all(
            providers.map((provider) => serializeProvider(provider, versions))
          ),
          ...(versions ? { openCodeCli: cliToolsDto(versions.opencode) } : {})
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/ai/models",
    { schema: listAiConfiguredModelsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const models = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const providers = await repository.listProviders(scopedDb);
            await selfHealEmptyProviders(
              scopedDb,
              accessContext.actorUserId,
              providers,
              repository,
              secretCipher,
              modelDiscovery
            );
            return repository.listModels(scopedDb);
          }
        );

        return { models: models.map((m) => serializeModel(m, accessContext.actorUserId, true)) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

/** #982/#869 D2: settings reads repair active providers whose connect-time probe produced no rows. */
async function selfHealEmptyProviders(
  scopedDb: DataContextDb,
  actorUserId: string,
  providers: Awaited<ReturnType<AiRepository["listProviders"]>>,
  repository: AiRepository,
  secretCipher: AiSecretCipher,
  modelDiscovery: ModelDiscoveryService
): Promise<void> {
  const models = await repository.listModels(scopedDb);
  const configured = new Set(models.map((model) => model.provider_config_id));
  for (const provider of providers) {
    if (provider.status !== "active" || configured.has(provider.id)) continue;
    try {
      const sealed = await repository.selectProviderWithCredential(scopedDb, provider.id);
      if (!sealed) continue;
      await discoverAndPersistModels(
        scopedDb,
        {
          actorUserId,
          providerId: provider.id,
          providerKind: provider.provider_kind,
          acpAgentId: provider.acp_agent_id,
          authMethod: provider.auth_method,
          baseUrl: provider.base_url,
          credential:
            provider.auth_method === "cli"
              ? { cli: true }
              : secretCipher.decryptJson(sealed.encrypted_credential)
        },
        { repository, modelDiscovery }
      );
    } catch {
      // #982: list endpoints are read-shaped UX; discovery failure must never make settings fail.
    }
  }
}
