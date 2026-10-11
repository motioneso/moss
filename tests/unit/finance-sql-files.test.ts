// tests/unit/finance-sql-files.test.ts
// FIN-06a (#1166): the finance DDL ships as module migrations and must satisfy
// the #914 D3 wire contract (one statement, allowlisted first command) BEFORE
// an install ever runs — loadModuleMigrationFiles throws on violations.
import { describe, expect, it } from "vitest";

import { loadModuleMigrationFiles } from "@moss/db";

describe("finance module sql directory", () => {
  it("loads all eighteen migration files through the module-sql-runner validator", async () => {
    const files = await loadModuleMigrationFiles("external-modules/finance/sql");
    expect(files.map((file) => file.name.replace(/\.sql$/, ""))).toEqual([
      "0001_create_finance_items",
      "0002_create_finance_accounts",
      "0003_index_finance_accounts_item",
      "0004_create_finance_transactions",
      "0005_index_finance_transactions_account_date",
      "0006_index_finance_transactions_date",
      "0007_create_finance_balance_snapshots",
      "0008_create_finance_budget_assignments",
      "0009_add_finance_items_last_error_detail",
      "0010_create_finance_categories",
      "0011_add_finance_transactions_review",
      "0012_index_finance_transactions_review",
      "0013_create_finance_activity",
      "0014_index_finance_activity_at",
      "0015_add_finance_items_institution_name",
      "0016_flag_uncategorized_finance_transactions",
      "0017_create_finance_budget_drafts",
      "0018_create_finance_budget_draft_lines"
    ]);
  });
});
