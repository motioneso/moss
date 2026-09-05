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
import type { PgBoss } from "pg-boss";

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
import { triggerNewsRefresh, type NewsPersonalizationStore } from "./personalization-routes.js";
import { deriveFetchHosts } from "./source/workaround.js";
import type {
  NewsConnectionDescriptor,
  NewsCredentialValidationOutcome,
  NewsPublisherConnectionPort
} from "./publisher-connection-port.js";

/** Only the two source methods this file needs, so a test fake stays small. */
export type NewsCredentialSourceStore = Pick<
  NewsPersonalizationStore,
  | "createCustomSource"
  | "listCustomSources"
  | "pruneSnapshotDomain"
  | "updateSourceHealth"
  | "bumpRefreshRequest"
  | "countCustomSources"
  | "countCustomTopics"
>;

export interface NewsCredentialRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly cipher: NewsCredentialCipherPort;
  readonly connections: NewsPublisherConnectionPort;
  readonly sources: NewsCredentialSourceStore;
  readonly boss?: PgBoss | null;
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
  display: { readonly publisherName: string; readonly requestHost: string | null }
): NewsSourceCredentialStatusDto {
  return {
    sourceId: row.sourceId,
    connectionId: row.connectionId,
    publisherName: display.publisherName,
    requestHost: display.requestHost,
    status: row.status,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null
  };
}

/**
 * How a stored credential is described on screen.
 *
 * The name falls back to the connection id when the connection is no longer declared, so a
 * stored credential stays readable rather than rendering an empty name. The host has no such
 * fallback: it is either the reviewed connection's own request host or nothing, because a
 * guessed host would turn "your key is sent only to X" into a false promise.
 */
function displayFor(
  connections: NewsPublisherConnectionPort,
  connectionId: string
): { readonly publisherName: string; readonly requestHost: string | null } {
  const descriptor = connections.describe(connectionId);
  return {
    publisherName: descriptor?.publisherName ?? connectionId,
    requestHost: descriptor?.host ?? null
  };
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
      // #2282: the key goes to descriptor.host, so that host plus the publisher's own pages
      // are the only places this source may be fetched from. Icons arrive with Task 1.6.
      confirmedFetchHosts: deriveFetchHosts([descriptor.homepageUrl, descriptor.feedUrl], [
        descriptor.host
      ]),
      iconUrl: null,
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
            await sources.updateSourceHealth(db, source.id, "healthy");
            await triggerNewsRefresh(
              db,
              sources,
              dependencies.boss ?? null,
              accessContext.actorUserId
            );
            return { source, row };
          }
        );

        reply.code(201);
        return {
          source: created.source,
          credential: toStatusDto(created.row, {
            publisherName: descriptor.publisherName,
            requestHost: descriptor.host
          }),
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

        const existing = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const [credential, source] = await Promise.all([
              credentials.readStatuses(db).then((rows) => rows.find((row) => row.sourceId === id)),
              sources.listCustomSources(db).then((rows) => rows.find((row) => row.id === id))
            ]);
            return credential && source ? { credential, source } : null;
          }
        );
        if (!existing) throw new HttpError(404, "No stored key for this source");

        // Validate the candidate first. On failure the stored row is left completely
        // untouched, so a typo cannot destroy a working key.
        const outcome = await validateKeySafely(
          connections,
          existing.credential.connectionId,
          input.apiKey
        );
        if (!outcome.ok) throw validationFailure(outcome.reason);

        const envelope = cipher.encrypt({ apiKey: input.apiKey });
        const rotated = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const result = await credentials.rotateCredential(db, id, envelope);
            if (!result) return null;
            await sources.updateSourceHealth(db, id, "healthy");
            await triggerNewsRefresh(
              db,
              sources,
              dependencies.boss ?? null,
              accessContext.actorUserId,
              () => sources.pruneSnapshotDomain(db, existing.source.canonicalDomain)
            );
            return result;
          }
        );
        if (!rotated) throw new HttpError(404, "No stored key for this source");

        return {
          credential: toStatusDto(rotated.row, displayFor(connections, rotated.row.connectionId)),
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
        const source = await dependencies.dataContext.withDataContext(accessContext, async (db) =>
          (await sources.listCustomSources(db)).find((row) => row.id === id)
        );
        if (!source) throw new HttpError(404, "News source not found");
        const revoked = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const result = await credentials.revokeCredential(db, id);
            if (!result) return null;
            await sources.updateSourceHealth(db, id, "disabled");
            await triggerNewsRefresh(
              db,
              sources,
              dependencies.boss ?? null,
              accessContext.actorUserId,
              () => sources.pruneSnapshotDomain(db, source.canonicalDomain)
            );
            return result;
          }
        );
        if (!revoked) throw new HttpError(404, "No stored key for this source");
        return {
          credential: toStatusDto(revoked, displayFor(connections, revoked.connectionId)),
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
            toStatusDto(row, displayFor(connections, row.connectionId))
          )
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
