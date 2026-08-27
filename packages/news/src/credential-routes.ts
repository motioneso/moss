// packages/news/src/credential-routes.ts
// #2005 — create/replace/revoke/status for a user's own publisher access key.
//
// SECURITY POSTURE (this file is the whole attack surface for the key):
//  - The key arrives in a request body bounded by a schema and leaves this file only by
//    being handed to the injected cipher or the injected validator. It is never logged,
//    never placed in an error, and never returned.
//  - Every response is built field by field from metadata. No row is ever spread into a
//    response, so a future column cannot leak by accident.
//  - A validator that throws is converted to the "could not be reached" outcome, so a
//    provider's own error message can never travel upward carrying the key.
//  - These routes sit behind the news.credentials permission, which no assistant tool
//    holds, and no assistant tool is registered for credentials.
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import {
  connectNewsCredentialedSourceSchema,
  listNewsSourceCredentialsSchema,
  replaceNewsSourceCredentialSchema,
  revokeNewsSourceCredentialSchema,
  NEWS_CREDENTIAL_MESSAGES,
  type ConnectNewsCredentialedSourceRequest,
  type NewsCustomSourceDto,
  type NewsSourceCredentialStatusDto,
  type ReplaceNewsSourceCredentialRequest
} from "@moss/shared";

import type { NewsCredentialCipherPort } from "./credential-cipher-port.js";
import {
  NewsCredentialRepository,
  type NewsCredentialStatusRow,
  type NewsCredentialStore
} from "./credential-repository.js";
import {
  NewsDuplicateSourceError,
  NewsPersonalizationLimitError
} from "./personalization-repository.js";
import type { NewsPersonalizationStore } from "./personalization-routes.js";
import type {
  NewsConnectionDescriptor,
  NewsCredentialValidationOutcome,
  NewsPublisherConnectionPort
} from "./publisher-connection-port.js";

/** Only the two source methods this file needs, so a test fake stays small. */
export type NewsCredentialSourceStore = Pick<
  NewsPersonalizationStore,
  "createCustomSource" | "listCustomSources"
>;

export interface NewsCredentialRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly cipher: NewsCredentialCipherPort;
  readonly connections: NewsPublisherConnectionPort;
  readonly sources: NewsCredentialSourceStore;
  readonly credentials?: NewsCredentialStore;
}

/** HTTP status per failure reason. Rejected is 422: the request was well formed. */
const validationFailureStatus: Record<"unsupported" | "rejected" | "unavailable", number> = {
  unsupported: 400,
  rejected: 422,
  unavailable: 502
};

function validationFailure(reason: "unsupported" | "rejected" | "unavailable"): HttpError {
  return new HttpError(validationFailureStatus[reason], NEWS_CREDENTIAL_MESSAGES[reason]);
}

/**
 * Runs the injected validator and flattens every failure mode, including a thrown one,
 * into the typed outcome. A throw becomes "unavailable" and its message is discarded
 * rather than propagated: a provider client that interpolated the key into its error
 * would otherwise write the key into the request log.
 */
async function validateKeySafely(
  connections: NewsPublisherConnectionPort,
  connectionId: string,
  apiKey: string
): Promise<NewsCredentialValidationOutcome> {
  try {
    return await connections.validateKey(connectionId, apiKey);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Built field by field: a row is never spread into a response. */
function toStatusDto(
  row: NewsCredentialStatusRow,
  publisherName: string
): NewsSourceCredentialStatusDto {
  return {
    sourceId: row.sourceId,
    connectionId: row.connectionId,
    publisherName,
    status: row.status,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null
  };
}

/**
 * The publisher's display name, or the connection id when #2007 has not defined that
 * connection. Falling back to the id keeps a stored credential readable after a
 * connection is withdrawn, rather than rendering an empty name.
 */
function publisherNameFor(connections: NewsPublisherConnectionPort, connectionId: string): string {
  return connections.describe(connectionId)?.publisherName ?? connectionId;
}

/** Stable fingerprint so the source row records which connection vouched for it. */
function connectionFingerprint(connectionId: string): string {
  return `connection:${connectionId}:v1`;
}

function mapSourceWriteError(error: unknown): never {
  if (error instanceof NewsPersonalizationLimitError) throw new HttpError(400, error.message);
  if (error instanceof NewsDuplicateSourceError) throw new HttpError(409, error.message);
  throw error;
}

async function createSourceForConnection(
  scopedDb: DataContextDb,
  sources: NewsCredentialSourceStore,
  descriptor: NewsConnectionDescriptor
): Promise<NewsCustomSourceDto> {
  try {
    // Routed through the existing creator so the per-user source cap and the duplicate
    // publisher rule keep working unchanged.
    return await sources.createCustomSource(scopedDb, {
      label: descriptor.publisherName,
      canonicalDomain: descriptor.canonicalDomain,
      homepageUrl: descriptor.homepageUrl,
      feedUrl: descriptor.feedUrl,
      retrievalMethod: descriptor.retrievalMethod,
      validationFingerprint: connectionFingerprint(descriptor.connectionId)
    });
  } catch (error) {
    return mapSourceWriteError(error);
  }
}

export function registerNewsCredentialRoutes(
  server: FastifyInstance,
  dependencies: NewsCredentialRouteDependencies
): void {
  const credentials: NewsCredentialStore =
    dependencies.credentials ?? new NewsCredentialRepository();
  const { connections, cipher, sources } = dependencies;

  server.post(
    "/api/news/sources/credentialed",
    { schema: connectNewsCredentialedSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as ConnectNewsCredentialedSourceRequest;

        const descriptor = connections.describe(input.connectionId);
        if (!descriptor) throw validationFailure("unsupported");

        // Validate BEFORE opening the write, so a bad key never creates a source row.
        const outcome = await validateKeySafely(connections, input.connectionId, input.apiKey);
        if (!outcome.ok) throw validationFailure(outcome.reason);

        const envelope = cipher.encrypt({ apiKey: input.apiKey });
        // withDataContext is one transaction: the source and the credential commit
        // together or not at all.
        const created = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const source = await createSourceForConnection(db, sources, descriptor);
            const row = await credentials.insertCredential(db, {
              sourceId: source.id,
              connectionId: descriptor.connectionId,
              envelope
            });
            return { source, row };
          }
        );

        reply.code(201);
        return {
          source: created.source,
          credential: toStatusDto(created.row, descriptor.publisherName),
          message: NEWS_CREDENTIAL_MESSAGES.connected
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/news/sources/:id/credential",
    { schema: replaceNewsSourceCredentialSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const input = request.body as ReplaceNewsSourceCredentialRequest;

        const existing = await dependencies.dataContext.withDataContext(accessContext, async (db) =>
          (await credentials.readStatuses(db)).find((row) => row.sourceId === id)
        );
        if (!existing) throw new HttpError(404, "No stored key for this source");

        // Validate the candidate first. On failure the stored row is left completely
        // untouched, so a typo cannot destroy a working key.
        const outcome = await validateKeySafely(connections, existing.connectionId, input.apiKey);
        if (!outcome.ok) throw validationFailure(outcome.reason);

        const envelope = cipher.encrypt({ apiKey: input.apiKey });
        const rotated = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          credentials.rotateCredential(db, id, envelope)
        );
        if (!rotated) throw new HttpError(404, "No stored key for this source");

        return {
          credential: toStatusDto(
            rotated.row,
            publisherNameFor(connections, rotated.row.connectionId)
          ),
          message: NEWS_CREDENTIAL_MESSAGES.connected
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/news/sources/:id/credential",
    { schema: revokeNewsSourceCredentialSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const revoked = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          credentials.revokeCredential(db, id)
        );
        if (!revoked) throw new HttpError(404, "No stored key for this source");
        return {
          credential: toStatusDto(revoked, publisherNameFor(connections, revoked.connectionId)),
          message: NEWS_CREDENTIAL_MESSAGES.revoked
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/news/credentials",
    { schema: listNewsSourceCredentialsSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const rows = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          credentials.readStatuses(db)
        );
        return {
          credentials: rows.map((row) =>
            toStatusDto(row, publisherNameFor(connections, row.connectionId))
          )
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
