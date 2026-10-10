// tests/unit/external-module-finance-handlers-connect.test.ts
import { describe, expect, it } from "vitest";

import type {
  PlaidAccount,
  PlaidClient
} from "../../external-modules/finance/src/adapters/plaid.js";
import { kvStore, linkKey, NS } from "../../external-modules/finance/src/domain/index.js";
import type { FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import {
  connectPollHandler,
  connectStartHandler
} from "../../external-modules/finance/src/worker/handlers/connect.js";
import type { TokenMap, WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { InputError } from "../../external-modules/finance/src/worker/validate.js";

// FIN-01 (#1146) Task 5: Hosted Link connect (start + single-shot poll, D2).
// The contracts pinned here: link sessions are stored under a HASHED key
// (raw link tokens never become key material), missing Plaid keys surface as
// needs_config, and the token-map write is a MERGE guarded by D5 — a null
// tokens read with connected items on record aborts the poll instead of
// clobbering every user's access token with a fresh map.

const NOW = new Date("2026-07-18T12:00:00Z");

function fakeKv(): FinanceKv & { dump(namespace: string): Map<string, Record<string, unknown>> } {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const ns = (namespace: string) => {
    let bucket = store.get(namespace);
    if (!bucket) {
      bucket = new Map();
      store.set(namespace, bucket);
    }
    return bucket;
  };
  return {
    get: async (namespace, key) => structuredClone(ns(namespace).get(key) ?? null),
    set: async (namespace, key, value) => {
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()],
    dump: (namespace) => ns(namespace)
  };
}

const ACCOUNT_FIXTURE: PlaidAccount = {
  accountId: "acc-9",
  name: "Checking",
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: "0000",
  balanceCents: 121055,
  isoCurrency: "USD"
};

type PlaidOverrides = Partial<PlaidClient>;

function fakePlaid(overrides: PlaidOverrides = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      calls.push({ method, args: [...args] });
      return impl(...args);
    };
  const client: PlaidClient = {
    linkTokenCreate: record(
      "linkTokenCreate",
      overrides.linkTokenCreate ??
        (async () => ({
          linkToken: "link-sandbox-1",
          hostedLinkUrl: "https://secure.plaid.com/hl/x"
        }))
    ) as PlaidClient["linkTokenCreate"],
    linkTokenGet: record(
      "linkTokenGet",
      overrides.linkTokenGet ?? (async () => ({ status: "pending" as const, publicTokens: [] }))
    ) as PlaidClient["linkTokenGet"],
    itemPublicTokenExchange: record(
      "itemPublicTokenExchange",
      overrides.itemPublicTokenExchange ??
        (async () => ({ accessToken: "access-9", itemId: "item-9" }))
    ) as PlaidClient["itemPublicTokenExchange"],
    accountsGet: record(
      "accountsGet",
      overrides.accountsGet ??
        (async () => ({ institutionId: "ins_9", accounts: [ACCOUNT_FIXTURE] }))
    ) as PlaidClient["accountsGet"],
    institutionGet: record(
      "institutionGet",
      overrides.institutionGet ?? (async () => ({ name: null }))
    ) as PlaidClient["institutionGet"],
    accountsBalanceGet: record(
      "accountsBalanceGet",
      overrides.accountsBalanceGet ?? (async () => ({ accounts: [] }))
    ) as PlaidClient["accountsBalanceGet"],
    transactionsSync: record(
      "transactionsSync",
      overrides.transactionsSync ??
        (async () => ({ added: [], modified: [], removed: [], nextCursor: "c", hasMore: false }))
    ) as PlaidClient["transactionsSync"]
  };
  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  return { client, calls, callsTo };
}

function fakePorts(opts: {
  kv?: FinanceKv;
  plaid?: PlaidClient | null;
  tokens?: TokenMap | null;
  tokensReadFails?: boolean;
  credsFail?: boolean;
  environment?: "production" | "sandbox";
  isAdmin?: boolean;
}) {
  const kv = opts.kv ?? fakeKv();
  const tokenWrites: TokenMap[] = [];
  let tokenState: TokenMap | null = opts.tokens ?? null;
  const plaidFactoryCalls: { env: string; creds: { clientId: string; secret: string } }[] = [];
  const ports: WorkerPorts = {
    kv,
    // FIN-04 (#1149): mirror writes are share/sync-handler territory only.
    mirror: {
      get: async () => {
        throw new Error("connect handlers must not read the household mirror");
      },
      set: async () => {
        throw new Error("connect handlers must not write the household mirror");
      },
      delete: async () => {
        throw new Error("connect handlers must not delete from the household mirror");
      },
      list: async () => {
        throw new Error("connect handlers must not list the household mirror");
      }
    },
    ai: null,
    db: null,
    plaid:
      opts.plaid === null
        ? null
        : (env, creds) => {
            plaidFactoryCalls.push({ env, creds });
            return opts.plaid!;
          },
    tokens: {
      read: async () => (opts.tokensReadFails ? null : tokenState),
      write: async (map) => {
        tokenWrites.push(structuredClone(map));
        tokenState = map;
      }
    },
    creds: {
      get: async () => {
        if (opts.credsFail) {
          throw new InputError("needs_config", "Plaid keys are not configured");
        }
        return { clientId: "client-id-7f3a", secret: "secret-9b2c" };
      }
    },
    settings: { getEnvironment: async () => opts.environment ?? "sandbox" },
    isAdmin: opts.isAdmin ?? false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => kvStore(kv)
  };
  return { ports, kv, tokenWrites, plaidFactoryCalls };
}

async function seedSession(
  kv: FinanceKv,
  linkToken: string,
  createdAt: string,
  status: "pending" | "completed" | "abandoned" = "pending"
) {
  await kv.set(NS.connections, linkKey(linkToken), {
    linkToken,
    hostedLinkUrl: "https://secure.plaid.com/hl/x",
    createdAt,
    status
  });
}

describe("finance.connect.start (#1146)", () => {
  it("stores a pending session under a hashed key and returns the hosted link", async () => {
    const plaid = fakePlaid();
    const { ports, kv, plaidFactoryCalls } = fakePorts({ plaid: plaid.client });
    const result = await connectStartHandler(ports)({});

    expect(result.status).toBe("pending");
    expect(result.hostedLinkUrl).toBe("https://secure.plaid.com/hl/x");
    expect(String(result.nextStep)).toContain("finance.connect.poll");

    // The plaid client was built for the instance environment + admin creds.
    expect(plaidFactoryCalls).toEqual([
      { env: "sandbox", creds: { clientId: "client-id-7f3a", secret: "secret-9b2c" } }
    ]);

    const keys = await kv.list(NS.connections);
    expect(keys).toEqual([linkKey("link-sandbox-1")]);
    // Raw link token must never be key material (keys show up in listings/logs).
    expect(keys[0]).not.toContain("link-sandbox-1");
    const session = await kv.get(NS.connections, keys[0]!);
    expect(session).toMatchObject({
      linkToken: "link-sandbox-1",
      hostedLinkUrl: "https://secure.plaid.com/hl/x",
      createdAt: NOW.toISOString(),
      status: "pending"
    });
  });

  it("reuses one stable client_user_id across starts", async () => {
    const plaid = fakePlaid();
    const { ports } = fakePorts({ plaid: plaid.client });
    await connectStartHandler(ports)({});
    await connectStartHandler(ports)({});
    const creates = plaid.callsTo("linkTokenCreate");
    expect(creates).toHaveLength(2);
    const first = (creates[0]!.args[0] as { clientUserId: string }).clientUserId;
    const second = (creates[1]!.args[0] as { clientUserId: string }).clientUserId;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("fails with needs_config when Plaid keys are unreadable", async () => {
    const plaid = fakePlaid();
    const { ports } = fakePorts({ plaid: plaid.client, credsFail: true });
    const error = await connectStartHandler(ports)({}).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InputError);
    expect((error as InputError).code).toBe("needs_config");
    expect(plaid.calls).toHaveLength(0);
  });

  it("drops the environment override for non-admins but honors it for admins", async () => {
    const plaid = fakePlaid();
    const nonAdmin = fakePorts({ plaid: plaid.client, environment: "production" });
    await connectStartHandler(nonAdmin.ports)({ environment: "sandbox" });
    expect(nonAdmin.plaidFactoryCalls[0]?.env).toBe("production");

    const admin = fakePorts({ plaid: plaid.client, environment: "production", isAdmin: true });
    await connectStartHandler(admin.ports)({ environment: "sandbox" });
    expect(admin.plaidFactoryCalls[0]?.env).toBe("sandbox");
  });

  it("passes the existing access token through for reauth (update mode)", async () => {
    const plaid = fakePlaid();
    const kv = fakeKv();
    await kv.set(NS.connections, "item:item-1", {
      itemId: "item-1",
      institutionId: "ins_1",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "reauth-required"
    });
    const { ports } = fakePorts({
      kv,
      plaid: plaid.client,
      tokens: { "item-1": { accessToken: "access-1", institutionId: "ins_1" } }
    });
    await connectStartHandler(ports)({});
    const create = plaid.callsTo("linkTokenCreate")[0]!.args[0] as { accessToken?: string };
    expect(create.accessToken).toBe("access-1");
  });
});

describe("finance.connect.poll (#1146, D2 single-shot)", () => {
  it("counts still-pending sessions without touching tokens", async () => {
    const plaid = fakePlaid();
    const kv = fakeKv();
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports, tokenWrites } = fakePorts({ kv, plaid: plaid.client });
    const result = await connectPollHandler(ports)({});
    expect(result).toMatchObject({ status: "ok", completed: 0, pending: 1, abandoned: 0 });
    expect(tokenWrites).toHaveLength(0);
    const session = await kv.get(NS.connections, linkKey("link-sandbox-1"));
    expect(session?.status).toBe("pending");
  });

  it("abandons sessions older than 30 minutes without calling Plaid", async () => {
    const plaid = fakePlaid();
    const kv = fakeKv();
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 31 * 60_000).toISOString());
    const { ports } = fakePorts({ kv, plaid: plaid.client });
    const result = await connectPollHandler(ports)({});
    expect(result).toMatchObject({ completed: 0, pending: 0, abandoned: 1 });
    expect(plaid.callsTo("linkTokenGet")).toHaveLength(0);
    const session = await kv.get(NS.connections, linkKey("link-sandbox-1"));
    expect(session?.status).toBe("abandoned");
  });

  it("completes a session: merges the token map, writes accounts + item", async () => {
    const plaid = fakePlaid({
      linkTokenGet: async () => ({ status: "success", publicTokens: ["public-1"] })
    });
    const kv = fakeKv();
    await kv.set(NS.connections, "item:item-0", {
      itemId: "item-0",
      institutionId: "ins_0",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected"
    });
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports, tokenWrites } = fakePorts({
      kv,
      plaid: plaid.client,
      tokens: { "item-0": { accessToken: "access-0", institutionId: "ins_0" } }
    });

    const result = await connectPollHandler(ports)({});
    expect(result).toMatchObject({ status: "ok", completed: 1, pending: 0, abandoned: 0 });
    expect(String(result.nextStep)).toContain("finance.sync.run-now");

    // D5 contract: MERGE, never replace — item-0's token must survive.
    expect(tokenWrites).toEqual([
      {
        "item-0": { accessToken: "access-0", institutionId: "ins_0" },
        "item-9": { accessToken: "access-9", institutionId: "ins_9" }
      }
    ]);

    expect(await kv.get(NS.accounts, "acc-9")).toMatchObject({
      accountId: "acc-9",
      itemId: "item-9",
      balanceCents: 121055,
      updatedAt: NOW.toISOString()
    });
    expect(await kv.get(NS.connections, "item:item-9")).toMatchObject({
      itemId: "item-9",
      institutionId: "ins_9",
      status: "connected",
      connectedAt: NOW.toISOString()
    });
    const session = await kv.get(NS.connections, linkKey("link-sandbox-1"));
    expect(session?.status).toBe("completed");
  });

  it("runs a first sync right after a successful connect (#3161)", async () => {
    const plaid = fakePlaid({
      linkTokenGet: async () => ({ status: "success", publicTokens: ["public-1"] }),
      transactionsSync: async () => ({
        added: [
          {
            transaction_id: "t1",
            account_id: "acc-9",
            date: "2026-07-10",
            amount: 5,
            iso_currency_code: "USD",
            name: "X",
            merchant_name: null,
            personal_finance_category: null,
            pending: false,
            pending_transaction_id: null
          }
        ],
        modified: [],
        removed: [],
        nextCursor: "c1",
        hasMore: false
      })
    });
    const kv = fakeKv();
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports } = fakePorts({ kv, plaid: plaid.client });
    const mirror = new Map<string, Record<string, unknown>>();
    const withMirror: WorkerPorts = {
      ...ports,
      mirror: {
        get: async (k) => mirror.get(k) ?? null,
        set: async (k, v) => void mirror.set(k, v),
        delete: async (k) => mirror.delete(k),
        list: async () => [...mirror.keys()]
      }
    };
    const result = await connectPollHandler(withMirror)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result).toMatchObject({ completed: 1 });
    const chunk = await kv.get(NS.transactions, "acc-9:2026-07");
    expect((chunk as { transactions: { id: string }[] }).transactions.map((r) => r.id)).toEqual([
      "t1"
    ]);
  });

  it("a failing first sync never fails the connect", async () => {
    const plaid = fakePlaid({
      linkTokenGet: async () => ({ status: "success", publicTokens: ["public-1"] }),
      transactionsSync: async () => {
        throw new Error("boom");
      }
    });
    const kv = fakeKv();
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports } = fakePorts({ kv, plaid: plaid.client });
    const result = await connectPollHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result).toMatchObject({ status: "ok", completed: 1 });
  });

  it("D5: aborts when the token read fails while items are on record", async () => {
    const plaid = fakePlaid({
      linkTokenGet: async () => ({ status: "success", publicTokens: ["public-1"] })
    });
    const kv = fakeKv();
    await kv.set(NS.connections, "item:item-0", {
      itemId: "item-0",
      institutionId: "ins_0",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected"
    });
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports, tokenWrites } = fakePorts({
      kv,
      plaid: plaid.client,
      tokensReadFails: true
    });

    const error = await connectPollHandler(ports)({}).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InputError);
    expect((error as InputError).code).toBe("token_read_failed");
    // The whole point of D5: the write that would clobber must never happen.
    expect(tokenWrites).toHaveLength(0);
  });

  it("first-ever connect proceeds when the read is null and no items exist", async () => {
    const plaid = fakePlaid({
      linkTokenGet: async () => ({ status: "success", publicTokens: ["public-1"] })
    });
    const kv = fakeKv();
    await seedSession(kv, "link-sandbox-1", new Date(NOW.getTime() - 5 * 60_000).toISOString());
    const { ports, tokenWrites } = fakePorts({ kv, plaid: plaid.client, tokens: null });
    const result = await connectPollHandler(ports)({});
    expect(result).toMatchObject({ completed: 1 });
    expect(tokenWrites).toEqual([
      { "item-9": { accessToken: "access-9", institutionId: "ins_9" } }
    ]);
  });
});
