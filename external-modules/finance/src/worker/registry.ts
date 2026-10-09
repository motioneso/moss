// external-modules/finance/src/worker/registry.ts
//
// FIN-01 (#1146): the handler-key → factory registry, split out of index.ts
// because defineModuleWorker attaches a readline on process.stdin at import
// time — tests must be able to pin the full registry (all manifest handler
// keys) without triggering that side effect. index.ts stays a thin dispatch
// shell over this table. All four FIN-01 manifest handler keys are real as
// of Task 7 (#1146); notImplemented stays exported for FIN-02's Task 8 keys.
import { accountsListHandler } from "./handlers/accounts.js";
import { budgetApplyHandler, budgetAssignHandler, budgetStatusHandler } from "./handlers/budget.js";
import { connectPollHandler, connectStartHandler } from "./handlers/connect.js";
import {
  categorizeApplyHandler,
  reviewApplyHandler,
  transactionCategorizeNewHandler,
  transactionCategorizeHandler,
  transactionsQueryHandler
} from "./handlers/feed.js";
import { storageMigrateHandler } from "./handlers/migrate.js";
import { reportsNetWorthHandler, reportsSpendingHandler } from "./handlers/reports.js";
import { accountSetSharedHandler, shareApplyHandler } from "./handlers/shared.js";
import { setupStatusHandler } from "./handlers/setup.js";
import { syncRunHandler } from "./handlers/sync.js";
import type { WorkerPorts } from "./ports.js";
import type { ToolHandler } from "./wrap.js";

export type ToolFactory = (ports: WorkerPorts) => ToolHandler;

export const notImplemented: ToolFactory = () => async () => ({ status: "not-implemented" });

export const HANDLERS: Readonly<Record<string, ToolFactory>> = {
  "accounts.list": accountsListHandler,
  // Getting started (#3178): bank keys present, bank linked.
  "setup.status": setupStatusHandler,
  "connect.start": connectStartHandler,
  "connect.poll": connectPollHandler,
  "sync.run": syncRunHandler,
  // FIN-02 (#1147) Task 10: the feed surface declared by manifest v2.
  "transactions.query": transactionsQueryHandler,
  "transaction.categorize": transactionCategorizeHandler,
  "transaction.categorize-new": transactionCategorizeNewHandler,
  "categorize.apply": categorizeApplyHandler,
  // #3176: confirm or change rows from the Transactions screen.
  "review.apply": reviewApplyHandler,
  // FIN-03 (#1148) Task 3: the envelope-budget surface of manifest v0.2.0.
  "budget.status": budgetStatusHandler,
  "budget.assign": budgetAssignHandler,
  "budget.apply": budgetApplyHandler,
  // FIN-04 (#1149) Task 4: the household-sharing surface of manifest v0.3.0.
  "account.set-shared": accountSetSharedHandler,
  "share.apply": shareApplyHandler,
  // FIN-05 (#1150) Task 4: the read-only reports surface of manifest v0.4.0.
  "reports.spending": reportsSpendingHandler,
  "reports.net-worth": reportsNetWorthHandler,
  // FIN-06b (#1166) Task 6: the one-shot per-owner KV -> SQL backfill.
  // Queue-only — no assistant-tool twin (F6-D4).
  "storage.migrate": storageMigrateHandler
};
