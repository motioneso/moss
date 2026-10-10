// tests/unit/external-module-finance-manifest.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertModuleJobPayload } from "@moss/jobs";
import { validateExternalModuleManifest } from "@moss/module-registry";

// FIN-01 (#1146): the REAL shipped finance manifest must pass the merged external
// ABI, and targeted mutations must fail closed. Slice deltas vs the design spec
// (grounded-decisions D1–D4): Plaid creds are declared auth slots resolved at
// runtime (never in the manifest), the connect poll is a shared tool+queue
// handler, and the sweep schedule posts directly onto finance.sync-run.
const manifestPath = fileURLToPath(
  new URL("../../external-modules/finance/jarvis.module.json", import.meta.url)
);
const loadManifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

/** Counts keys named `key` at the top level of a JSON object, which JSON.parse hides. */
function countTopLevelKeys(text: string, key: string): number {
  let depth = 0;
  let count = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      let close = end;
      while (close > 0 && text[close - 1] === "\\") close = text.indexOf('"', close + 1);
      const name = text.slice(i + 1, close);
      const after = text.slice(close + 1).match(/^\s*:/);
      if (depth === 1 && after && name === key) count++;
      i = close;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return count;
}

describe("finance manifest app map (#3177)", () => {
  it("holds exactly one top-level appMap block", () => {
    expect(countTopLevelKeys(readFileSync(manifestPath, "utf8"), "appMap")).toBe(1);
  });

  it("declares its own settings page and the settings features (#3186)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      settingsPath: string;
      appMap: { screens: { id: string; path: string }[]; features: { id: string }[] };
    };
    expect(manifest.settingsPath).toBe("/settings");
    expect(manifest.appMap.screens).toContainEqual(
      expect.objectContaining({ id: "finance.settings", path: "/settings" })
    );
    expect(manifest.appMap.features.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "finance.settings-freedom",
        "finance.settings-limit",
        "finance.settings-actions",
        "finance.settings-bank-keys",
        "finance.settings-activity"
      ])
    );
  });

  it("declares the history-built first budget and no assistant tool that starts one (#3180)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      appMap: { features: { id: string }[] };
      assistantTools: { name: string; handler?: string }[];
    };
    expect(manifest.appMap.features.map((f) => f.id)).toContain("finance.first-budget");
    expect(manifest.assistantTools.map((t) => t.name)).toContain("finance.budget.draft.get");
    expect(manifest.assistantTools.filter((t) => t.handler === "draft.start")).toEqual([]);
    expect(manifest.assistantTools.filter((t) => t.handler === "draft.build")).toEqual([]);
  });

  it("lets chat adjust the draft through the drafting family, never start it (#3181)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assistantTools: { name: string; handler?: string; risk: string; actionFamilyId?: string }[];
      assistantActionFamilies: { id: string }[];
      worker: { queues: { name: string; handler: string }[] };
    };
    const update = manifest.assistantTools.find((t) => t.name === "finance.budget.draft.update");
    expect(update).toMatchObject({ risk: "write", actionFamilyId: "drafting" });
    expect(manifest.assistantActionFamilies.map((f) => f.id)).toContain("drafting");
    expect(manifest.worker.queues).toContainEqual(
      expect.objectContaining({ name: "finance.draft-set", handler: "draft.set" })
    );
    expect(manifest.assistantTools.filter((t) => t.handler === "draft.set")).toEqual([]);
  });

  it("the duplicate-key check really counts a repeated block", () => {
    expect(countTopLevelKeys('{"appMap":{"a":1},"x":{"appMap":2},"appMap":{}}', "appMap")).toBe(2);
  });
});

describe("finance manifest contract (#1146)", () => {
  it("accepts the shipped manifest against the merged ABI", () => {
    const result = validateExternalModuleManifest(loadManifest(), "finance", "0.1.0");
    expect(result.ok, JSON.stringify(!result.ok ? result.errors : [])).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe("finance");
    // FIN-02 (#1147): the module now declares its web surface. `path` is
    // module-relative — apps/api serializeExternalModule prefixes /m/finance,
    // so "/" is the plan's "/finance" route. `landmark` is not in the web
    // iconMap yet (falls back to Layers3); Task 11 adds it.
    expect(result.manifest.web).toEqual({ entrypoint: "dist/web/index.js", contractVersion: 2 });
    expect(result.manifest.navigation).toEqual([
      { id: "finance", label: "Finance", path: "/", icon: "landmark" }
    ]);
    expect(result.manifest.runtime).toEqual({
      workerEntrypoint: "dist/worker.js",
      workerContractVersion: 1
    });

    // Tool surface: name === permissionId (one permission per tool), and the
    // run-now tool shares its handler with the finance.sync-run queue (D3).
    expect((result.manifest.assistantTools ?? []).map((tool) => [tool.name, tool.handler])).toEqual(
      [
        ["finance.accounts.list", "accounts.list"],
        ["finance.setup.status", "setup.status"],
        ["finance.connect.start", "connect.start"],
        ["finance.connect.poll", "connect.poll"],
        ["finance.sync.run-now", "sync.run"],
        ["finance.transactions.query", "transactions.query"],
        ["finance.transaction.categorize", "transaction.categorize"],
        ["finance.transaction.categorize-new", "transaction.categorize-new"],
        ["finance.budget.status", "budget.status"],
        ["finance.budget.draft.get", "budget.draft.get"],
        ["finance.budget.draft.update", "budget.draft.update"],
        ["finance.budget.assign", "budget.assign"],
        ["finance.budget.move", "budget.move"],
        ["finance.rule.set", "rule.set"],
        ["finance.category.upsert", "category.upsert"],
        ["finance.category.archive", "category.archive"],
        ["finance.account.set-shared", "account.set-shared"],
        // FIN-05 (#1150): read-only report tools.
        ["finance.reports.spending", "reports.spending"],
        ["finance.reports.net-worth", "reports.net-worth"],
        // #3186: the Settings activity list.
        ["finance.activity.list", "activity.list"]
      ]
    );
    for (const tool of result.manifest.assistantTools ?? []) {
      expect(tool.permissionId).toBe(tool.name);
    }
    const riskOf = Object.fromEntries(
      (result.manifest.assistantTools ?? []).map((tool) => [tool.name, tool.risk])
    );
    expect(riskOf["finance.accounts.list"]).toBe("read");
    expect(riskOf["finance.connect.start"]).toBe("write");
    expect(riskOf["finance.connect.poll"]).toBe("write");
    expect(riskOf["finance.sync.run-now"]).toBe("write");
    expect(riskOf["finance.transactions.query"]).toBe("read");
    // Categorizing rewrites a stored record → write risk, so the assistant
    // path goes through confirmation (D4) like every other mutation.
    expect(riskOf["finance.transaction.categorize"]).toBe("write");
    // #3175: chat sorts a merchant under the family matching its history.
    const tools = result.manifest.assistantTools ?? [];
    const toolByName = (name: string) => tools.find((tool) => tool.name === name)!;
    expect(toolByName("finance.transaction.categorize")).toMatchObject({
      actionFamilyId: "sorting",
      executionPolicy: "auto"
    });
    expect(toolByName("finance.transaction.categorize-new")).toMatchObject({
      actionFamilyId: "sorting_new",
      executionPolicy: "auto",
      risk: "write"
    });
    // #3185: money moves carry the dollar limit; the limit defaults to $100.
    expect(toolByName("finance.budget.assign")).toMatchObject({
      actionFamilyId: "moving_money",
      confirmAbove: {
        inputKey: "amountCents",
        baseKey: "previousCents",
        preferenceKey: "freedomLimitDollars",
        scale: 100
      }
    });
    expect(toolByName("finance.budget.move")).toMatchObject({
      actionFamilyId: "moving_money",
      confirmAbove: { inputKey: "amountCents", preferenceKey: "freedomLimitDollars", scale: 100 }
    });
    expect(toolByName("finance.budget.move").confirmAbove?.baseKey).toBeUndefined();
    expect(toolByName("finance.rule.set").actionFamilyId).toBe("rules");
    expect(toolByName("finance.category.upsert").actionFamilyId).toBe("categories");
    expect(toolByName("finance.category.archive").actionFamilyId).toBe("categories");
    expect(result.manifest.preferences).toEqual([
      expect.objectContaining({ key: "freedomLimitDollars", type: "integer", default: 100 })
    ]);
    expect(
      Object.fromEntries(
        (result.manifest.assistantActionFamilies ?? []).map((f) => [f.id, f.freedom])
      )
    ).toMatchObject({ rules: "new", moving_money: "routine", categories: "new" });
    expect(result.manifest.assistantOnboarding?.guidance.split(/\s+/).length ?? 999).toBeLessThan(
      150
    );
    expect(toolByName("finance.connect.start").actionFamilyId).toBe("bank_connections");
    expect(toolByName("finance.connect.poll").actionFamilyId).toBe("bank_connections");
    expect(
      (result.manifest.assistantActionFamilies ?? []).map((family) => [
        family.id,
        family.defaultTier
      ])
    ).toEqual([
      ["sorting", "ask_each_time"],
      ["sorting_new", "ask_each_time"],
      ["rules", "ask_each_time"],
      ["moving_money", "ask_each_time"],
      ["categories", "ask_each_time"],
      ["bank_connections", "always_confirm"],
      ["drafting", "ask_each_time"],
      ["sharing", "always_confirm"]
    ]);
    // Sharing balances with the household must always ask, even unattended (review A1).
    expect(toolByName("finance.account.set-shared").actionFamilyId).toBe("sharing");
    expect(
      (result.manifest.assistantActionFamilies ?? []).find((family) => family.id === "sharing")
        ?.allowedTiers
    ).toEqual(["always_confirm"]);
    // FIN-03 (#1148): budget reads are free; assigning money is a mutation,
    // so the assistant path confirms (D4) while the web path enqueues
    // finance.budget-apply instead (D3).
    expect(riskOf["finance.budget.status"]).toBe("read");
    expect(riskOf["finance.budget.assign"]).toBe("write");
    // FIN-04 (#1149): flipping the household share writes the mirror, so the
    // assistant path must confirm (D4) exactly like every other mutation.
    expect(riskOf["finance.account.set-shared"]).toBe("write");
    // FIN-05 (#1150): reports are pure aggregation — read risk, and the host
    // rpc layer rejects any kv.set from them (forbidden_kv_mutation).
    expect(riskOf["finance.reports.spending"]).toBe("read");
    expect(riskOf["finance.reports.net-worth"]).toBe("read");

    // Credential slots: instance Plaid keys (admin-entered at runtime) + the
    // per-user token map. Tokens live ONLY in app.module_credentials — no KV
    // namespace below may ever hold them.
    expect(result.manifest.auth).toEqual([
      {
        id: "finance.plaid-client-id",
        displayName: "Plaid client id",
        kind: "api-key",
        scope: "instance"
      },
      {
        id: "finance.plaid-secret",
        displayName: "Plaid secret",
        kind: "api-key",
        scope: "instance"
      },
      {
        id: "finance.plaid-tokens",
        displayName: "Plaid access tokens",
        kind: "api-key",
        scope: "user"
      }
    ]);

    // Per-user namespaces from the design spec; settings alone carries an
    // instance scope (admin-gated `plaid` → {environment} key, default write
    // policy). FIN-04 (#1149) adds finance.shared: instance-only with
    // instanceWritePolicy "module" — the FIN-00 D2 seam that lets worker
    // handlers (not just admins) write the household mirror. FIN-06b (#1166)
    // adds finance.meta: separate from settings so a future settings
    // wipe/export can never touch the storage-migrate marker.
    expect(result.manifest.storage).toEqual([
      { namespace: "finance.connections", scopes: ["user"] },
      { namespace: "finance.accounts", scopes: ["user"] },
      { namespace: "finance.transactions", scopes: ["user"] },
      { namespace: "finance.categories", scopes: ["user"] },
      { namespace: "finance.rules", scopes: ["user"] },
      { namespace: "finance.snapshots", scopes: ["user"] },
      { namespace: "finance.budgets", scopes: ["user"] },
      { namespace: "finance.shared", scopes: ["instance"], instanceWritePolicy: "module" },
      { namespace: "finance.settings", scopes: ["user", "instance"] },
      { namespace: "finance.meta", scopes: ["user"] }
    ]);

    // D2/D3: connect-poll queue shares the tool handler; the six-hourly sweep
    // posts directly onto finance.sync-run (no sweep handler exists).
    expect(result.manifest.worker?.queues).toEqual([
      { name: "finance.sync-run", handler: "sync.run", retryLimit: 3, allowManualRun: true },
      {
        name: "finance.connect-poll",
        handler: "connect.poll",
        retryLimit: 5,
        allowManualRun: true
      },
      {
        name: "finance.categorize-apply",
        handler: "categorize.apply",
        // No retry: the web feed shows the failure and the user just clicks
        // again — retrying a category write hours later would surprise them.
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            accountId: { type: "identifier" },
            month: { type: "identifier" },
            transactionId: { type: "identifier" },
            categoryId: { type: "identifier" }
          }
        }
      },
      {
        name: "finance.budget-apply",
        handler: "budget.apply",
        // Assign sets a total (never increments), so a duplicate apply is
        // harmless — but like categorize-apply, a retry hours later would
        // surprise the user, so fail once and let the UI surface it.
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            month: { type: "identifier" },
            categoryId: { type: "identifier" },
            // The bounded-integer param type (module-params.ts) is what makes
            // an amount a legal queue param under D6's command-param carve-out.
            amountCents: { type: "integer", min: -100000000, max: 100000000 },
            // Batch shape: parallel arrays, at most twenty categories per job.
            categoryIds: { type: "array", maxItems: 20, items: { type: "identifier" } },
            amountsCents: {
              type: "array",
              maxItems: 20,
              items: { type: "integer", min: -100000000, max: 100000000 }
            }
          }
        }
      },
      {
        name: "finance.share-apply",
        handler: "share.apply",
        // FIN-04 (#1149): the flag write is an idempotent SET (share ON
        // mirrors, OFF deletes the prefix), so a stale retry could silently
        // undo a newer user decision — fail once and let the UI surface it.
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            accountId: { type: "identifier" },
            shared: { type: "boolean" }
          }
        }
      },
      {
        // FIN-06b (#1166): the one-shot per-owner backfill — no paramsSchema,
        // pure metadata job (F6-D4), replay-safe so retryLimit is moot but
        // pinned to 1 to match the module's other one-shot writes.
        name: "finance.storage-migrate",
        handler: "storage.migrate",
        retryLimit: 1,
        allowManualRun: true
      },
      {
        // #3180: build the first-budget draft; no params.
        name: "finance.draft-build",
        handler: "draft.build",
        retryLimit: 1,
        allowManualRun: true
      },
      {
        // #3180: the only path that starts a budget; the button sends it.
        name: "finance.draft-start",
        handler: "draft.start",
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: { type: "object", fields: { draftId: { type: "uuid" } } }
      },
      {
        // #3181: a plan amount typed on the draft screen.
        name: "finance.draft-set",
        handler: "draft.set",
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            draftId: { type: "uuid" },
            categoryKey: { type: "identifier" },
            amountCents: { type: "integer", min: 0, max: 100000000 }
          }
        }
      },
      {
        // #3176: confirm or change Needs a look rows. Parallel id lists (queue params
        // allow arrays of scalars only); one job so the per-user manual singleton
        // never drops part of a Confirm all.
        name: "finance.review-apply",
        handler: "review.apply",
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            transactionIds: { type: "array", maxItems: 200, items: { type: "identifier" } },
            accountIds: { type: "array", maxItems: 200, items: { type: "identifier" } },
            months: { type: "array", maxItems: 200, items: { type: "identifier" } },
            categoryIds: { type: "array", maxItems: 200, items: { type: "identifier" } },
            createRule: { type: "boolean" }
          }
        }
      },
      {
        // #3186: reverse one activity row; the handler refuses when the data moved on.
        name: "finance.activity-undo",
        handler: "activity.undo",
        retryLimit: 1,
        allowManualRun: true,
        paramsSchema: { type: "object", fields: { activityId: { type: "uuid" } } }
      }
    ]);
    expect(result.manifest.worker?.schedules).toEqual([
      {
        id: "finance.sync-sweep",
        cron: "41 */6 * * *",
        scope: "user",
        jobKind: "finance.sync-sweep",
        queue: "finance.sync-run"
      }
    ]);
    // FIN-06b (#1166): the reconcile sweep that drives every owner through
    // storage-migrate without a manual per-user trigger.
    expect(result.manifest.worker?.reconcileJobs).toEqual([
      {
        id: "storage-migrate",
        queue: "finance.storage-migrate",
        jobKind: "finance.storage-migrate"
      }
    ]);

    expect(result.manifest.fetchHosts).toEqual(["production.plaid.com", "sandbox.plaid.com"]);
  });

  it("every tool declares a strict input schema; connect.start allows only environment", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type, String(tool.name)).toBe("object");
      expect(schema.additionalProperties, String(tool.name)).toBe(false);
    }
    const start = tools.find((tool) => tool.name === "finance.connect.start")!;
    const props = (start.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(Object.keys(props)).toEqual(["environment"]);
    expect(props.environment?.enum).toEqual(["production", "sandbox"]);
    expect((start.inputSchema as Record<string, unknown>).required).toBeUndefined();

    // FIN-02 (#1147): feed tools. Query is all-optional (defaults to the
    // current month); categorize pins the four ids and only the assistant
    // path may carry createRule/notes — the queue twin (paramsSchema above)
    // deliberately has no place for either.
    const query = tools.find((tool) => tool.name === "finance.transactions.query")!;
    const querySchema = query.inputSchema as {
      properties: Record<string, unknown>;
      required?: unknown;
    };
    expect(Object.keys(querySchema.properties)).toEqual([
      "month",
      "accountId",
      "categoryId",
      "search",
      "pendingOnly",
      "needsLookOnly",
      "limit"
    ]);
    expect(querySchema.required).toBeUndefined();
    const categorize = tools.find((tool) => tool.name === "finance.transaction.categorize")!;
    const categorizeSchema = categorize.inputSchema as {
      properties: Record<string, unknown>;
      required?: unknown;
    };
    expect(Object.keys(categorizeSchema.properties)).toEqual([
      "transactionId",
      "accountId",
      "month",
      "categoryId",
      "amountCents",
      "notes"
    ]);
    expect(categorizeSchema.required).toEqual([
      "transactionId",
      "accountId",
      "month",
      "categoryId",
      "amountCents"
    ]);

    // FIN-05 (#1150): both report tools take ONLY an optional bounded months
    // count (default 6 handler-side) — no free text can reach a report call.
    for (const name of ["finance.reports.spending", "finance.reports.net-worth"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      const schema = tool.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
        additionalProperties?: unknown;
        required?: unknown;
      };
      expect(Object.keys(schema.properties), name).toEqual(["months"]);
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.required, name).toBeUndefined();
      expect(schema.properties.months, name).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 24
      });
    }
  });

  it("payloads pass the platform metadata-only gate and reject undeclared params", () => {
    const result = validateExternalModuleManifest(loadManifest(), "finance", "0.1.0");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const syncQueue = result.manifest.worker!.queues![0]!;
    const base = {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      moduleId: "finance",
      manifestHash: `sha256:${"a".repeat(64)}`
    };
    expect(() =>
      assertModuleJobPayload(syncQueue, { ...base, jobKind: "finance.sync-sweep" })
    ).not.toThrow();
    // No paramsSchema declared → ANY params object is rejected, which is the
    // fail-closed gate keeping account/transaction content out of pg-boss.
    expect(() =>
      assertModuleJobPayload(syncQueue, {
        ...base,
        jobKind: "finance.sync-run-now",
        params: { payee: "ACME GROCERY #42" }
      })
    ).toThrow();

    // FIN-02 (#1147): categorize-apply carries exactly four identifier-typed
    // ids, nothing else. Free text (notes, payee names) must never ride
    // pg-boss (D6): an undeclared key fails closed.
    const applyQueue = result.manifest.worker!.queues![2]!;
    const applyParams = {
      accountId: "acc-1",
      month: "2026-07",
      transactionId: "tx-plaid-001",
      categoryId: "dining"
    };
    expect(() =>
      assertModuleJobPayload(applyQueue, {
        ...base,
        jobKind: "finance.categorize-apply",
        params: applyParams
      })
    ).not.toThrow();
    expect(() =>
      assertModuleJobPayload(applyQueue, {
        ...base,
        jobKind: "finance.categorize-apply",
        params: { ...applyParams, notes: "lunch with sam" }
      })
    ).toThrow();

    // FIN-03 (#1148): budget-apply carries a bounded integer command param
    // (the new assignment total). In-range integers pass; floats, strings,
    // and out-of-range values fail closed at the platform gate.
    const budgetQueue = result.manifest.worker!.queues![3]!;
    const budgetParams = { month: "2026-07", categoryId: "groceries", amountCents: 50000 };
    expect(() =>
      assertModuleJobPayload(budgetQueue, {
        ...base,
        jobKind: "finance.budget-apply",
        params: budgetParams
      })
    ).not.toThrow();
    for (const bad of [50000.5, "50000", 100000001, -100000001]) {
      expect(() =>
        assertModuleJobPayload(budgetQueue, {
          ...base,
          jobKind: "finance.budget-apply",
          params: { ...budgetParams, amountCents: bad }
        })
      ).toThrow();
    }

    // FIN-04 (#1149): share-apply carries the account id plus a boolean flag —
    // the flag is a command param (D6 carve-out), never account content.
    // Non-boolean shapes and undeclared keys fail closed at the platform gate.
    const shareQueue = result.manifest.worker!.queues![4]!;
    const shareParams = { accountId: "acc-1", shared: true };
    expect(() =>
      assertModuleJobPayload(shareQueue, {
        ...base,
        jobKind: "finance.share-apply",
        params: shareParams
      })
    ).not.toThrow();
    expect(() =>
      assertModuleJobPayload(shareQueue, {
        ...base,
        jobKind: "finance.share-apply",
        params: { ...shareParams, shared: "true" }
      })
    ).toThrow();
    expect(() =>
      assertModuleJobPayload(shareQueue, {
        ...base,
        jobKind: "finance.share-apply",
        params: { ...shareParams, accountName: "Everyday Checking" }
      })
    ).toThrow();
  });

  it("rejects a token-bearing KV namespace outside the finance prefix", () => {
    const manifest = loadManifest();
    const storage = manifest.storage as Array<Record<string, unknown>>;
    const mutated = {
      ...manifest,
      storage: [...storage, { namespace: "demo-module.feed", scopes: ["user"] }]
    };
    const result = validateExternalModuleManifest(mutated, "finance", "0.1.0");
    expect(result.ok).toBe(false);
  });

  it("rejects duplicated permission ids", () => {
    const manifest = loadManifest();
    const tools = manifest.assistantTools as Array<Record<string, unknown>>;
    const mutated = {
      ...manifest,
      assistantTools: [
        { ...tools[0], permissionId: "finance.read" },
        { ...tools[1], permissionId: "finance.read" }
      ]
    };
    const result = validateExternalModuleManifest(mutated, "finance", "0.1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("unique");
  });

  it("rejects a non-api-key auth kind (fail closed on future credential kinds)", () => {
    const manifest = loadManifest();
    const auth = manifest.auth as Array<Record<string, unknown>>;
    const mutated = { ...manifest, auth: [{ ...auth[0], kind: "oauth" }] };
    const result = validateExternalModuleManifest(mutated, "finance", "0.1.0");
    expect(result.ok).toBe(false);
  });

  it("rejects forbidden executable-surface fields", () => {
    const result = validateExternalModuleManifest(
      { ...loadManifest(), permissions: [] },
      "finance",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
  });

  it("fails closed on a compound compatibility range", () => {
    const result = validateExternalModuleManifest(
      { ...loadManifest(), compatibility: { jarv1s: ">=0.1.0 <0.2.0" } },
      "finance",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
  });
});
