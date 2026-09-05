import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner, EncryptedSecret } from "@moss/db";
import { NEWS_CREDENTIAL_MESSAGES, type NewsCustomSourceDto } from "@moss/shared";

import type { NewsCredentialCipherPort } from "../../packages/news/src/credential-cipher-port.js";
import type {
  NewsCredentialStatusRow,
  NewsCredentialStore
} from "../../packages/news/src/credential-repository.js";
import {
  registerNewsCredentialRoutes,
  type NewsCredentialRouteDependencies,
  type NewsCredentialSourceStore
} from "../../packages/news/src/credential-routes.js";
import { NewsPersonalizationLimitError } from "../../packages/news/src/personalization-repository.js";
import type {
  NewsConnectionDescriptor,
  NewsCredentialValidationOutcome,
  NewsPublisherConnectionPort
} from "../../packages/news/src/publisher-connection-port.js";

/**
 * #2005 — the four publisher-key routes with fake ports.
 *
 * The point of this file is the order of operations and what leaves on the wire: a key is
 * checked before anything is written, a rejected key never disturbs a stored one, and no
 * response, error or log line can carry the key, the encrypted envelope or the counter that
 * tracks replacements. Every assertion goes through app.inject so the response schema —
 * which is what actually strips undeclared fields — is exercised too.
 */

const ACTOR: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-cred"
};

const SOURCE_ID = "33333333-3333-3333-3333-333333333333";
const SUBMITTED_KEY = "super-secret-publisher-key-marker";

const DESCRIPTOR: NewsConnectionDescriptor = {
  connectionId: "example-wire",
  publisherName: "Example Wire",
  canonicalDomain: "wire.example.com",
  homepageUrl: "https://wire.example.com",
  feedUrl: null,
  retrievalMethod: "scrape",
  host: "api.wire.example.com",
  accessSummary: "Reads the Example Wire headline list.",
  termsUrl: "https://wire.example.com/terms"
};

const ENVELOPE: EncryptedSecret = {
  version: 1,
  algorithm: "aes-256-gcm",
  iv: "aXY=",
  tag: "dGFn",
  ciphertext: "Y2lwaGVydGV4dC1tYXJrZXI="
};

const CREATED_SOURCE: NewsCustomSourceDto = {
  id: SOURCE_ID,
  label: "Example Wire",
  canonicalDomain: "wire.example.com",
  homepageUrl: "https://wire.example.com",
  feedUrl: null,
  retrievalMethod: "scrape",
  workaround: false,
  validationStatus: "approved",
  healthStatus: "healthy",
  createdAt: "2026-08-27T09:00:00.000Z"
};

/** Records what the routes asked for, and how many separate transactions they opened. */
interface Recorder {
  readonly transactions: string[][];
  readonly encrypted: string[];
  readonly validated: string[];
}

function makeRecorder(): Recorder {
  return { transactions: [], encrypted: [], validated: [] };
}

function makeDataContext(recorder: Recorder): DataContextRunner {
  return {
    withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
      const writes: string[] = [];
      recorder.transactions.push(writes);
      return work({ writes } as unknown as DataContextDb);
    }
  } as unknown as DataContextRunner;
}

function trackWrite(db: DataContextDb, what: string): void {
  (db as unknown as { writes: string[] }).writes.push(what);
}

function makeCipher(recorder: Recorder): NewsCredentialCipherPort {
  return {
    encrypt: (secret) => {
      recorder.encrypted.push(secret.apiKey);
      return ENVELOPE;
    },
    decrypt: () => ({ apiKey: "unused-in-this-slice" })
  };
}

function makeConnections(
  recorder: Recorder,
  options: {
    known?: boolean;
    outcome?: NewsCredentialValidationOutcome;
    throws?: Error;
  } = {}
): NewsPublisherConnectionPort {
  return {
    describe: (connectionId) =>
      options.known === false || connectionId !== DESCRIPTOR.connectionId ? undefined : DESCRIPTOR,
    matchUrl: (homepageUrl) =>
      options.known === false || homepageUrl !== DESCRIPTOR.homepageUrl ? undefined : DESCRIPTOR,
    validateKey: async (_connectionId, apiKey) => {
      recorder.validated.push(apiKey);
      if (options.throws) throw options.throws;
      return options.outcome ?? { ok: true };
    }
  };
}

interface FakeSources extends NewsCredentialSourceStore {
  created: number;
}

function makeSources(recorder: Recorder, failWith?: Error): FakeSources {
  const sources: FakeSources = {
    created: 0,
    listCustomSources: async () => [CREATED_SOURCE],
    createCustomSource: async (db) => {
      if (failWith) throw failWith;
      sources.created += 1;
      trackWrite(db, "source");
      return CREATED_SOURCE;
    },
    countCustomSources: async () => 0,
    countCustomTopics: async () => 0,
    bumpRefreshRequest: async (db) => {
      trackWrite(db, "refresh");
      return 1;
    },
    pruneSnapshotDomain: async (db) => trackWrite(db, "prune"),
    updateSourceHealth: async (db, _sourceId, health) => trackWrite(db, `health:${health}`)
  };
  return sources;
}

/** In-memory credential store that keeps a generation counter and the stored envelope. */
interface FakeCredentials extends NewsCredentialStore {
  state: {
    row: NewsCredentialStatusRow | null;
    envelope: EncryptedSecret | null;
    generation: number;
  };
  inserted: number;
}

function makeCredentials(seeded = false): FakeCredentials {
  const store: FakeCredentials = {
    inserted: 0,
    state: {
      row: seeded
        ? {
            sourceId: SOURCE_ID,
            connectionId: DESCRIPTOR.connectionId,
            status: "configured",
            lastValidatedAt: new Date("2026-08-20T09:00:00.000Z"),
            revokedAt: null
          }
        : null,
      envelope: seeded ? { ...ENVELOPE, ciphertext: "b3JpZ2luYWwta2V5" } : null,
      generation: 1
    },
    readStatuses: async () => (store.state.row ? [store.state.row] : []),
    readEnvelope: async () => store.state.envelope,
    insertCredential: async (db, input) => {
      store.inserted += 1;
      trackWrite(db, "credential");
      store.state.envelope = input.envelope;
      store.state.row = {
        sourceId: input.sourceId,
        connectionId: input.connectionId,
        status: "configured",
        lastValidatedAt: new Date("2026-08-27T09:00:00.000Z"),
        revokedAt: null
      };
      return store.state.row;
    },
    rotateCredential: async (_db, sourceId, envelope) => {
      if (!store.state.row || store.state.row.sourceId !== sourceId) return null;
      store.state.envelope = envelope;
      store.state.generation += 1;
      store.state.row = {
        ...store.state.row,
        status: "configured",
        lastValidatedAt: new Date("2026-08-27T11:00:00.000Z"),
        revokedAt: null
      };
      return { generation: String(store.state.generation), row: store.state.row };
    },
    revokeCredential: async (_db, sourceId) => {
      if (!store.state.row || store.state.row.sourceId !== sourceId) return null;
      store.state.envelope = null;
      store.state.row = {
        ...store.state.row,
        status: "revoked",
        // Mirrors the repository's COALESCE: a repeat revoke keeps the first time.
        revokedAt: store.state.row.revokedAt ?? new Date("2026-08-27T12:00:00.000Z")
      };
      return store.state.row;
    }
  };
  return store;
}

function buildApp(
  overrides: {
    recorder?: Recorder;
    connections?: NewsPublisherConnectionPort;
    sources?: FakeSources;
    credentials?: FakeCredentials;
  } = {}
) {
  const recorder = overrides.recorder ?? makeRecorder();
  const sources = overrides.sources ?? makeSources(recorder);
  const credentials = overrides.credentials ?? makeCredentials();
  const app = Fastify();
  const dependencies: NewsCredentialRouteDependencies = {
    dataContext: makeDataContext(recorder),
    resolveAccessContext: async () => ACTOR,
    cipher: makeCipher(recorder),
    connections: overrides.connections ?? makeConnections(recorder),
    sources,
    boss: null,
    credentials
  };
  registerNewsCredentialRoutes(app, dependencies);
  return { app, recorder, sources, credentials };
}

async function connect(app: ReturnType<typeof Fastify>, apiKey = SUBMITTED_KEY) {
  return app.inject({
    method: "POST",
    url: "/api/news/sources/credentialed",
    payload: { connectionId: DESCRIPTOR.connectionId, apiKey }
  });
}

describe("news credential routes (#2005)", () => {
  it("stores a key and reports status without ever echoing the key back", async () => {
    const { app, recorder, sources, credentials } = buildApp();
    await app.ready();

    const res = await connect(app);

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.message).toBe(NEWS_CREDENTIAL_MESSAGES.connected);
    expect(body.credential).toEqual({
      sourceId: SOURCE_ID,
      connectionId: DESCRIPTOR.connectionId,
      publisherName: DESCRIPTOR.publisherName,
      // The reviewed connection's own request host, not the publication's domain.
      requestHost: DESCRIPTOR.host,
      status: "configured",
      lastValidatedAt: "2026-08-27T09:00:00.000Z",
      revokedAt: null
    });
    expect(res.body).not.toContain(SUBMITTED_KEY);
    expect(res.body).not.toContain(ENVELOPE.ciphertext);
    expect(sources.created).toBe(1);
    expect(credentials.inserted).toBe(1);
    // The key was checked before it was encrypted, and encrypted before it was stored.
    expect(recorder.validated).toEqual([SUBMITTED_KEY]);
    expect(recorder.encrypted).toEqual([SUBMITTED_KEY]);
    await app.close();
  });

  it("writes the source and the key inside one transaction, so neither can be left behind", async () => {
    const { app, recorder } = buildApp();
    await app.ready();
    await connect(app);

    // Both writes in a single opened transaction. Splitting them would let a failure on
    // the second one leave a source row with no key attached to it.
    expect(recorder.transactions).toHaveLength(1);
    expect(recorder.transactions[0]).toEqual(["source", "credential", "health:healthy", "refresh"]);
    await app.close();
  });

  it("an unknown publisher is refused and nothing at all is written", async () => {
    const recorder = makeRecorder();
    const { app, sources, credentials } = buildApp({
      recorder,
      connections: makeConnections(recorder, { known: false })
    });
    await app.ready();

    const res = await connect(app);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: NEWS_CREDENTIAL_MESSAGES.unsupported });
    expect(sources.created).toBe(0);
    expect(credentials.inserted).toBe(0);
    expect(recorder.transactions).toHaveLength(0);
    // Nothing was even handed to the encryption step.
    expect(recorder.encrypted).toEqual([]);
    await app.close();
  });

  it("a key the publisher rejects leaves no source row behind", async () => {
    const recorder = makeRecorder();
    const { app, sources, credentials } = buildApp({
      recorder,
      connections: makeConnections(recorder, { outcome: { ok: false, reason: "rejected" } })
    });
    await app.ready();

    const res = await connect(app);

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe(NEWS_CREDENTIAL_MESSAGES.rejected);
    // A build that created the source first and checked the key afterwards would strand
    // an unusable source in the user's list.
    expect(sources.created).toBe(0);
    expect(credentials.inserted).toBe(0);
    expect(recorder.transactions).toHaveLength(0);
    await app.close();
  });

  it("a publisher that cannot be reached is reported as unavailable, not as a bad key", async () => {
    const recorder = makeRecorder();
    const { app } = buildApp({
      recorder,
      connections: makeConnections(recorder, { outcome: { ok: false, reason: "unavailable" } })
    });
    await app.ready();

    const res = await connect(app);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe(NEWS_CREDENTIAL_MESSAGES.unavailable);
    await app.close();
  });

  it("a checker that crashes while holding the key never puts it in the response", async () => {
    const recorder = makeRecorder();
    // The worst realistic case: a publisher client that pastes the key into its own error.
    const leaky = new Error(`request to https://api.wire.example.com?key=${SUBMITTED_KEY} failed`);
    const { app, sources } = buildApp({
      recorder,
      connections: makeConnections(recorder, { throws: leaky })
    });
    await app.ready();

    const res = await connect(app);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: NEWS_CREDENTIAL_MESSAGES.unavailable });
    expect(res.body).not.toContain(SUBMITTED_KEY);
    expect(sources.created).toBe(0);
    await app.close();
  });

  it("a source limit is reported as such rather than as a publisher problem", async () => {
    const recorder = makeRecorder();
    const limit = new NewsPersonalizationLimitError("custom_sources", 10);
    const { app } = buildApp({ recorder, sources: makeSources(recorder, limit) });
    await app.ready();

    const res = await connect(app);
    // The user hit their own source limit; saying "the publisher rejected your key" here
    // would send them off looking for a problem that is not there.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(limit.message);
    await app.close();
  });

  it("a rejected replacement leaves the stored key and the counter exactly as they were", async () => {
    const recorder = makeRecorder();
    const credentials = makeCredentials(true);
    const { app } = buildApp({
      recorder,
      credentials,
      connections: makeConnections(recorder, { outcome: { ok: false, reason: "rejected" } })
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/news/sources/${SOURCE_ID}/credential`,
      payload: { apiKey: "typo-key" }
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe(NEWS_CREDENTIAL_MESSAGES.rejected);
    // A build that replaced first and checked afterwards would have destroyed a working
    // key because of a typing mistake.
    expect(credentials.state.envelope?.ciphertext).toBe("b3JpZ2luYWwta2V5");
    expect(credentials.state.generation).toBe(1);
    expect(recorder.encrypted).toEqual([]);
    await app.close();
  });

  it("an accepted replacement advances the counter and reports no counter to the caller", async () => {
    const credentials = makeCredentials(true);
    const { app } = buildApp({ credentials });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/news/sources/${SOURCE_ID}/credential`,
      payload: { apiKey: "replacement-key" }
    });

    expect(res.statusCode).toBe(200);
    expect(credentials.state.generation).toBe(2);
    expect(credentials.state.envelope?.ciphertext).toBe(ENVELOPE.ciphertext);
    const body = JSON.parse(res.body);
    expect(body.message).toBe(NEWS_CREDENTIAL_MESSAGES.connected);
    expect(Object.keys(body.credential).sort()).toEqual([
      "connectionId",
      "lastValidatedAt",
      "publisherName",
      "requestHost",
      "revokedAt",
      "sourceId",
      "status"
    ]);
    expect(res.body).not.toContain("replacement-key");
    expect(res.body).not.toContain("generation");
    await app.close();
  });

  it("replacing a key for a source with none stored is a plain not-found", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/news/sources/${SOURCE_ID}/credential`,
      payload: { apiKey: "whatever" }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("revoking twice succeeds both times and reports the same state", async () => {
    const credentials = makeCredentials(true);
    const { app } = buildApp({ credentials });
    await app.ready();

    const first = await app.inject({
      method: "DELETE",
      url: `/api/news/sources/${SOURCE_ID}/credential`
    });
    const second = await app.inject({
      method: "DELETE",
      url: `/api/news/sources/${SOURCE_ID}/credential`
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(first.body).message).toBe(NEWS_CREDENTIAL_MESSAGES.revoked);
    expect(JSON.parse(first.body).credential.status).toBe("revoked");
    // The stored key is gone, not merely marked.
    expect(credentials.state.envelope).toBeNull();
    await app.close();
  });

  it("the status list strips anything a stored row might carry beyond metadata", async () => {
    const credentials = makeCredentials(true);
    // A row that carries extra fields, as a future column or a careless edit would.
    credentials.readStatuses = async () =>
      [
        {
          sourceId: SOURCE_ID,
          connectionId: DESCRIPTOR.connectionId,
          status: "configured",
          lastValidatedAt: new Date("2026-08-20T09:00:00.000Z"),
          revokedAt: null,
          apiKey: SUBMITTED_KEY,
          encryptedSecret: ENVELOPE,
          generation: "9",
          ownerUserId: ACTOR.actorUserId
        }
      ] as unknown as NewsCredentialStatusRow[];
    const { app } = buildApp({ credentials });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/news/credentials" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body.credentials[0]).sort()).toEqual([
      "connectionId",
      "lastValidatedAt",
      "publisherName",
      "requestHost",
      "revokedAt",
      "sourceId",
      "status"
    ]);
    expect(res.body).not.toContain(SUBMITTED_KEY);
    expect(res.body).not.toContain(ENVELOPE.ciphertext);
    expect(res.body).not.toContain("generation");
    expect(res.body).not.toContain(ACTOR.actorUserId);
    await app.close();
  });

  it("a key longer than the allowed length is refused before any port is called", async () => {
    const recorder = makeRecorder();
    const { app, sources } = buildApp({ recorder });
    await app.ready();

    const res = await connect(app, "x".repeat(513));

    expect(res.statusCode).toBe(400);
    expect(recorder.validated).toEqual([]);
    expect(sources.created).toBe(0);
    await app.close();
  });

  it("the empty publisher list this slice ships with refuses every attempt", async () => {
    // Until the slice that knows how to talk to a publisher lands, every attempt must be
    // refused with the plain "not supported yet" wording and store nothing. This is the
    // shipped behaviour, not a fault.
    const recorder = makeRecorder();
    const { app, sources, credentials } = buildApp({
      recorder,
      connections: makeConnections(recorder, { known: false })
    });
    await app.ready();

    const res = await connect(app);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(NEWS_CREDENTIAL_MESSAGES.unsupported);
    expect(sources.created + credentials.inserted).toBe(0);
    await app.close();
  });
});
