// The merchant rule save path. The old-rule copy skips broken rules and still finishes, payee text a
// stored rule cannot hold is refused with a clear code, and the Transactions screen checks a rule
// before it saves the category, so a refused rule leaves nothing half-saved.
import { describe, expect, it } from "vitest";

import {
  contentHash,
  kvStore,
  NS,
  RULE_PAYEE_MAX_CHARS
} from "../../external-modules/finance/src/domain/index.js";
import type {
  FinanceKv,
  FinanceStore,
  MerchantRule,
  MerchantRuleChange,
  MerchantRuleStore,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import { reviewApplyHandler } from "../../external-modules/finance/src/worker/handlers/feed.js";
import {
  RULES_MIGRATED_KEY,
  checkMerchantRule,
  copyLegacyMerchantRules,
  effectiveMerchantRules,
  setCanonicalMerchantRule
} from "../../external-modules/finance/src/worker/merchant-rules.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

const NOW = new Date("2026-10-31T12:00:00Z");
const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const ASTRAL_LETTER = "\u{1D41A}";
const LONG_NAME = "Long Name ".repeat(30);

type LegacyImport = { id: string; payeeKey: string; categoryId: string; createdAt: string };

function memoryKv(): FinanceKv {
  const buckets = new Map<string, Map<string, Record<string, unknown>>>();
  const bucket = (namespace: string) => {
    let found = buckets.get(namespace);
    if (!found) {
      found = new Map();
      buckets.set(namespace, found);
    }
    return found;
  };
  return {
    get: async (namespace, key) => structuredClone(bucket(namespace).get(key) ?? null),
    set: async (namespace, key, value) => {
      bucket(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => bucket(namespace).delete(key),
    list: async (namespace) => [...bucket(namespace).keys()]
  };
}

/** A rule store that keeps the database contract, so an import skips rules whose category is gone. */
function ruleStore(categories: string[], events: string[] = [], failImport = false) {
  const saved = new Map<string, MerchantRule>();
  const imports: LegacyImport[][] = [];
  const applied: MerchantRuleChange[] = [];
  const rules: MerchantRuleStore = {
    all: async () => [...saved.values()],
    apply: async (change) => {
      events.push("apply");
      applied.push(change);
      saved.set(change.id, {
        id: change.id,
        payeeKey: change.payeeKey,
        categoryId: change.categoryId,
        enabled: change.enabled,
        createdAt: change.at,
        updatedAt: change.at,
        writeRevision: `revision-${applied.length}`
      });
      return true;
    },
    importLegacy: async (incoming) => {
      events.push("import");
      imports.push(incoming);
      if (failImport) throw new Error("import failed");
      for (const rule of incoming) {
        if (!categories.includes(rule.categoryId) || saved.has(rule.id)) continue;
        saved.set(rule.id, {
          ...rule,
          enabled: true,
          updatedAt: rule.createdAt,
          writeRevision: "imported"
        });
      }
    },
    undo: async () => false
  };
  return { rules, saved, imports, applied };
}

function portsFor(kv: FinanceKv, overrides: Partial<FinanceStore> = {}): WorkerPorts {
  return {
    kv,
    now: () => NOW,
    store: async () => ({
      ...kvStore(kv),
      appendActivity: async () => {},
      ...overrides
    })
  } as unknown as WorkerPorts;
}

const storeWith = (rules: MerchantRuleStore) => ({ rules }) as unknown as FinanceStore;

const legacy = (payeeKey: string, categoryId: string, createdAt = "2026-06-01T00:00:00Z") => ({
  payeeKey,
  categoryId,
  createdAt
});

const marker = (kv: FinanceKv) => kv.get(NS.meta, RULES_MIGRATED_KEY);

describe("copying the old merchant rules", () => {
  it("skips broken rules, copies the rest and records the upgrade", async () => {
    const kv = memoryKv();
    const { rules, imports, saved } = ruleStore(["dining", "transport"]);
    await kv.set(NS.rules, "rule:good-1", legacy("blue bottle", "dining"));
    await kv.set(
      NS.rules,
      "rule:good-2",
      legacy("shell oil", "transport", "2026-06-02T08:30:00+02:00")
    );
    await kv.set(NS.rules, "rule:too-long", legacy("q".repeat(RULE_PAYEE_MAX_CHARS + 1), "dining"));
    await kv.set(NS.rules, "rule:digits", legacy("store 42", "dining"));
    await kv.set(NS.rules, "rule:bad-date", legacy("night market", "dining", "not a date"));
    await kv.set(NS.rules, "rule:no-category", legacy("corner deli", ""));
    await kv.set(NS.rules, "rule:gone-category", legacy("old gym", "closed-category"));
    const ports = portsFor(kv);

    await copyLegacyMerchantRules(ports, rules);

    // The store gets every well-formed rule, with dates in canonical form.
    expect(imports).toHaveLength(1);
    expect([...imports[0]!].sort((a, b) => a.payeeKey.localeCompare(b.payeeKey))).toEqual([
      {
        id: contentHash("blue bottle"),
        payeeKey: "blue bottle",
        categoryId: "dining",
        createdAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: contentHash("old gym"),
        payeeKey: "old gym",
        categoryId: "closed-category",
        createdAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: contentHash("shell oil"),
        payeeKey: "shell oil",
        categoryId: "transport",
        createdAt: "2026-06-02T06:30:00.000Z"
      }
    ]);

    // The store drops the rule whose category is gone, and the upgrade is recorded anyway.
    expect([...saved.values()].map((rule) => rule.payeeKey).sort()).toEqual([
      "blue bottle",
      "shell oil"
    ]);
    expect(await marker(kv)).toEqual({ at: NOW.toISOString() });

    // Every old rule stays where it was, and the ones the store skipped keep working.
    expect(await kv.list(NS.rules)).toHaveLength(7);
    const effective = await effectiveMerchantRules(ports, storeWith(rules));
    expect(effective.map((rule) => rule.payeeKey).sort()).toEqual([
      "blue bottle",
      "old gym",
      "shell oil"
    ]);
  });

  it("records the upgrade without calling the store when no old rule is usable", async () => {
    const kv = memoryKv();
    const { rules, imports } = ruleStore(["dining"]);
    await kv.set(NS.rules, "rule:digits", legacy("store 42", "dining"));

    await copyLegacyMerchantRules(portsFor(kv), rules);

    expect(imports).toEqual([]);
    expect(await marker(kv)).toEqual({ at: NOW.toISOString() });
  });

  it("does nothing once the upgrade is recorded", async () => {
    const kv = memoryKv();
    const { rules, imports } = ruleStore(["dining"]);
    await kv.set(NS.meta, RULES_MIGRATED_KEY, { at: "2026-10-01T00:00:00.000Z" });
    await kv.set(NS.rules, "rule:a", legacy("blue bottle", "dining"));

    await copyLegacyMerchantRules(portsFor(kv), rules);

    expect(imports).toEqual([]);
    expect(await marker(kv)).toEqual({ at: "2026-10-01T00:00:00.000Z" });
  });

  it("leaves the upgrade unrecorded when the store fails, so the next run tries again", async () => {
    const kv = memoryKv();
    const { rules } = ruleStore(["dining"], [], true);
    await kv.set(NS.rules, "rule:a", legacy("blue bottle", "dining"));

    await expect(copyLegacyMerchantRules(portsFor(kv), rules)).rejects.toThrow("import failed");

    expect(await marker(kv)).toBeNull();
  });
});

describe("checking a merchant rule", () => {
  it.each([
    ["letters", "a"],
    ["letters outside the basic plane", ASTRAL_LETTER]
  ])("takes %s up to the limit", async (_label, letter) => {
    const kv = memoryKv();
    const { rules } = ruleStore(["dining"]);
    const merchant = letter.repeat(RULE_PAYEE_MAX_CHARS);

    expect(await checkMerchantRule(portsFor(kv), rules, merchant)).toBe(merchant);
    expect(await marker(kv)).not.toBeNull();
  });

  it.each([
    ["a long run of letters", "a".repeat(RULE_PAYEE_MAX_CHARS + 1)],
    [
      "a long run of letters outside the basic plane",
      ASTRAL_LETTER.repeat(RULE_PAYEE_MAX_CHARS + 1)
    ],
    ["a name that repeats", LONG_NAME]
  ])("refuses %s and changes nothing", async (_label, merchant) => {
    const kv = memoryKv();
    const { rules, imports } = ruleStore(["dining"]);
    await kv.set(NS.rules, "rule:a", legacy("blue bottle", "dining"));

    await expect(checkMerchantRule(portsFor(kv), rules, merchant)).rejects.toMatchObject({
      code: "rule_payee_too_long"
    });

    expect(imports).toEqual([]);
    expect(await marker(kv)).toBeNull();
  });

  it("measures the cleaned key, not the raw text", async () => {
    const merchant = `${"#".repeat(300)} Shell Oil 4521`;

    expect(await checkMerchantRule(portsFor(memoryKv()), undefined, merchant)).toBe("shell oil");
  });

  it("returns the key without touching the old rules when there is no rule store", async () => {
    const kv = memoryKv();
    await kv.set(NS.rules, "rule:a", legacy("blue bottle", "dining"));

    expect(await checkMerchantRule(portsFor(kv), undefined, "Blue Bottle 12")).toBe("blue bottle");
    expect(await marker(kv)).toBeNull();
  });
});

describe("saving a merchant rule", () => {
  it("refuses payee text over the limit before it writes the rule", async () => {
    const { rules, applied } = ruleStore(["dining"]);

    await expect(
      setCanonicalMerchantRule(portsFor(memoryKv()), storeWith(rules), LONG_NAME, "dining", "user")
    ).rejects.toMatchObject({ code: "rule_payee_too_long" });

    expect(applied).toEqual([]);
  });

  it("asks for a storage update when there is no rule store", async () => {
    await expect(
      setCanonicalMerchantRule(
        portsFor(memoryKv()),
        {} as unknown as FinanceStore,
        "Blue Bottle",
        "dining",
        "user"
      )
    ).rejects.toMatchObject({ code: "storage_upgrade_required" });
  });

  it("finishes the old-rule copy and then writes the rule", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules, applied } = ruleStore(["dining", "groceries"], events);
    await kv.set(NS.rules, "rule:a", legacy("shell oil", "dining"));

    const result = await setCanonicalMerchantRule(
      portsFor(kv),
      storeWith(rules),
      "Blue Bottle 12",
      "groceries",
      "user"
    );

    expect(events).toEqual(["import", "apply"]);
    expect(applied).toEqual([
      {
        id: contentHash("blue bottle"),
        payeeKey: "blue bottle",
        categoryId: "groceries",
        enabled: true,
        expectedRevision: null,
        actor: "user",
        at: NOW.toISOString()
      }
    ]);
    expect(result).toEqual({ ruleId: contentHash("blue bottle"), previousCategoryId: null });
  });
});

describe("making a merchant rule from the Transactions screen", () => {
  async function seed(kv: FinanceKv, name: string): Promise<void> {
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
      updatedAt: "2026-07-18T00:00:00Z"
    });
    const record: TransactionRecord = {
      id: "r-1",
      accountId: "acc-1",
      date: "2026-07-10",
      amountCents: 1234,
      isoCurrency: "USD",
      name,
      merchant: null,
      plaidCategory: null,
      categoryId: "dining",
      pending: false,
      pendingTransactionId: null,
      categorizedBy: null,
      reviewState: "needs_look"
    };
    await kv.set(NS.transactions, "acc-1:2026-07", { transactions: [record] });
  }

  const row = async (kv: FinanceKv) =>
    ((await kv.get(NS.transactions, "acc-1:2026-07")) as { transactions: TransactionRecord[] })
      .transactions[0]!;

  const command = (createRule: boolean) => ({
    actorUserId: ACTOR,
    jobKind: "finance.review-apply",
    idempotencyKey: "k",
    params: {
      transactionIds: ["r-1"],
      accountIds: ["acc-1"],
      months: ["2026-07"],
      categoryIds: ["groceries"],
      createRule
    }
  });

  /** Ports whose store records the order of saves into the same log as the rule store. */
  function feedPorts(kv: FinanceKv, rules: MerchantRuleStore, events: string[]): WorkerPorts {
    const base = kvStore(kv);
    return portsFor(kv, {
      rules,
      putTransaction: async (record) => {
        events.push("save");
        await base.putTransaction(record);
      },
      appendActivity: async (entry) => {
        events.push(`activity:${entry.kind}`);
      }
    });
  }

  it("refuses payee text over the limit before it saves the category", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules } = ruleStore(["groceries"], events);
    await seed(kv, LONG_NAME);
    await kv.set(NS.rules, "rule:a", legacy("shell oil", "groceries"));

    await expect(
      reviewApplyHandler(feedPorts(kv, rules, events))(command(true))
    ).rejects.toMatchObject({ code: "rule_payee_too_long" });

    expect(events).toEqual([]);
    expect(await row(kv)).toMatchObject({ categoryId: "dining", reviewState: "needs_look" });
  });

  it("leaves the category as it was when the old-rule copy fails", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules, applied } = ruleStore(["groceries"], events, true);
    await seed(kv, "Blue Bottle 12");
    await kv.set(NS.rules, "rule:a", legacy("shell oil", "groceries"));

    await expect(reviewApplyHandler(feedPorts(kv, rules, events))(command(true))).rejects.toThrow(
      "import failed"
    );

    expect(events).toEqual(["import"]);
    expect(applied).toEqual([]);
    expect(await row(kv)).toMatchObject({ categoryId: "dining", reviewState: "needs_look" });
  });

  it("runs the checks, then saves the category, then writes the rule", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules } = ruleStore(["groceries"], events);
    await seed(kv, "Blue Bottle 12");
    await kv.set(NS.rules, "rule:a", legacy("shell oil", "groceries"));

    await reviewApplyHandler(feedPorts(kv, rules, events))(command(true));

    expect(events).toEqual(["import", "save", "activity:transaction.categorize", "apply"]);
    expect(await row(kv)).toMatchObject({ categoryId: "groceries", reviewState: "confirmed" });
  });

  it("does not check the payee text when no rule is asked for", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules } = ruleStore(["groceries"], events);
    await seed(kv, LONG_NAME);

    await reviewApplyHandler(feedPorts(kv, rules, events))(command(false));

    expect(events).toEqual(["save", "activity:transaction.categorize"]);
    expect(await row(kv)).toMatchObject({ categoryId: "groceries" });
  });

  it("saves the category and makes no rule for a name with no letters", async () => {
    const kv = memoryKv();
    const events: string[] = [];
    const { rules } = ruleStore(["groceries"], events);
    await seed(kv, "4521 #88");
    await kv.set(NS.rules, "rule:a", legacy("shell oil", "groceries"));

    await reviewApplyHandler(feedPorts(kv, rules, events))(command(true));

    expect(events).toEqual(["save", "activity:transaction.categorize"]);
    expect(await row(kv)).toMatchObject({ categoryId: "groceries" });
  });
});
