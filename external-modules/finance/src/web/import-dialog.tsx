import {
  Button,
  Dialog,
  Select,
  randomUuid,
  Switch,
  useState,
  useRef,
  type ExternalModuleToolsHandleV1,
  type ModuleToolOutcome,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import {
  MAX_IMPORT_BYTES,
  parseCsv,
  mapCsv,
  importedBalance,
  type CsvMapping,
  type CsvTable,
  type ImportPreview,
  type ImportRow
} from "../domain/csv-import";
import { manualSaveMessage, type ManualAccountChoice } from "./manual-entry";
import { dayYearLabel, formatCents } from "./format";
import { invalidateQueries } from "./store";

type Choice = "skip" | "import";
const initialMapping: CsvMapping = {
  date: -1,
  name: -1,
  amount: -1,
  inflow: -1,
  outflow: -1,
  notes: -1,
  currency: -1,
  dateFormat: "iso",
  amountMode: "positive-out"
};
function message(outcome: ModuleToolOutcome): string {
  if (outcome.status === "rejected" && outcome.moduleCode === "import_too_large")
    return "This batch has too much text. Choose fewer rows or shorter notes.";
  if (outcome.status === "rejected" && outcome.moduleCode === "stale_import")
    return "The ledger changed or a duplicate decision is missing. Refresh the preview and review before importing.";
  return manualSaveMessage(outcome) ?? "The import response was incomplete. Check saved records.";
}
export function ImportDialog(props: {
  account: ManualAccountChoice;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onSaved: () => void;
}): ReactNodeLike {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [operationId] = useState(() => randomUuid());
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState(initialMapping);
  const [dateChosen, setDateChosen] = useState(false);
  const [signChosen, setSignChosen] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const disabled = busy || uncertain;
  const change = (key: keyof CsvMapping, value: number | string) =>
    setMapping({ ...mapping, [key]: value });
  const loadFile = async (file?: File) => {
    setTable(null);
    setPreview(null);
    setError(null);
    setChoices({});
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Choose a CSV file no larger than 1 MiB.");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error("Save the CSV as UTF-8 text before importing.");
      }
      setTable(parseCsv(content));
      setMapping(initialMapping);
      setDateChosen(false);
      setSignChosen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = async () => {
    if (!table || busy || uncertain || !props.tools) return;
    let entries: ImportRow[];
    try {
      entries = mapCsv(table, mapping, props.account.isoCurrency);
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.tools.invoke("finance.import.preview", {
        accountId: props.account.accountId,
        isoCurrency: props.account.isoCurrency,
        rows: entries
      });
      if (
        outcome.status !== "succeeded" ||
        outcome.result.status !== "ok" ||
        !outcome.result.view
      ) {
        setError(
          outcome.status === "rejected" || outcome.status === "invalid_input"
            ? message(outcome)
            : "The preview could not load. No entries were added. Try again."
        );
        return;
      }
      setChoices({});
      setRows(entries);
      setPreview(outcome.result.view as unknown as ImportPreview);
      setStale(false);
    } catch {
      setError("The preview could not load. No entries were added. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const selected = rows
    .filter((row) => choices[row.sourceRow] !== "skip")
    .map((row) => ({ ...row, allowDuplicate: choices[row.sourceRow] === "import" }));
  const unresolved = preview?.duplicateRows.filter((row) => !choices[row]).length ?? 0;
  const balance = preview ? importedBalance(preview, selected) : null;
  const apply = async () => {
    if (
      !preview ||
      !props.tools ||
      disabled ||
      stale ||
      unresolved ||
      balance === null ||
      !selected.length
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.tools.invoke("finance.import.apply", {
        operationId,
        accountId: props.account.accountId,
        isoCurrency: props.account.isoCurrency,
        expectedRevision: preview.revision,
        rows: selected,
        cleared
      });
      if (outcome.status === "succeeded" && outcome.result.status === "ok") {
        props.onSaved();
        return;
      }
      setError(message(outcome));
      setStale(outcome.status === "rejected" && outcome.moduleCode === "stale_import");
      setUncertain(outcome.status === "failed" || outcome.status === "succeeded");
    } catch {
      setError(
        "Saving could not be confirmed. Check saved records before starting another import."
      );
      setUncertain(true);
    } finally {
      setBusy(false);
    }
  };
  const column = (
    key: "date" | "name" | "amount" | "inflow" | "outflow" | "notes" | "currency",
    label: string,
    optional = false
  ) => (
    <label className="fnm-block fnm-block--tight" key={key}>
      {label}
      <Select
        aria-label={label}
        disabled={disabled}
        value={mapping[key]}
        onChange={(event: { target: { value: string } }) => change(key, Number(event.target.value))}
      >
        <option value={-1}>{optional ? "None" : "Choose a column"}</option>
        {table?.headers.map((header, index) => (
          <option key={index} value={index}>
            {index + 1}. {header || "Untitled"}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <Dialog
      title="Import CSV"
      className="fnm-import-dialog"
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      description={`${props.account.name} · ${props.account.isoCurrency}`}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          {uncertain ? (
            <Button
              onClick={() => {
                invalidateQueries();
                props.onClose();
              }}
            >
              Check saved records
            </Button>
          ) : preview ? (
            <Button
              variant="primary"
              disabled={disabled || stale || unresolved > 0 || balance === null || !selected.length}
              onClick={() => void apply()}
            >
              {busy
                ? "Saving…"
                : `Import ${selected.length} transaction${selected.length === 1 ? "" : "s"}`}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={disabled || !table || !dateChosen || !signChosen || !props.tools}
              onClick={() => void review()}
            >
              {busy ? "Loading…" : "Preview import"}
            </Button>
          )}
        </>
      }
    >
      <div className="fnm-stack">
        {!props.tools ? (
          <p role="alert" className="jds-hint">
            Update Moss before importing transactions from this page.
          </p>
        ) : null}
        {!preview ? (
          <>
            <div className="fnm-block fnm-block--tight">
              <span>CSV file</span>
              <div>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => fileInput.current?.click()}
                >
                  {table ? "Choose another CSV" : "Choose CSV file"}
                </Button>
              </div>
              <input
                ref={fileInput}
                className="fnm-visually-hidden"
                tabIndex={-1}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                disabled={disabled}
                onChange={(event: { target: { files: FileList | null; value: string } }) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void loadFile(file);
                }}
              />
            </div>
            {table ? (
              <>
                <p role="status" className="jds-caption">
                  {table.rows.length} data rows · {table.headers.length} columns
                </p>
                <div className="fnm-manual-columns">
                  {column("date", "Date column")}
                  {column("name", "Payee column")}
                </div>
                <div className="fnm-manual-columns">
                  <label className="fnm-block fnm-block--tight">
                    Date format
                    <Select
                      aria-label="Date format"
                      disabled={disabled}
                      value={dateChosen ? mapping.dateFormat : ""}
                      onChange={(event: { target: { value: string } }) => {
                        setDateChosen(Boolean(event.target.value));
                        change("dateFormat", event.target.value);
                      }}
                    >
                      <option value="">Choose date order</option>
                      <option value="iso">YYYY-MM-DD</option>
                      <option value="mdy">MM/DD/YYYY</option>
                      <option value="dmy">DD/MM/YYYY</option>
                    </Select>
                  </label>
                  <label className="fnm-block fnm-block--tight">
                    Amount meaning
                    <Select
                      aria-label="Amount meaning"
                      disabled={disabled}
                      value={signChosen ? mapping.amountMode : ""}
                      onChange={(event: { target: { value: string } }) => {
                        setSignChosen(Boolean(event.target.value));
                        change("amountMode", event.target.value);
                      }}
                    >
                      <option value="">Choose money direction</option>
                      <option value="positive-out">Positive means money out</option>
                      <option value="positive-in">Positive means money in</option>
                      <option value="separate">Separate money in / out columns</option>
                    </Select>
                  </label>
                </div>
                <div className="fnm-manual-columns">
                  {mapping.amountMode === "separate" ? (
                    <>
                      {column("inflow", "Money in column")}
                      {column("outflow", "Money out column")}
                    </>
                  ) : (
                    column("amount", "Amount column")
                  )}
                </div>
                <div className="fnm-manual-columns">
                  {column("notes", "Note column", true)}
                  {column("currency", "Currency column", true)}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            <div className="fnm-manual-columns">
              <p className="fnm-block fnm-block--tight">
                <span className="jds-caption">Current balance</span>
                <strong>{formatCents(preview.balanceCents, preview.isoCurrency)}</strong>
              </p>
              <p className="fnm-block fnm-block--tight">
                <span className="jds-caption">After import</span>
                <strong>
                  {balance === null
                    ? "Outside supported precision"
                    : formatCents(balance, preview.isoCurrency)}
                </strong>
              </p>
            </div>
            <p className="jds-caption">
              {rows.length} rows in {preview.isoCurrency}. {rows.length - selected.length} skipped.
            </p>
            {preview.duplicateRows.length ? (
              <p role="status" className="jds-hint">
                {`${preview.duplicateRows.length} possible duplicate${preview.duplicateRows.length === 1 ? "" : "s"}. ${unresolved} decision${unresolved === 1 ? "" : "s"} remaining.`}
              </p>
            ) : null}
            <div className="fnm-import-rows" aria-label="Import rows">
              {rows.map((row) => (
                <div key={row.sourceRow} className="fnm-block fnm-block--tight">
                  <div className="fnm-import-row">
                    <span>
                      {row.sourceRow}. {row.name}
                      <span className="jds-caption fnm-block">
                        {dayYearLabel(row.date, "short")}
                      </span>
                    </span>
                    <strong>
                      {formatCents(Math.abs(row.amountCents), preview.isoCurrency)}
                      <span className="jds-caption fnm-block">
                        {row.amountCents > 0 ? "Money out" : "Money in"}
                      </span>
                    </strong>
                  </div>
                  {row.notes ? <p className="jds-caption">{row.notes}</p> : null}
                  {preview.duplicateRows.includes(row.sourceRow) ? (
                    <Select
                      aria-label={`Duplicate decision for row ${row.sourceRow}`}
                      value={choices[row.sourceRow] ?? ""}
                      disabled={disabled}
                      onChange={(event: { target: { value: string } }) =>
                        setChoices({ ...choices, [row.sourceRow]: event.target.value as Choice })
                      }
                    >
                      <option value="">Choose for this possible duplicate</option>
                      <option value="skip">Skip</option>
                      <option value="import">Import anyway</option>
                    </Select>
                  ) : null}
                </div>
              ))}
            </div>
            <Switch
              ariaLabel="Imported entries are cleared"
              label="Imported entries are cleared"
              checked={cleared}
              disabled={disabled}
              onChange={setCleared}
            />
            <div className="fnm-account-actions">
              <Button
                disabled={disabled}
                onClick={() => {
                  setPreview(null);
                  setError(null);
                }}
              >
                Edit mapping
              </Button>
              <Button disabled={disabled} onClick={() => void review()}>
                Refresh preview
              </Button>
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="jds-hint">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
