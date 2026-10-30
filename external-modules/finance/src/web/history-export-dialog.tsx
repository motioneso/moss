import {
  Button,
  Dialog,
  Note,
  Select,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { isCalendarDate } from "../domain/values";
import { invokeTool } from "./api";
import { downloadTransactionsCsv } from "./register";
interface Prepared extends Record<string, unknown> {
  status: string;
  csv?: string;
  totalCount?: number;
  preparedAt?: string;
}
export function HistoryExportDialog(props: {
  accounts: { accountId: string; name: string }[];
  onClose: () => void;
}): ReactNodeLike {
  const [from, setFrom] = useState(""),
    [through, setThrough] = useState(""),
    [account, setAccount] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const pending = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = (save: () => void) => {
    save();
    setPrepared(null);
    setError(null);
  };
  const prepare = async () => {
    if (pending.current) return;
    if (
      (from && !isCalendarDate(from)) ||
      (through && !isCalendarDate(through)) ||
      (from && through && from > through)
    ) {
      setError("Choose valid inclusive dates, with the start on or before the end.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    setPrepared(null);
    const outcome = await invokeTool<Prepared>("finance.transactions.export", {
      ...(from ? { from } : {}),
      ...(through ? { through } : {}),
      ...(account ? { accountId: account } : {})
    });
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (outcome.kind !== "ok") {
      setError(
        outcome.kind === "disabled"
          ? "Finance is unavailable. Reopen it after it is enabled."
          : "Could not prepare this export. Your choices are kept; try a smaller range or check your connection and try again."
      );
      return;
    }
    const value = outcome.result;
    if (value.status === "ready" && typeof value.csv === "string") setPrepared(value);
    else if (value.status === "too_many")
      setError(
        `${value.totalCount?.toLocaleString()} transactions match. Choose a narrower date range or account; a file can contain at most 5,000 rows. No partial file was prepared.`
      );
    else if (value.status === "too_large")
      setError(
        "This CSV exceeds 2 MiB. Choose a narrower date range or account. No partial file was prepared."
      );
    else if (value.status === "storage_update_required")
      setError("Update Finance storage before exporting stored history. Your choices are kept.");
    else setError("The export could not be completed. Your choices are kept; try again.");
  };
  return (
    <Dialog
      title="Export transaction history"
      description="Your records, across stored months"
      scrollBody
      onClose={props.onClose}
      closeLabel="Close transaction export"
      footer={
        <>
          {prepared ? (
            <p className="fnm-export-ready jds-hint">
              {prepared.totalCount?.toLocaleString()} transaction
              {prepared.totalCount === 1 ? "" : "s"} ·{" "}
              {account
                ? props.accounts.find((a) => a.accountId === account)?.name
                : "All your accounts"}
            </p>
          ) : null}
          {prepared?.csv !== undefined ? (
            <Button
              onClick={() =>
                downloadTransactionsCsv(
                  prepared.csv!,
                  `history-${from || "start"}-${through || "latest"}`
                )
              }
            >
              Download CSV
            </Button>
          ) : null}
          <Button variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="fnm-block">
        <p>
          Download your stored transactions. Household entries and private notes are omitted. Each
          row keeps its currency.
        </p>
        {prepared ? (
          <Note variant="practical">
            <p role="status">
              {prepared.totalCount?.toLocaleString()} transaction
              {prepared.totalCount === 1 ? "" : "s"} ready.{" "}
              {account
                ? props.accounts.find((a) => a.accountId === account)?.name
                : "All your accounts"}{" "}
              · {from || "Beginning of history"} through {through || "Latest stored date"}.
            </p>
            <p>
              Prepared at {prepared.preparedAt?.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}.
              Changes made afterward are not included.{" "}
              {prepared.totalCount === 0
                ? "The CSV contains column headings only."
                : "Download the CSV when you are ready."}
            </p>
          </Note>
        ) : null}
        <p className="jds-hint">
          Leave dates empty for all history. Dates are inclusive; current register filters do not
          apply. Limit: 5,000 rows and 2 MiB per file. Use smaller ranges for larger histories.
        </p>
        <label className="fnm-block fnm-block--tight">
          Export account
          <Select
            aria-label="Export account"
            value={account}
            disabled={busy}
            onChange={(event) => change(() => setAccount(event.currentTarget.value))}
          >
            <option value="">All your accounts</option>
            {props.accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="fnm-manual-columns">
          <label className="fnm-block fnm-block--tight">
            <span>From date (inclusive)</span>
            <input
              className="jds-input"
              type="date"
              value={from}
              disabled={busy}
              onChange={(event) => change(() => setFrom(event.currentTarget.value))}
            />
          </label>
          <label className="fnm-block fnm-block--tight">
            <span>Through date (inclusive)</span>
            <input
              className="jds-input"
              type="date"
              value={through}
              disabled={busy}
              onChange={(event) => change(() => setThrough(event.currentTarget.value))}
            />
          </label>
        </div>
        <div>
          <Button disabled={busy} onClick={() => void prepare()}>
            {busy ? "Preparing CSV…" : "Prepare CSV"}
          </Button>
        </div>
        {busy ? (
          <p role="status">Reading matching owned records. No file has been downloaded.</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
