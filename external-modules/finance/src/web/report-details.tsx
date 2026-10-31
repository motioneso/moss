import {
  Badge,
  Button,
  Dialog,
  Note,
  RowIndex,
  RowIndexItem,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { ReportDetailRow, ReportDetailScope } from "../domain/report-details";
import { formatCents, monthLabel, shortDayLabel } from "./format";
import { outcomeGate } from "./states";
import { invalidateToolQueries, useToolQuery } from "./store";
import { useReadCooldown } from "./read-cooldown";
export interface ReportSelection extends ReportDetailScope {
  label: string;
  expectedCents: number;
  months: number;
  sharedOwnerIds: string[];
}
interface DetailsResult extends Record<string, unknown> {
  rows: (ReportDetailRow & { accountName: string })[];
  totalCount: number;
  totalCents: number;
  offset: number;
  limit: number;
}
export function ReportDetails(props: {
  selection: ReportSelection;
  onClose: () => void;
}): ReactNodeLike {
  const [scope] = useState(() => ({
    ...props.selection,
    sharedOwnerIds: [...props.selection.sharedOwnerIds]
  }));
  const [offset, setOffset] = useState(0);
  const query = useToolQuery<DetailsResult>("finance.reports.transactions", {
    month: scope.month,
    currency: scope.currency,
    group: scope.group,
    ...(scope.key === undefined ? {} : { key: scope.key }),
    months: scope.months,
    sharedOwnerIds: scope.sharedOwnerIds,
    offset,
    limit: 50
  });
  const loaded =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  const error = query.status === "settled" && query.outcome.kind === "error" ? query.outcome : null;
  const seconds = error?.retryAfterSeconds;
  const cooldown = useReadCooldown();
  useEffect(() => {
    if (seconds) cooldown.wait(seconds);
  }, [seconds]);
  const paused = cooldown.cooling || query.status === "loading";
  return (
    <Dialog
      title="Report transactions"
      description={`${scope.label.length > 120 ? `${scope.label.slice(0, 117)}…` : scope.label} · ${monthLabel(scope.month)} · ${scope.currency}`}
      scrollBody
      onClose={props.onClose}
      closeLabel="Close report transactions"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={paused}
            onClick={() => {
              if (!paused) invalidateToolQueries("finance.reports.transactions");
            }}
          >
            Reload details
          </Button>
          {offset > 0 || (loaded?.totalCount ?? 0) > 50 ? (
            <>
              <Button
                variant="secondary"
                disabled={paused || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous page
              </Button>
              <Button
                variant="secondary"
                disabled={paused || !loaded || offset + loaded.rows.length >= loaded.totalCount}
                onClick={() => setOffset(offset + 50)}
              >
                Next page
              </Button>
            </>
          ) : null}
          <Button onClick={props.onClose}>Close</Button>
        </>
      }
    >
      <div className="fnm-block">
        <p>
          Report amount: <strong>{formatCents(scope.expectedCents, scope.currency)}</strong>
        </p>
        {query.status === "settled" && query.outcome.kind === "error" ? (
          <p role="alert">
            {seconds
              ? `${error!.message} Your report selection is kept.`
              : "Report transactions could not load. Your selection is kept. Check your connection and reload details; if the report period changed, close and refresh Reports."}
          </p>
        ) : (
          outcomeGate(
            query,
            (result) => (
              <div className="fnm-block fnm-block--tight">
                <div className="fnm-spread">
                  <strong>
                    Current detail total: {formatCents(result.totalCents, scope.currency)}
                  </strong>
                  <span role="status">
                    {result.rows.length
                      ? `${result.offset + 1}–${result.offset + result.rows.length} of ${result.totalCount} transactions`
                      : `0 rows loaded · ${result.totalCount} matching transactions`}
                  </span>
                </div>
                {result.totalCents !== scope.expectedCents ? (
                  <Note variant="practical">
                    The records changed since this report was shown. The detail total reflects this
                    read; reload Reports to update its totals.
                  </Note>
                ) : null}
                {result.rows.length ? (
                  <RowIndex density="compact">
                    {result.rows.map((row) => (
                      <RowIndexItem
                        key={`${row.ownerUserId}:${row.id}`}
                        title={row.name}
                        excerpt={
                          <div className="fnm-block fnm-block--tight">
                            <span>
                              {shortDayLabel(row.date)} · {row.accountName}
                            </span>
                            <div className="fnm-chips">
                              {row.pending ? <Badge tone="steel">Pending</Badge> : null}
                              {row.splitNeedsReview ? (
                                <Badge tone="amber">Check split total</Badge>
                              ) : null}
                              {row.shared ? (
                                <Badge tone="steel">Household · read only</Badge>
                              ) : null}
                            </div>
                            {row.splitPortion ||
                            Math.abs(row.parentAmountCents) !== Math.abs(row.amountCents) ? (
                              <span className="jds-hint">
                                Whole transaction:{" "}
                                {formatCents(Math.abs(row.parentAmountCents), scope.currency)}{" "}
                                {row.parentAmountCents < 0 ? "in" : "out"}
                              </span>
                            ) : null}
                          </div>
                        }
                        meta={<strong>{formatCents(row.amountCents, scope.currency)}</strong>}
                      />
                    ))}
                  </RowIndex>
                ) : (
                  <p>
                    No matching records on this page. Use the previous page or reload if the ledger
                    changed.
                  </p>
                )}
              </div>
            ),
            { loadingLabel: "Loading report transactions" }
          )
        )}
      </div>
    </Dialog>
  );
}
