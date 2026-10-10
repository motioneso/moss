// external-modules/finance/src/worker/index.ts
// FIN-01 (#1146): tool dispatch shell over the registry (job-search index.ts
// pattern). Each tool is a factory over WorkerPorts so handler logic stays
// testable without the SDK runtime; `wrap` turns the scrubbed-by-construction
// error types into structured results and rethrows everything else (→ generic
// handler_failed at the protocol layer, no accidental message leak). The
// registry lives in registry.ts because defineModuleWorker is side-effecting
// at import time (stdin readline) — tests import the registry, never this.
import { defineModuleWorker } from "@moss/module-sdk/worker";
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { fetchFromWorkerContext } from "../adapters/index.js";
import { createPlaid } from "../adapters/plaid.js";
import type { FinanceDb } from "../domain/index.js";
import { kvFromWorkerContext, mirrorFromWorkerContext, NS } from "../domain/index.js";
import { credsFromWorkerContext, tokensFromWorkerContext } from "./auth-port.js";
import type { FinanceAi, WorkerPorts } from "./ports.js";
import { aiFromWorkerContext } from "./ports.js";
import type { ToolFactory } from "./registry.js";
import { HANDLERS } from "./registry.js";
import { storeSelector } from "./store.js";
import { wrap } from "./wrap.js";

// ctx.ai is read structurally (job-search precedent) so this worker builds
// against today's SDK and degrades gracefully when no AI bridge is present.
type MaybeAiContext = ModuleWorkerContext & { readonly ai?: FinanceAi };
// ctx.db (#1167) is read the same structural way — an older host simply
// omits it, and storeSelector degrades every owner to the KV store (F6-D4).
type MaybeDbContext = ModuleWorkerContext & { readonly db?: FinanceDb };

function ports(ctx: ModuleWorkerContext): WorkerPorts {
  const ai = (ctx as MaybeAiContext).ai;
  const db = (ctx as MaybeDbContext).db;
  const kv = kvFromWorkerContext(ctx.kv);
  return {
    kv,
    // FIN-04 (#1149): the household mirror, pinned to instance-scope
    // finance.shared inside the adapter (structural namespace isolation).
    mirror: mirrorFromWorkerContext(ctx.kv),
    ai: ai ? aiFromWorkerContext(ai) : null,
    // FIN-06b (#1166): same structural nullable pattern as ai — storage.migrate
    // is the only handler that reads this directly (see ports.ts).
    db: db ?? null,
    // ctx.fetch is typed required on ModuleWorkerContext, but guard anyway:
    // an older host omitting it must degrade to a structured fetch error,
    // never a worker crash.
    plaid: ctx.fetch
      ? (env, creds) => createPlaid(fetchFromWorkerContext(ctx.fetch), env, creds)
      : null,
    // auth-port.ts is the ONLY code allowed to touch ctx.auth (Task 5, #1146).
    tokens: tokensFromWorkerContext(ctx.auth),
    creds: credsFromWorkerContext(ctx.auth),
    settings: {
      // Instance-scoped finance.settings key "plaid" → { environment } —
      // admin-configured; anything unreadable or unexpected means production.
      getEnvironment: async () => {
        try {
          const record = await ctx.kv.get("instance", NS.settings, "plaid");
          return record?.environment === "sandbox" ? "sandbox" : "production";
        } catch {
          return "production";
        }
      }
    },
    // ModuleWorkerContext exposes no admin flag (re-checked at Task 5, #1146:
    // worker.ts ctx = input/auth/fetch/kv/ai only) — admin-gated inputs
    // (connect.start environment override) stay dropped until the SDK adds one.
    isAdmin: false,
    actionPolicy: ctx.actionPolicy,
    now: () => new Date(),
    // FIN-06b (#1166 F6-D4): built once per invocation over this call's own
    // kv/db, then memoized inside the closure — see worker/store.ts.
    store: storeSelector(kv, db)
  };
}

const tool = (factory: ToolFactory) => (ctx: ModuleWorkerContext) =>
  wrap(factory(ports(ctx)))(ctx.input);

defineModuleWorker({
  handlers: Object.fromEntries(
    Object.entries(HANDLERS).map(([key, factory]) => [key, tool(factory)])
  )
});
