import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  resolveMossEnv,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner,
  type User
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import {
  getPersonaSettingsRouteSchema,
  normalizePersonaSettings,
  parsePositiveIntEnv,
  previewPersonaRouteSchema,
  putPersonaSettingsRouteSchema,
  type PreviewPersonaRequest,
  type PutPersonaSettingsRequest
} from "@moss/shared";

import type { ProfilePreferencesPort, PersonaPreviewInput } from "./preferences-port.js";
import type { SettingsRepository } from "./repository.js";
import { handleSettingsRouteError } from "./route-error.js";

const PERSONA_PREFERENCE_KEY = "persona.bundle";
const PERSONA_PREVIEW_MAX = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_RL_PERSONA_PREVIEW_MAX"),
  10
);

interface PersonaRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: ProfilePreferencesPort;
  readonly repository: SettingsRepository;
  readonly personaPreview?: (input: PersonaPreviewInput) => Promise<string>;
}

export function registerPersonaRoutes(
  server: FastifyInstance,
  dependencies: PersonaRoutesDependencies
): void {
  server.get(
    "/api/me/persona",
    { schema: getPersonaSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const persona = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await requireKnownUser(dependencies.repository, scopedDb, accessContext.actorUserId);
            return normalizePersonaSettings(
              await dependencies.preferencesRepository.get(scopedDb, PERSONA_PREFERENCE_KEY)
            );
          }
        );
        return { persona };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/me/persona",
    { schema: putPersonaSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PutPersonaSettingsRequest;
        const persona = normalizePersonaSettings(body.persona);
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await requireKnownUser(dependencies.repository, scopedDb, accessContext.actorUserId);
          await dependencies.preferencesRepository.upsert(
            scopedDb,
            PERSONA_PREFERENCE_KEY,
            persona
          );
        });
        return { persona };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/me/persona/preview",
    {
      schema: previewPersonaRouteSchema,
      config: {
        rateLimit: {
          max: PERSONA_PREVIEW_MAX,
          timeWindow: "1 minute",
          keyGenerator: sessionRateLimitKey
        }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PreviewPersonaRequest;
        const persona = normalizePersonaSettings(body.persona);
        const user = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          requireKnownUser(dependencies.repository, scopedDb, accessContext.actorUserId)
        );
        if (!dependencies.personaPreview) {
          throw new HttpError(503, "Persona preview is not configured");
        }
        const replyText = await dependencies.personaPreview({
          actorUserId: accessContext.actorUserId,
          userName: user.name,
          assistantName: persona.assistantName,
          personaText: persona.personaText
        });
        return { reply: replyText };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

async function requireKnownUser(
  repository: SettingsRepository,
  scopedDb: DataContextDb,
  userId: string
): Promise<User> {
  const user = await repository.getUserById(scopedDb, userId);

  if (!user) {
    throw new HttpError(401, "Session is missing or expired");
  }

  return user;
}
