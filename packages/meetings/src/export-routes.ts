import type { FastifyInstance } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  getMeetingRecordSchema,
  exportMeetingOutputSchema,
  type ExportMeetingOutputInput
} from "@moss/shared";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import type { MeetingExportService } from "./export-service.js";
import { MeetingOutputError } from "./output-repository.js";

export function registerMeetingExportRoutes(
  server: FastifyInstance,
  dependencies: Pick<MeetingRecordRoutesDependencies, "resolveAccessContext"> & {
    readonly exports: Pick<MeetingExportService, "save" | "list">;
  }
): void {
  server.get<{ Params: { id: string } }>(
    "/api/meetings/records/:id/exports",
    { schema: getMeetingRecordSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return { receipts: await dependencies.exports.list(actor, request.params.id) };
      } catch (error) {
        if (error instanceof MeetingOutputError)
          return reply.code(error.statusCode).send({ code: error.code });
        return handleRouteError(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: ExportMeetingOutputInput }>(
    "/api/meetings/records/:id/exports",
    { schema: exportMeetingOutputSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const receipt = await dependencies.exports.save(actor, request.params.id, request.body);
        return reply
          .code(receipt.errorCode === "meeting_vault_conflict" ? 409 : 200)
          .send({ receipt });
      } catch (error) {
        if (error instanceof MeetingOutputError)
          return reply.code(error.statusCode).send({ code: error.code });
        return handleRouteError(error, reply);
      }
    }
  );
}
