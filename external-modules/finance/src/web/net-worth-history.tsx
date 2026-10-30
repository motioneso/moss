import {
  Badge,
  Button,
  DisclosureToggle,
  Note,
  RowIndex,
  RowIndexItem,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { NetWorthCoverage } from "../domain/net-worth-ledger";
import type { NetWorthPoint } from "../domain/net-worth";
import { formatCents } from "./format";
const reasons: Record<NonNullable<NetWorthCoverage["reason"]>, string> = {
  opening_missing: "Opening balance or date is missing.",
  not_open: "The account has not opened in this period.",
  storage_update_required: "Update Finance storage to include this manual ledger.",
  no_snapshot: "No recorded balance is available on or before this date.",
  outside_period: "No balance point is available in this report period."
};
export function NetWorthHistory(props: {
  coverage: NetWorthCoverage[];
  points: NetWorthPoint[];
  currency: string;
}): ReactNodeLike {
  const [sources, setSources] = useState(false),
    [history, setHistory] = useState(false),
    [page, setPage] = useState(0);
  const included = props.coverage.filter((c) => c.included).length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(props.points.length / 50) - 1));
  const rows = [...props.points].reverse().slice(currentPage * 50, (currentPage + 1) * 50);
  return (
    <div className="fnm-block fnm-block--tight">
      <p role="status">
        {included} of {props.coverage.length} account{props.coverage.length === 1 ? "" : "s"}{" "}
        included in this total.
      </p>
      {included < props.coverage.length ? (
        <Note variant="practical">
          Some accounts have no usable balance history for this period. Their balances are omitted;
          open sources to see what is missing.
        </Note>
      ) : null}
      <DisclosureToggle expanded={sources} onClick={() => setSources(!sources)}>
        {sources ? "Hide balance sources" : "Show balance sources"}
      </DisclosureToggle>
      {sources ? (
        <RowIndex density="compact">
          {props.coverage.map((row) => (
            <RowIndexItem
              key={row.accountId}
              title={row.name}
              excerpt={
                row.reason
                  ? reasons[row.reason]
                  : `${row.source === "ledger" ? "Manual ledger through" : "Recorded snapshot from"} ${row.asOf}`
              }
              meta={
                row.included && row.contributionCents !== null ? (
                  <span className="fnm-money-wrap">
                    {formatCents(row.contributionCents, props.currency)}
                  </span>
                ) : (
                  <Badge tone="steel">Not included</Badge>
                )
              }
            />
          ))}
        </RowIndex>
      ) : null}
      {props.points.length ? (
        <>
          <DisclosureToggle expanded={history} onClick={() => setHistory(!history)}>
            {history ? "Hide balance history" : "Show balance history"}
          </DisclosureToggle>
          {history ? (
            <div className="fnm-block fnm-block--tight">
              <p className="jds-hint">
                Recorded and ledger-derived points, newest first. Earlier recorded balances carry
                forward between observations.
              </p>
              <p role="status">
                {currentPage * 50 + 1}–{currentPage * 50 + rows.length} of {props.points.length}{" "}
                balance points
              </p>
              <RowIndex density="compact">
                {rows.map((point) => (
                  <RowIndexItem
                    key={point.date}
                    title={point.date}
                    meta={
                      <span className="fnm-money-wrap">
                        {formatCents(point.totalCents, props.currency)}
                      </span>
                    }
                  />
                ))}
              </RowIndex>
              {props.points.length > 50 ? (
                <div className="fnm-chips">
                  <Button
                    variant="secondary"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Newer balances
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={(currentPage + 1) * 50 >= props.points.length}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Older balances
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
