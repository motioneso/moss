import { FinanceKvError } from "../../domain/errors.js";
import {
  ledgerNetWorthInputs,
  netWorthCoverage,
  NetWorthHistoryError
} from "../../domain/net-worth-ledger.js";
import { today } from "./manual-ledger.js";
import { loadReportRows, readWindow } from "./report-rows.js";
// external-modules/finance/src/worker/handlers/reports.ts
//
// FIN-05 (#1150): the two report tools (spec delta §"Manifest delta"). Both
// are risk "read" — pure aggregation, no KV writes (the host rejects
// mutation from read tools with forbidden_kv_mutation, which is exactly the
// posture reports want). Windows come from ports.now(); never ambient time.
import type { SnapshotChunk, TransactionRecord } from "../../domain/index.js";
import { aggregateSpending, deriveNetWorth, excludeTransfers } from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

function currencyScope(input: Record<string, unknown>, values: string[]) {
  const requested = readString(input, "currency");
  if (requested !== undefined && !/^[A-Z]{3}$/.test(requested))
    throw new InputError("currency must be a three-letter uppercase code");
  const currencies = [...new Set(values)].sort();
  return {
    currencies,
    currency: requested ?? (currencies.length === 1 ? currencies[0]! : null),
    currencySelectionRequired: requested === undefined && currencies.length > 1
  };
}

export const reportsSpendingHandler: ToolFactory = (ports) => async (input) => {
  const { window, own, sharedByOwner } = await loadReportRows(ports, input);

  const scope = currencyScope(
    input,
    [own, ...sharedByOwner.values()]
      .flat()
      .filter((row) => window.includes(row.date.slice(0, 7)))
      .map((row) => row.isoCurrency)
  );
  const inCurrency = (rows: TransactionRecord[]) =>
    excludeTransfers(rows).filter(
      (row) => scope.currency === null || row.isoCurrency === scope.currency
    );
  return {
    window,
    ...scope,
    own: scope.currencySelectionRequired ? [] : aggregateSpending(inCurrency(own), window),
    shared: scope.currencySelectionRequired
      ? []
      : [...sharedByOwner.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .flatMap(([ownerUserId, rows]) => {
            const scoped = inCurrency(rows);
            if (!scoped.some((row) => window.includes(row.date.slice(0, 7)))) return [];
            return [{ ownerUserId, months: aggregateSpending(scoped, window) }];
          }),
    // Taxonomy rides along so the screen renders category names from one
    // call (same shape transactions.query ships).
    categories: await loadCategories(ports)
  };
};

export const reportsNetWorthHandler: ToolFactory = (ports) => async (input) => {
  readString(input, "actorUserId", { required: true });
  const window = readWindow(input, ports);

  const store = await ports.store();
  const accounts = await store.listAccounts();
  const scope = currencyScope(
    input,
    accounts.map((account) => account.isoCurrency)
  );
  if (scope.currencySelectionRequired) return { window, ...scope, points: [], headlineCents: null };
  const selectedAccounts = accounts.filter((account) => account.isoCurrency === scope.currency);
  const selectedIds = new Set(selectedAccounts.map((account) => account.accountId));
  // ALL snapshot chunks, not just window months: pre-window snapshots feed
  // carry-forward into the window (domain/net-worth.ts contract). Bounded by
  // accounts × months-since-connect. Own-only by design — snapshots are
  // never mirrored, so the mirror port is untouched here.
  const chunks: Record<string, SnapshotChunk> = {};
  for (const { accountId, month } of await store.listSnapshotChunks()) {
    if (!selectedIds.has(accountId)) continue;
    const days = await store.getSnapshotChunk(accountId, month);
    if (days) chunks[`${accountId}:${month}`] = { days };
  }
  const currentDate = ports.localTimezone ? today(ports) : ports.now().toISOString().slice(0, 10);
  const manualSupported = Boolean(store.manual?.netWorthMovements);
  const movements =
    selectedAccounts.some((a) => a.source === "manual") && manualSupported
      ? await store.manual!.netWorthMovements!(currentDate)
      : [];
  try {
    const history = ledgerNetWorthInputs(
      selectedAccounts,
      chunks,
      movements,
      currentDate,
      window,
      manualSupported
    );
    const series = deriveNetWorth(selectedAccounts, history.chunks, window, history.referenceDays);
    const asOf = series.points.at(-1)?.date ?? null;
    return {
      window,
      ...scope,
      ...series,
      asOf,
      coverage: netWorthCoverage(history, selectedAccounts, asOf)
    };
  } catch (error) {
    if (
      error instanceof NetWorthHistoryError ||
      error instanceof RangeError ||
      (error instanceof FinanceKvError && error.code === "invalid_record")
    )
      return {
        window,
        ...scope,
        points: [],
        headlineCents: null,
        asOf: null,
        coverage: [],
        unavailableReason:
          error instanceof NetWorthHistoryError ? "invalid_history" : "unsafe_money"
      };
    throw error;
  }
};
