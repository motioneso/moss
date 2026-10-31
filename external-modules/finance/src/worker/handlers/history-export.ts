import {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ROWS,
  ownedHistoryCsv
} from "../../domain/history-export.js";
import { isCalendarDate } from "../../domain/values.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
export const historyExportHandler: ToolFactory = (ports) => async (input) => {
  readString(input, "actorUserId", { required: true });
  const scope = {
    from: readString(input, "from"),
    through: readString(input, "through"),
    accountId: readString(input, "accountId")
  };
  if (
    (scope.from !== undefined && !isCalendarDate(scope.from)) ||
    (scope.through !== undefined && !isCalendarDate(scope.through)) ||
    (scope.from && scope.through && scope.from > scope.through)
  )
    throw new InputError(
      "Choose valid inclusive export dates, with the start on or before the end"
    );
  if (scope.accountId !== undefined && (!scope.accountId.trim() || scope.accountId.length > 256))
    throw new InputError("Choose a valid owned account");
  const store = await ports.store();
  if (!store.historyExport) return { status: "storage_update_required" };
  const result = await store.historyExport.read(scope);
  if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0)
    throw new InputError("The export count is invalid; no file was prepared");
  if (result.totalCount > MAX_HISTORY_ROWS)
    return { status: "too_many", totalCount: result.totalCount, maxRows: MAX_HISTORY_ROWS };
  if (result.rows.length !== result.totalCount)
    throw new InputError("The export is incomplete; no file was prepared");
  const csv = ownedHistoryCsv(result.rows);
  if (new TextEncoder().encode(csv).byteLength > MAX_HISTORY_BYTES)
    return { status: "too_large", totalCount: result.totalCount, maxBytes: MAX_HISTORY_BYTES };
  return {
    status: "ready",
    csv,
    totalCount: result.totalCount,
    scope,
    preparedAt: ports.now().toISOString()
  };
};
