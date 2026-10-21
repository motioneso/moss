import type { FastifyRequest } from "fastify";
import { CompanionAuthError, type MossAuthRuntime } from "@moss/auth";
import { HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import { RING_COMPANION_CREDENTIAL_PREFIX } from "@moss/shared";

/** Only recording import/voice receivers and the single-request read use this resolver. */
export function createRingRecordingResolver(
  auth: Pick<MossAuthRuntime, "ringDevices" | "resolveAccessContext">
) {
  return async (request: FastifyRequest) => {
    if (!request.headers.authorization?.startsWith(`Bearer ${RING_COMPANION_CREDENTIAL_PREFIX}`))
      return auth.resolveAccessContext(request);
    const path = request.url.split("?")[0] ?? "";
    const receiver =
      /^\/api\/meetings\/(?:recording-imports|recording-uploads|voice-enablement|voice-recordings)(?:\/|$)/.test(
        path
      );
    const voiceStatus =
      request.method === "GET" && /^\/api\/chat\/voice-requests\/[a-f0-9-]{36}$/.test(path);
    if (
      (!receiver && !voiceStatus) ||
      !auth.ringDevices ||
      request.headers[ACT_AS_GRANT_HEADER] !== undefined
    )
      throw new HttpError(403, "Open Moss to manage your account.");
    try {
      const actor = await auth.ringDevices.resolve({
        headers: request.headers,
        requestId: request.id
      });
      return { actorUserId: actor.actorUserId, requestId: actor.requestId };
    } catch (error) {
      if (error instanceof CompanionAuthError)
        throw new HttpError(error.httpStatus, "Reconnect this phone to Moss.");
      throw error;
    }
  };
}
