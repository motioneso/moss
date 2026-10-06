import { Ajv } from "ajv";
import type { FastifyInstance } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  meetingCapturePreferencesSchema,
  updateMeetingCapturePreferencesSchema,
  type UpdateMeetingCapturePreferences
} from "@moss/shared";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import { MeetingPreferencesRepository } from "./preferences.js";
import { MeetingCaptureError } from "./capture-domain.js";
export { MEETING_CAPTURE_DEFAULT_KEY, MEETING_CAPTURE_SOURCE_KEY } from "./preferences.js";
const validator = new Ajv({ removeAdditional: false, coerceTypes: false, strict: false });
validator.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export function registerMeetingPreferenceRoutes(
  server: FastifyInstance,
  dependencies: MeetingRecordRoutesDependencies
): void {
  const preferences = new MeetingPreferencesRepository(dependencies.preferences);
  server.get(
    "/api/meetings/preferences",
    { schema: { response: { 200: meetingCapturePreferencesSchema } } },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) => preferences.get(db));
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  server.put<{ Body: UpdateMeetingCapturePreferences }>(
    "/api/meetings/preferences",
    {
      validatorCompiler: ({ schema }) => validator.compile(schema as object),
      schema: {
        body: updateMeetingCapturePreferencesSchema,
        response: { 200: meetingCapturePreferencesSchema }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) =>
          preferences.update(db, request.body)
        );
      } catch (error) {
        if (error instanceof MeetingCaptureError)
          return reply.code(error.httpStatus).send({ code: error.code });
        return handleRouteError(error, reply);
      }
    }
  );
}
