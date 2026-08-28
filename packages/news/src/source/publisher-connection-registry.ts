// packages/news/src/source/publisher-connection-registry.ts
// #2008 — the port implementation that actually knows the reviewed connections.
//
// #2007 built the connection registry but left the composition root passing the do-nothing
// port, so no connection was reachable in the running product. This file closes that gap for
// the two LOOKUP questions only: "what is this connection?" and "does this homepage belong to
// one?". Both are pure reads over frozen constants in our own source; neither opens a socket.
//
// `validateKey` deliberately still answers "unsupported". Performing the real outbound check is
// new runtime behaviour and belongs to #2006.
import { createHostPinnedFetch } from "@moss/datasets";

import type {
  NewsConnectionDescriptor,
  NewsCredentialValidationOutcome,
  NewsPublisherConnectionPort
} from "../publisher-connection-port.js";

import { PUBLISHER_CONNECTIONS } from "./newsapi-connection.js";
import {
  CredentialedPublisherError,
  validateCredentialedPublisherKey
} from "./credentialed-source.js";
import type { PublisherConnection } from "./publisher-connection.js";

/**
 * The display-safe view of a connection. Everything about the request shape — the endpoint, the
 * header name, the query tables — is dropped here rather than filtered downstream, so a caller
 * cannot leak it by accident.
 *
 * A credentialed publisher has no RSS feed to poll: its items come from the pinned endpoint, so
 * the source row it creates records no feed address and a retrieval method of "scrape".
 */
function toDescriptor(connection: PublisherConnection): NewsConnectionDescriptor {
  return {
    connectionId: connection.id,
    publisherName: connection.publisherName,
    canonicalDomain: connection.canonicalDomain,
    homepageUrl: connection.homepageUrl,
    feedUrl: null,
    retrievalMethod: "scrape",
    host: new URL(connection.endpoint).hostname,
    accessSummary: connection.accessSummary,
    termsUrl: connection.termsUrl
  };
}

/**
 * Exact host match only. This answer is what decides whether News asks someone for a secret, so
 * anything short of "this is unmistakably that publisher's own homepage" must answer nothing: a
 * subdomain, a look-alike domain, a plain-http address or an unparseable string all fall through.
 */
function matchesConnection(connection: PublisherConnection, host: string): boolean {
  return host === connection.canonicalDomain || host === `www.${connection.canonicalDomain}`;
}

export function createRegistryNewsPublisherConnectionPort(
  deps: {
    readonly createFetch?: (
      hosts: readonly string[],
      options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number }
    ) => typeof fetch;
  } = {}
): NewsPublisherConnectionPort {
  const byId = new Map(PUBLISHER_CONNECTIONS.map((entry) => [entry.id, entry]));

  return {
    describe(connectionId: string): NewsConnectionDescriptor | undefined {
      const connection = byId.get(connectionId);
      return connection ? toDescriptor(connection) : undefined;
    },

    matchUrl(homepageUrl: string): NewsConnectionDescriptor | undefined {
      let parsed: URL;
      try {
        parsed = new URL(homepageUrl);
      } catch {
        return undefined;
      }
      if (parsed.protocol !== "https:") return undefined;
      const host = parsed.hostname.toLowerCase();
      const connection = PUBLISHER_CONNECTIONS.find((entry) => matchesConnection(entry, host));
      return connection ? toDescriptor(connection) : undefined;
    },

    async validateKey(
      connectionId: string,
      apiKey: string
    ): Promise<NewsCredentialValidationOutcome> {
      const connection = byId.get(connectionId);
      if (!connection) return { ok: false, reason: "unsupported" };
      try {
        const fetchFn = (deps.createFetch ?? createHostPinnedFetch)(connection.fetchHosts, {
          timeoutMs: connection.timeoutMs,
          maxResponseBytes: connection.maxResponseBytes
        });
        await validateCredentialedPublisherKey(connection, apiKey, fetchFn);
        return { ok: true };
      } catch (error) {
        if (error instanceof CredentialedPublisherError) {
          return {
            ok: false,
            reason: error.failure === "authentication_failed" ? "rejected" : "unavailable"
          };
        }
        return { ok: false, reason: "unavailable" };
      }
    }
  };
}
