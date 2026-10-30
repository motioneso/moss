import {
  rulesListHandler,
  rulesPreviewHandler,
  rulesUpdateHandler
} from "./handlers/merchant-rules.js";
import { transferContextHandler, transferCreateHandler } from "./handlers/manual-transfers.js";
import { accountReviewHandler, accountUpdateHandler } from "./handlers/account-lifecycle.js";
import { historyExportHandler } from "./handlers/history-export.js";
import { reportsTransactionsHandler } from "./handlers/report-details.js";
import {
  transactionsBulkCategoryHandler,
  transactionsConfirmHandler
} from "./handlers/transaction-bulk.js";
import { flexPreviewHandler, flexConfigureHandler, flexAssignHandler } from "./handlers/flex.js";
import {
  billsReadHandler,
  billClearHandler,
  billCreateHandler,
  billDecideHandler,
  billStopHandler
} from "./handlers/bills.js";
// external-modules/finance/src/worker/registry.ts
//
// FIN-01 (#1146): the handler-key → factory registry, split out of index.ts
// because defineModuleWorker attaches a readline on process.stdin at import
// time — tests must be able to pin the full registry (all manifest handler
// keys) without triggering that side effect. index.ts stays a thin dispatch
// shell over this table. All four FIN-01 manifest handler keys are real as
// of Task 7 (#1146); notImplemented stays exported for FIN-02's Task 8 keys.
import {
  manualContextHandler,
  manualAccountCreateHandler,
  manualEntryCreateHandler
} from "./handlers/manual-ledger.js";
import { targetSetHandler } from "./handlers/targets.js";
import { budgetConfigureHandler } from "./handlers/budget-context.js";
import { importPreviewHandler, importApplyHandler } from "./handlers/import.js";
import {
  reconciliationReadHandler,
  reconciliationFinishHandler
} from "./handlers/reconciliation.js";
import { activityListHandler, activityUndoHandler } from "./handlers/activity.js";
import { accountsListHandler } from "./handlers/accounts.js";
import {
  budgetApplyHandler,
  budgetAssignHandler,
  budgetMoveHandler,
  budgetStatusHandler
} from "./handlers/budget.js";
import {
  categoryArchiveHandler,
  categoryUpsertHandler,
  ruleSetHandler
} from "./handlers/organize.js";
import { connectPollHandler, connectStartHandler } from "./handlers/connect.js";
import {
  categorizeApplyHandler,
  reviewApplyHandler,
  transactionCategorizeNewHandler,
  transactionCategorizeHandler,
  transactionsQueryHandler
} from "./handlers/feed.js";
import {
  draftBuildHandler,
  draftBuildToolHandler,
  draftGetHandler,
  draftSetHandler,
  draftStartHandler,
  draftStartToolHandler,
  draftUpdateHandler
} from "./handlers/draft.js";
import { storageMigrateHandler } from "./handlers/migrate.js";
import { reportsNetWorthHandler, reportsSpendingHandler } from "./handlers/reports.js";
import { accountSetSharedHandler, shareApplyHandler } from "./handlers/shared.js";
import { setupStatusHandler } from "./handlers/setup.js";
import { syncRunHandler } from "./handlers/sync.js";
import { splitApplyHandler, transactionSplitHandler } from "./handlers/split.js";
import type { WorkerPorts } from "./ports.js";
import type { ToolHandler } from "./wrap.js";

export type ToolFactory = (ports: WorkerPorts) => ToolHandler;

export const notImplemented: ToolFactory = () => async () => ({ status: "not-implemented" });

export const HANDLERS: Readonly<Record<string, ToolFactory>> = {
  "accounts.list": accountsListHandler,
  "rules.list": rulesListHandler,
  "rules.preview": rulesPreviewHandler,
  "rules.update": rulesUpdateHandler,
  "manual.context": manualContextHandler,
  "manual.transfer-context": transferContextHandler,
  "manual.transfer-create": transferCreateHandler,
  "manual.account-review": accountReviewHandler,
  "manual.account-update": accountUpdateHandler,
  "manual.account-create": manualAccountCreateHandler,
  "manual.entry-create": manualEntryCreateHandler,
  "import.preview": importPreviewHandler,
  "import.apply": importApplyHandler,
  "reconciliation.read": reconciliationReadHandler,
  "reconciliation.finish": reconciliationFinishHandler,
  // Getting started (#3178): bank keys present, bank linked.
  "setup.status": setupStatusHandler,
  "connect.start": connectStartHandler,
  "connect.poll": connectPollHandler,
  "sync.run": syncRunHandler,
  // FIN-02 (#1147) Task 10: the feed surface declared by manifest v2.
  "transactions.query": transactionsQueryHandler,
  "transactions.export": historyExportHandler,
  "transactions.bulk-category": transactionsBulkCategoryHandler,
  "transactions.confirm": transactionsConfirmHandler,
  "transaction.categorize": transactionCategorizeHandler,
  "transaction.categorize-new": transactionCategorizeNewHandler,
  "categorize.apply": categorizeApplyHandler,
  // #3176: confirm or change rows from the Transactions screen.
  "review.apply": reviewApplyHandler,
  "split.apply": splitApplyHandler,
  "transaction.split": transactionSplitHandler,
  // FIN-03 (#1148) Task 3: the envelope-budget surface of manifest v0.2.0.
  "budget.status": budgetStatusHandler,
  "flex.preview": flexPreviewHandler,
  "flex.configure": flexConfigureHandler,
  "flex.assign": flexAssignHandler,
  "target.set": targetSetHandler,
  "bills.read": billsReadHandler,
  billClearHandler,
  "bill.create": billCreateHandler,
  "bill.decide": billDecideHandler,
  "bill.stop": billStopHandler,
  "bill.clear": billClearHandler,
  "budget.configure": budgetConfigureHandler,
  "budget.assign": budgetAssignHandler,
  "budget.apply": budgetApplyHandler,
  // First-budget edits and start use reviewed host tools; legacy queues require the same review.
  "budget.draft.get": draftGetHandler,
  "draft.build": draftBuildHandler,
  "budget.draft.build": draftBuildToolHandler,
  "draft.start": draftStartHandler,
  "budget.draft.start": draftStartToolHandler,
  "budget.draft.update": draftUpdateHandler,
  "draft.set": draftSetHandler,
  // #3185: chat money and category actions.
  "budget.move": budgetMoveHandler,
  "rule.set": ruleSetHandler,
  "category.upsert": categoryUpsertHandler,
  "category.archive": categoryArchiveHandler,
  // FIN-04 (#1149) Task 4: the household-sharing surface of manifest v0.3.0.
  "account.set-shared": accountSetSharedHandler,
  "share.apply": shareApplyHandler,
  // FIN-05 (#1150) Task 4: the read-only reports surface of manifest v0.4.0.
  "reports.spending": reportsSpendingHandler,
  "reports.transactions": reportsTransactionsHandler,
  "reports.net-worth": reportsNetWorthHandler,
  // #3186: Finance Settings activity list and its undo.
  "activity.list": activityListHandler,
  "activity.undo": activityUndoHandler,
  // FIN-06b (#1166) Task 6: the one-shot per-owner KV -> SQL backfill.
  // Queue-only — no assistant-tool twin (F6-D4).
  "storage.migrate": storageMigrateHandler
};
