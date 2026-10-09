// tests/unit/external-module-finance-handlers-accounts.test.ts
import { describe, expect, it } from "vitest";

import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type { FinanceKv, SharedMirrorKv } from "../../external-modules/finance/src/domain/index.js";
import {
  sharedMetaKey,
  sharedMonthKey
} from "../../external-modules/finance/src/domain/shared-pool.js";
import { accountsListHandler } from "../../external-modules/finance/src/worker/handlers/accounts.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// FIN-01 (#1146) Task 7: accounts.list — the read tool the assistant uses to
// answer "what are my balances". Pure KV read: joins NS.accounts records with
// their item's status/institution; never touches Plaid or the token map.
// FIN-04 (#1149) Task 5: the same read additionally merges OTHER owners'
// entries from the finance.shared mirror, tagged { ownerUserId, shared: true },
// skipping the actor's own mirror prefix (the user-scoped records above are
// the authoritative copy). Read tools cannot write (forbidden_kv_mutation),
// so the mirror port here permits list/get and throws on set/delete.

const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

function fakeKv(): FinanceKv {
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
    list: async (namespace) => [...ns(namespace).keys()]
  };
}

// FIN-04 (#1149): read handlers may LIST/GET the mirror (that's the merged
// household read) but must never mutate it — the host would reject the rpc
// with forbidden_kv_mutation anyway; throwing here keeps the contract local.
function readOnlyMirror(seed?: Record<string, Record<string, unknown>>): SharedMirrorKv {
  const store = new Map(Object.entries(seed ?? {}));
  return {
    get: async (key) => structuredClone(store.get(key) ?? null),
    set: async () => {
      throw new Error("accounts.list must not write the household mirror");
    },
    delete: async () => {
      throw new Error("accounts.list must not delete from the household mirror");
    },
    list: async () => [...store.keys()]
  };
}

function ports(kv: FinanceKv, mirror: SharedMirrorKv = readOnlyMirror()): WorkerPorts {
  return {
    kv,
    mirror,
    ai: null,
    db: null,
    // Read tool: reaching for Plaid or credentials would be a design break.
    plaid: () => {
      throw new Error("accounts.list must not build a Plaid client");
    },
    tokens: {
      read: async () => {
        throw new Error("accounts.list must not read the token map");
      },
      write: async () => {
        throw new Error("accounts.list must not write the token map");
      }
    },
    creds: {
      get: async () => {
        throw new Error("accounts.list must not read credentials");
      }
    },
    settings: { getEnvironment: async () => "sandbox" },
    isAdmin: false,
    now: () => new Date("2026-07-18T12:00:00Z"),
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => kvStore(kv)
  };
}

async function seed(kv: FinanceKv) {
  await kv.set(NS.connections, "item:item-1", {
    itemId: "item-1",
    institutionId: "ins_1",
    connectedAt: "2026-07-01T00:00:00Z",
    status: "connected"
  });
  await kv.set(NS.connections, "item:item-2", {
    itemId: "item-2",
    institutionId: "ins_2",
    connectedAt: "2026-07-02T00:00:00Z",
    status: "reauth-required",
    lastError: "ITEM_LOGIN_REQUIRED"
  });
  await kv.set(NS.accounts, "acc-2", {
    accountId: "acc-2",
    itemId: "item-2",
    name: "Savings",
    officialName: "High Yield Savings",
    type: "depository",
    subtype: "savings",
    mask: "1111",
    balanceCents: 1250000,
    isoCurrency: "USD",
    updatedAt: "2026-07-18T06:00:00Z"
  });
  await kv.set(NS.accounts, "acc-1", {
    accountId: "acc-1",
    itemId: "item-1",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    balanceCents: 500000,
    isoCurrency: "USD",
    updatedAt: "2026-07-18T06:00:00Z"
  });
}

describe("finance.accounts.list (#1146)", () => {
  it("returns the connect nextStep when no accounts exist", async () => {
    const result = await accountsListHandler(ports(fakeKv()))({ actorUserId: ACTOR });
    expect(result).toEqual({
      accounts: [],
      banks: [],
      nextStep: "connect a bank with finance.connect.start"
    });
  });

  it("requires the host-injected actorUserId (#1149 spoof defense)", async () => {
    // The host spreads actorUserId LAST into tool input (#1149); a missing
    // value means the handler is being driven outside the dispatch chokepoint.
    await expect(accountsListHandler(ports(fakeKv()))({})).rejects.toThrow(
      /actorUserId is required/
    );
  });

  it("lists accounts joined with their item's status and institution", async () => {
    const kv = fakeKv();
    await seed(kv);
    const result = (await accountsListHandler(ports(kv))({ actorUserId: ACTOR })) as {
      accounts: Record<string, unknown>[];
    };
    // Stable order: accountId asc (kv.list order is storage-dependent).
    expect(result.accounts.map((a) => a.accountId)).toEqual(["acc-1", "acc-2"]);
    expect(result.accounts[0]).toEqual({
      accountId: "acc-1",
      itemId: "item-1",
      name: "Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      balanceCents: 500000,
      isoCurrency: "USD",
      institutionId: "ins_1",
      itemStatus: "connected",
      updatedAt: "2026-07-18T06:00:00Z",
      // FIN-04 (#1149): the web share toggle needs the current flag.
      sharedToHousehold: false
    });
    expect(result.accounts[1]).toMatchObject({
      accountId: "acc-2",
      balanceCents: 1250000,
      institutionId: "ins_2",
      itemStatus: "reauth-required"
    });
  });

  it("reports one bank per item with status, last sync and the stored display message (#3177)", async () => {
    const kv = fakeKv();
    await seed(kv);
    await kv.set(NS.connections, "item:item-1", {
      itemId: "item-1",
      institutionId: "ins_1",
      institutionName: "Sandbox First Bank",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected",
      lastSyncAt: "2026-07-18T10:00:00Z"
    });
    await kv.set(NS.connections, "item:item-2", {
      itemId: "item-2",
      institutionId: "ins_2",
      connectedAt: "2026-07-02T00:00:00Z",
      status: "reauth-required",
      lastError: "ITEM_LOGIN_REQUIRED",
      lastSyncAt: "2026-07-05T10:00:00Z",
      lastErrorDetail: {
        type: "ITEM_ERROR",
        code: "ITEM_LOGIN_REQUIRED",
        message: "The login details of this item have changed.",
        requestId: "req-1"
      }
    });
    const result = (await accountsListHandler(ports(kv))({ actorUserId: ACTOR })) as {
      banks: Record<string, unknown>[];
    };
    expect(result.banks).toEqual([
      {
        itemId: "item-1",
        institutionId: "ins_1",
        institutionName: "Sandbox First Bank",
        status: "connected",
        lastSyncAt: "2026-07-18T10:00:00Z",
        message: null
      },
      {
        itemId: "item-2",
        institutionId: "ins_2",
        institutionName: null,
        status: "reauth-required",
        lastSyncAt: "2026-07-05T10:00:00Z",
        message: "The login details of this item have changed."
      }
    ]);
  });

  it("surfaces an orphaned account (item record missing) rather than hiding it", async () => {
    const kv = fakeKv();
    await kv.set(NS.accounts, "acc-9", {
      accountId: "acc-9",
      itemId: "item-gone",
      name: "Old Checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "9999",
      balanceCents: 100,
      isoCurrency: "USD",
      updatedAt: "2026-07-01T00:00:00Z"
    });
    const result = (await accountsListHandler(ports(kv))({ actorUserId: ACTOR })) as {
      accounts: Record<string, unknown>[];
    };
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      accountId: "acc-9",
      institutionId: null,
      itemStatus: "error"
    });
  });
});

// FIN-04 (#1149) Task 5: merged household read. Foreign owners' shared
// accounts come from the finance.shared mirror, appended after own accounts
// and tagged { ownerUserId, shared: true }; the actor's own mirror prefix is
// skipped (their user-scoped records above are authoritative).
describe("finance.accounts.list household merge (#1149)", () => {
  // Shape = SharedAccountMeta (shared-pool.ts): no itemStatus/institutionId —
  // Plaid plumbing deliberately never enters the mirror.
  const otherMeta = {
    ownerUserId: OTHER,
    accountId: "acc-x",
    name: "Joint Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "4444",
    balanceCents: 300000,
    isoCurrency: "USD",
    updatedAt: "2026-07-18T05:00:00Z"
  };

  it("appends foreign shared accounts after own accounts, tagged shared", async () => {
    const kv = fakeKv();
    await seed(kv);
    const mirror = readOnlyMirror({
      [sharedMetaKey(OTHER, "acc-x")]: otherMeta,
      // Own-prefix mirror entry — MUST be skipped, not duplicated.
      [sharedMetaKey(ACTOR, "acc-1")]: {
        ownerUserId: ACTOR,
        accountId: "acc-1",
        name: "Checking",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: "0000",
        balanceCents: 500000,
        isoCurrency: "USD",
        updatedAt: "2026-07-18T06:00:00Z"
      },
      // Month chunks under the mirror are not accounts — meta suffix only.
      [sharedMonthKey(OTHER, "acc-x", "2026-07")]: { transactions: [] }
    });
    const result = (await accountsListHandler(ports(kv, mirror))({ actorUserId: ACTOR })) as {
      accounts: Record<string, unknown>[];
    };
    expect(result.accounts.map((a) => a.accountId)).toEqual(["acc-1", "acc-2", "acc-x"]);
    // Read-side allowlist copy of the mirror meta: no itemStatus, no
    // institutionId (never mirrored), no officialName (own views drop it too).
    expect(result.accounts[2]).toEqual({
      accountId: "acc-x",
      name: "Joint Checking",
      mask: "4444",
      type: "depository",
      subtype: "checking",
      balanceCents: 300000,
      isoCurrency: "USD",
      updatedAt: "2026-07-18T05:00:00Z",
      ownerUserId: OTHER,
      shared: true
    });
    // Own accounts are NOT tagged shared and never carry ownerUserId.
    expect(result.accounts[0]).not.toHaveProperty("ownerUserId");
  });

  it("shows shared accounts to a member with no own accounts, keeping nextStep", async () => {
    const mirror = readOnlyMirror({ [sharedMetaKey(OTHER, "acc-x")]: otherMeta });
    const result = (await accountsListHandler(ports(fakeKv(), mirror))({
      actorUserId: ACTOR
    })) as Record<string, unknown>;
    expect((result.accounts as Record<string, unknown>[]).map((a) => a.accountId)).toEqual([
      "acc-x"
    ]);
    // nextStep keys off OWN accounts: this member still hasn't connected a bank.
    expect(result.nextStep).toBe("connect a bank with finance.connect.start");
  });

  it("tolerates malformed mirror keys and non-record meta values", async () => {
    const kv = fakeKv();
    await seed(kv);
    const mirror = readOnlyMirror({
      "no-colons-here": { ownerUserId: OTHER },
      [`${OTHER}:acc-y:meta`]: null as unknown as Record<string, unknown>,
      [sharedMetaKey(OTHER, "acc-x")]: otherMeta
    });
    const result = (await accountsListHandler(ports(kv, mirror))({ actorUserId: ACTOR })) as {
      accounts: Record<string, unknown>[];
    };
    expect(result.accounts.map((a) => a.accountId)).toEqual(["acc-1", "acc-2", "acc-x"]);
  });
});
