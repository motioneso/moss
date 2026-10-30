import {
  Button,
  Textarea,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1
} from "@moss/module-web-sdk";
import {
  validPrivateNote,
  type NoteTarget,
  type SavedTransactionNote
} from "../domain/transaction-notes";
import { invokeTool } from "./api";
import { useReadCooldown } from "./read-cooldown";
import { invalidateQueries } from "./store";
import { announce } from "./states";

/** The parent keeps one shared Dialog mounted, preserving its original focus return target. */
export function useTransactionNoteEditor(props: {
  tools?: ExternalModuleToolsHandleV1;
  target: NoteTarget | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<SavedTransactionNote | null>(null),
    [draft, setDraft] = useState<string | null>(null),
    [blocked, setBlocked] = useState(true),
    [message, setMessage] = useState<string | null>(null),
    [recovered, setRecovered] = useState(false);
  const alive = useRef(true),
    pending = useRef(false),
    generation = useRef(0),
    target = useRef<NoteTarget | null>(null),
    tools = useRef(props.tools);
  const cooldown = useReadCooldown();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const reset = () => {
    if (pending.current) return;
    generation.current++;
    target.current = null;
    setEditing(false);
    setDraft(null);
    setSaved(null);
    setBlocked(true);
    setMessage(null);
    setRecovered(false);
  };
  const check = async (first = false) => {
    if (!target.current || pending.current || cooldown.cooling) return;
    pending.current = true;
    setBusy(true);
    const version = ++generation.current;
    try {
      const result = await invokeTool<
        Record<string, unknown> &
          (({ available: true } & SavedTransactionNote) | { available: false })
      >("finance.transaction.note-read", { ...target.current });
      if (!alive.current || version !== generation.current) return;
      if (result.kind === "ok" && result.result.available) {
        setSaved(result.result);
        setDraft((value) =>
          value === null ? (result.result.available ? result.result.notes : "") : value
        );
        setBlocked(false);
        setRecovered(!first);
        setMessage(
          first
            ? null
            : "Saved note checked. Your draft is kept. Compare it with the saved note before saving."
        );
      } else {
        setBlocked(true);
        if (result.kind === "error" && result.retryAfterSeconds)
          cooldown.wait(result.retryAfterSeconds);
        setMessage(
          result.kind === "error"
            ? result.message
            : "This private note is unavailable. The transaction may have changed or Finance needs updating."
        );
      }
    } catch {
      if (alive.current && version === generation.current) {
        setBlocked(true);
        setMessage("The saved note could not be checked. Your draft is kept.");
      }
    } finally {
      pending.current = false;
      if (alive.current && version === generation.current) setBusy(false);
    }
  };
  const start = () => {
    if (!props.target || !props.tools || pending.current) return;
    target.current = { ...props.target };
    tools.current = props.tools;
    setEditing(true);
    setDraft(null);
    setSaved(null);
    setBlocked(true);
    setMessage(null);
    setRecovered(false);
    void check(true);
  };
  const bytes = new TextEncoder().encode(draft ?? "").length,
    valid = draft !== null && validPrivateNote(draft),
    changed = saved !== null && draft !== saved.notes;
  const save = async () => {
    if (
      !tools.current ||
      !target.current ||
      !saved ||
      !valid ||
      !changed ||
      blocked ||
      pending.current
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    const version = ++generation.current;
    try {
      const result = await tools.current.invoke("finance.transaction.note-save", {
        ...target.current,
        writeRevision: saved.writeRevision,
        notes: draft!
      });
      if (!alive.current || version !== generation.current) return;
      if (result.status === "succeeded" && result.result.status === "ok") {
        // Note edits change xmin, which also invalidates captured budget/bill fingerprints.
        invalidateQueries();
        announce("Private note saved.");
        pending.current = false;
        setBusy(false);
        reset();
        props.onSaved();
      } else if (result.status === "cancelled")
        setMessage("Cancelled. Your private note draft is kept.");
      else {
        setBlocked(true);
        setMessage(
          "The transaction changed or saving could not be confirmed. Your draft is kept. Check the saved note before trying again."
        );
      }
    } catch {
      if (alive.current && version === generation.current) {
        setBlocked(true);
        setMessage(
          "Saving could not be confirmed. Your draft is kept. Check the saved note before trying again."
        );
      }
    } finally {
      pending.current = false;
      if (alive.current && version === generation.current) setBusy(false);
    }
  };
  return {
    editing,
    busy,
    start,
    reset,
    body: (
      <div className="fnm-block fnm-block--tight fnm-note-editor">
        {message ? <p role="status">{message}</p> : null}
        <p className="jds-hint">
          Only your private note changes. Amount, category and reconciliation stay as saved.
        </p>
        {saved ? (
          <p>
            {saved.date} · {saved.name}
          </p>
        ) : null}
        {recovered && saved ? (
          <label className="fnm-block fnm-block--tight">
            Currently saved note
            <Textarea
              aria-label="Currently saved private note"
              readOnly
              rows={4}
              value={saved.notes}
            />
          </label>
        ) : null}
        {draft === null ? (
          <p>{busy ? "Reading saved note…" : "Check the saved note to begin editing."}</p>
        ) : (
          <>
            <label className="fnm-block fnm-block--tight">
              Private note
              <Textarea
                aria-label="Edit private transaction note"
                rows={recovered ? 5 : 7}
                value={draft}
                disabled={busy || blocked}
                aria-describedby="finance-note-capacity"
                onChange={(e: { currentTarget: { value: string } }) =>
                  setDraft(e.currentTarget.value)
                }
              />
            </label>
            <p id="finance-note-capacity" className="jds-hint" role={!valid ? "alert" : undefined}>
              {valid
                ? `${4000 - bytes} UTF-8 bytes available. Leave empty to clear this note.`
                : "Use valid text without NUL, at most 4,000 UTF-8 bytes. Your draft has not been shortened."}
            </p>
          </>
        )}
      </div>
    ),
    footer: (
      <div className="fnm-spread">
        <Button variant="secondary" disabled={busy} onClick={reset}>
          Back to details
        </Button>
        {blocked ? (
          <Button disabled={busy || cooldown.cooling} onClick={() => void check()}>
            {busy ? "Checking…" : "Check saved note"}
          </Button>
        ) : (
          <Button disabled={busy || !valid || !changed} onClick={() => void save()}>
            {busy ? "Saving…" : "Save private note"}
          </Button>
        )}
      </div>
    )
  };
}
