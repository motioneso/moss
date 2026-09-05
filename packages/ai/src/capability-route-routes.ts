import type { FastifyInstance, FastifyReply } from "fastify";

import type { DataContextDb } from "@moss/db";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import {
  AI_MODEL_CAPABILITIES,
  MODULE_WORKER_SERVICE_KEY,
  deleteAiServiceBindingRouteSchema,
  isModuleServiceKey,
  listAiServiceBindingsRouteSchema,
  lookupAiCapabilityRouteRouteSchema,
  putAiServiceBindingRouteSchema,
  setInstanceDefaultProviderRouteSchema,
  type AiModelCapability,
  type AiServiceBinding,
  type AiServiceKey
} from "@moss/shared";

import type { AiRepository } from "./repository.js";
import { type AiRoutesDependencies, serializeModel, serializeProvider } from "./routes.js";

type CapabilityParams = { readonly capability: string };
type ServiceParams = { readonly service: string };
type IdParams = { readonly id: string };

const MODEL_CAPABILITIES = new Set<AiModelCapability>(AI_MODEL_CAPABILITIES);
// #874 HIGH-2: Chat is the ONLY bindable service. Voice (STT) is no longer a per-service binding —
// it is configured as a dedicated instance-wide endpoint (see /api/ai/voice-endpoint) and resolves
// through its own `purpose='voice'` provider row, not the generic binding map. Slice-1 briefly
// bound `transcription` here; that read-through is dropped outright (no back-compat) so no assistant
// provider can be wired to Voice. Worker capabilities stay cross-provider automatic; #915 D6 adds
// module.* binding keys as admin routing knobs for structured module work.
const BINDABLE_SERVICES = new Set<AiModelCapability>(["chat"]);

export function registerAiServiceRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies,
  repository: AiRepository
): void {
  // Lookup remains — used by the composer / chat-drawer / settings subviews to resolve the effective
  // model + reason (including the new `needs-config`) for a given capability at request time.
  server.get<{ Params: CapabilityParams }>(
    "/api/ai/capability-route/:capability",
    { schema: lookupAiCapabilityRouteRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const capability = parseCapability(request.params.capability);
        const route = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.resolveModelForCapability(scopedDb, capability)
        );

        return {
          route: {
            capability,
            available: Boolean(route.model),
            reason: route.reason,
            model: route.model ? serializeModel(route.model, accessContext.actorUserId) : null
          }
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #870 Slice 1: the unified per-service binding map, replacing the old free-form per-capability
  // model routes. #874 HIGH-2: Chat is now the only bindable service (Voice moved to its own
  // dedicated endpoint), so this map carries a single `chat` entry.
  server.get(
    "/api/ai/service-bindings",
    { schema: listAiServiceBindingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const bindings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const result: Record<string, AiServiceBinding> = {};
            for (const service of BINDABLE_SERVICES) {
              const binding = await repository.getServiceBinding(scopedDb, service);
              if (binding) result[service] = binding;
            }
            // #915 D6: patternProperties in the response schema preserves these dynamic keys.
            Object.assign(result, await repository.listModuleServiceBindings(scopedDb));
            return result;
          }
        );

        return { bindings };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put<{ Params: ServiceParams }>(
    "/api/ai/services/:service/binding",
    { schema: putAiServiceBindingRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const service = parseBindableService(request.params.service);
        const binding = parsePutServiceBindingBody(request.body);

        const saved = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);

            // #915 D6: module-specific keys name installed modules. module.worker is generic.
            if (isModuleServiceKey(service) && service !== MODULE_WORKER_SERVICE_KEY) {
              const installedIds = dependencies.listInstalledModuleIds?.() ?? [];
              const namespace = service.slice("module.".length);
              if (
                !installedIds.some(
                  (moduleId) => namespace === moduleId || namespace.startsWith(`${moduleId}.`)
                )
              ) {
                throw new HttpError(400, "service does not reference an installed module");
              }
            }

            // Module structured work always requires json; chat keeps its own capability.
            if (binding.kind === "model") {
              const requiredCapability: AiModelCapability = isModuleServiceKey(service)
                ? "json"
                : service;
              const models = await repository.listModels(scopedDb);
              const valid = models.some(
                (model) =>
                  model.id === binding.modelId &&
                  model.status === "active" &&
                  model.provider_status === "active" &&
                  model.capabilities.includes(requiredCapability)
              );
              if (!valid) {
                throw new HttpError(400, "modelId must reference an active compatible model");
              }
            }

            return repository.setServiceBinding(
              scopedDb,
              service,
              binding,
              accessContext.actorUserId
            );
          }
        );

        return { service, binding: saved };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #915 D6: unbinding a module service returns it to automatic routing. Chat has no unbind.
  server.delete<{ Params: ServiceParams }>(
    "/api/ai/services/:service/binding",
    { schema: deleteAiServiceBindingRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const service = parseBindableService(request.params.service);
        if (!isModuleServiceKey(service)) {
          throw new HttpError(400, "only module service bindings can be deleted");
        }

        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
          await repository.deleteModuleServiceBinding(scopedDb, service, accessContext.actorUserId);
        });

        return { service };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #870/H1: promote a provider to the single instance-default (mutually-exclusive radio in the UI).
  server.put<{ Params: IdParams }>(
    "/api/ai/providers/:id/default",
    { schema: setInstanceDefaultProviderRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const provider = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertInstanceAdmin(repository, scopedDb, accessContext.actorUserId);
            const updated = await repository.setInstanceDefaultProvider(
              scopedDb,
              request.params.id
            );
            if (!updated) {
              throw new HttpError(404, "AI provider config not found");
            }
            return updated;
          }
        );

        return { provider: await serializeProvider(provider) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function parsePutServiceBindingBody(body: unknown): AiServiceBinding {
  const value = requireObject(body) as { binding?: unknown };
  const binding = requireObject(value.binding) as Record<string, unknown>;

  if (binding.kind === "mode") {
    const tier = binding.tier;
    if (tier !== "reasoning" && tier !== "interactive" && tier !== "economy") {
      throw new HttpError(400, "mode binding requires a valid tier");
    }
    return { kind: "mode", tier };
  }
  if (binding.kind === "model") {
    if (typeof binding.modelId !== "string" || binding.modelId.length === 0) {
      throw new HttpError(400, "model binding requires a modelId");
    }
    return { kind: "model", modelId: binding.modelId };
  }
  throw new HttpError(400, "binding.kind must be 'mode' or 'model'");
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }

  return value as Record<string, unknown>;
}

/** Shared by transcription-routes.ts so both routes recognize exactly the same capability set. */
export function parseCapability(value: string): AiModelCapability {
  if (MODEL_CAPABILITIES.has(value as AiModelCapability)) {
    return value as AiModelCapability;
  }

  throw new HttpError(400, "capability is not supported");
}

function parseBindableService(value: string): AiServiceKey {
  if (BINDABLE_SERVICES.has(value as AiModelCapability)) {
    return value as AiModelCapability;
  }
  if (isModuleServiceKey(value)) {
    return value;
  }
  throw new HttpError(400, "service is not bindable");
}

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    invalidRequestMessage: "AI configuration request is invalid"
  });
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
