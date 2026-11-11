/** Runs the old Connectors routes (real Fastify schemas and handlers, in-memory store) and
 *  the Rust guest on the same requests, and fails on any difference. No database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerConnectorsRoutes } from "../../../packages/connectors/src/routes.js";
import { GoogleConnectError } from "../../../packages/connectors/src/google-connection.js";

const binary = process.env.CONNECTORS_ORACLE;
assert(binary, "Build the connectors oracle first");
type Deps = Parameters<typeof registerConnectorsRoutes>[1];
type Input = { providerId: string; scopes: string[]; status?: string; tokenPayload?: unknown };

type Case = {
  method: string;
  url: string;
  body?: unknown;
  admin?: string;
  seed?: { id: string; providerId: string; scopes: string[] };
};
const cases: Case[] = JSON.parse(
  readFileSync(new URL("./routes-cases.json", import.meta.url), "utf8")
);

const TIME = new Date("2026-01-01T00:00:00.000Z");
const providers = [
  [
    "google",
    "google",
    "Google",
    ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"]
  ],
  ["imap-fastmail", "imap", "Fastmail", ["email.read"]],
  ["outlook-browser-calendar", "calendar", "Outlook calendar (browser)", ["calendar.readonly"]]
].map(([id, kind, name, scopes]) => ({
  provider_id: id,
  provider_type: kind,
  display_name: name,
  status: "available",
  default_scopes: scopes,
  created_at: TIME,
  updated_at: TIME
}));

let admin = "ok";
let next = 0;
const accounts: Record<string, unknown>[] = [];
const grants = new Map<string, unknown>();
const row = (id: string, provider: string, scopes: string[], status: string) => {
  const def = providers.find((p) => p.provider_id === provider)!;
  return {
    id,
    provider_id: provider,
    provider_type: def.provider_type,
    provider_display_name: provider,
    provider_status: "available",
    owner_user_id: "user-1",
    scopes,
    status,
    has_secret: true,
    revoked_at: null,
    created_at: TIME,
    updated_at: TIME,
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_sync_counts: null
  } as Record<string, unknown>;
};
const repository = {
  listProviders: async () => providers,
  listAccounts: async () => accounts,
  listAdminSafeAccounts: async () => accounts,
  getUserById: async () =>
    admin === "unauthenticated" ? undefined : { id: "user-1", is_instance_admin: admin === "ok" },
  createAccount: async (_db: unknown, input: Input) => {
    if (!providers.some((p) => p.provider_id === input.providerId))
      throw new Error('violates foreign key constraint "connector_accounts_provider_id_fkey"');
    const created = row(
      `acct-${++next}`,
      input.providerId,
      [...input.scopes],
      input.status ?? "active"
    );
    accounts.unshift(created);
    return created;
  },
  updateAccount: async (_db: unknown, id: string, input: Input) => {
    const found = accounts.find((a) => a.id === id);
    if (!found) return undefined;
    if (input.scopes !== undefined) found.scopes = [...input.scopes];
    if (input.status !== undefined) {
      found.status = input.status;
      found.revoked_at = null;
    }
    return found;
  },
  revokeAccount: async (_db: unknown, id: string) => {
    const found = accounts.find((a) => a.id === id);
    if (!found) return undefined;
    found.status = "revoked";
    found.revoked_at = TIME;
    return found;
  }
};
const preferences = {
  get: async (_db: unknown, key: string) => grants.get(key),
  upsert: async () => {
    throw new Error("PUT success is compared in the database test");
  }
};

const server = Fastify();
setMossErrorHandler(server);
registerConnectorsRoutes(server, {
  resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "parity" }),
  dataContext: {
    withDataContext: async (_ctx: unknown, work: (db: object) => unknown) => work({})
  } as unknown as Deps["dataContext"],
  boss: {} as unknown as never,
  repository: repository as unknown as never,
  preferencesRepository: preferences as unknown as never,
  secretCipher: { encryptJson: () => ({ sealed: true }) } as unknown as never,
  googleService: {
    startAuthorization: async (_db: unknown, input: { clientId: string }) => ({
      authUrl: `https://accounts.example.test/auth?client_id=${input.clientId}`
    }),
    completeAuthorization: async (_db: unknown, input: { redirectUrl: string }) => {
      if (input.redirectUrl.includes("mismatch"))
        throw new GoogleConnectError(
          "Authorization state did not match \u2014 please retry the connect flow"
        );
      const created = row(
        `acct-${++next}`,
        "google",
        [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/calendar"
        ],
        "active"
      );
      accounts.unshift(created);
      return created;
    }
  } as unknown as never,
  imapService: {} as unknown as never
});

try {
  const expected = [];
  for (const test of cases) {
    if (test.seed) {
      accounts.unshift(row(test.seed.id, test.seed.providerId, test.seed.scopes, "active"));
      continue;
    }
    admin = test.admin ?? "ok";
    const response = await server.inject({
      method: test.method as "GET",
      url: test.url,
      ...(test.body === undefined
        ? {}
        : { payload: JSON.stringify(test.body), headers: { "content-type": "application/json" } })
    });
    let body: unknown = null;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    expected.push({ status: response.statusCode, body });
  }
  const result = spawnSync(binary, { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const actual: unknown[] = JSON.parse(result.stdout);
  assert.equal(actual.length, expected.length);
  const live = cases.filter((c) => !c.seed);
  for (const [index, value] of actual.entries())
    assert.deepEqual(
      value,
      expected[index],
      `${live[index].method} ${live[index].url} ${JSON.stringify(live[index].body)}`
    );
  console.log(`PASS ${actual.length} route comparisons against the old Connectors routes`);
} finally {
  await server.close();
}
