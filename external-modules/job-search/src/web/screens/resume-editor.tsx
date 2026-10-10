// external-modules/job-search/src/web/screens/resume-editor.tsx
//
// The résumé half of the Profile screen: the read-only facts moved here unchanged from
// profile.tsx (K4), plus the write UI Ben actually asked for tonight — "the user needs to be able
// to upload a resume (and replace) for each profile." Split into its own file rather than grown
// inside profile.tsx because it is a genuinely self-contained state machine (idle -> editing ->
// [confirming] -> saving -> feedback) that profile.tsx doesn't need to know the shape of; it only
// owns the read (ResumeState) and passes a reload callback down.
//
// Upload is a file picker over .txt/.md/.pdf/.docx. A .txt or .md file is read client-side with
// File.text() into the textarea, same as a paste, so the user can see and edit it before saving —
// task #112 didn't touch that path. A .pdf or .docx can't be previewed or edited in a textarea, so
// that branch reads the raw bytes (File.arrayBuffer()) and uploads them as-is; the host's
// attachments service (packages/chat/src/attachments-service.ts) extracts the text server-side
// when the worker reads the attachment back, so this file never sees PDF/DOCX text at all — only
// a filename and a "text will be extracted when it saves" line. Paste is a plain textarea for when
// there's no file, which is how Ben actually tried to do this tonight. Replacing an existing
// résumé requires an explicit confirm step: resume.set (worker/handlers/resume.ts) re-scores every
// match whose Fit is empty against the new résumé, in place, so saving over an existing résumé
// changes the scores already on the board. The confirm dialog says exactly that, in the user's own
// words. A brand-new résumé (nothing on file yet) skips the confirm — there is nothing on the board
// yet that a first save would be changing.
//
// Every save goes through saveResume (./resume-save.ts) — see that file's header for the
// upload-then-queue transport (task #108) and the text/binary draft split (task #112). This file
// only ever sees SaveResumeOutcome's shapes ("queued"/"already-queued"/"error" — never "done",
// same convention as every other manual-run queue in this module), so the day that function's
// body changes, nothing here does.
import { Fragment, h, useEffect, useRef, useState, type ReactNodeLike } from "../runtime";
import { invokeTool } from "../api";
import { FieldPair, SectionHead } from "../keyline";
import { saveResume, type ResumeDraft } from "./resume-save";

export const RESUME_GET_TOOL = "job-search.resume.get";

// -------------------------------------------------------------------------------------------
// Read side — unchanged from profile.tsx pre-split
// -------------------------------------------------------------------------------------------
export interface ResumeSummary {
  version: number;
  updatedAt: string;
  length: number;
}

// Three separate members, not a combined `{ status: "loading" | "error" }` — see overview.tsx's
// own ResumeState for why the combined form fails to narrow through sequential status checks.
export type ResumeState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; resume: ResumeSummary | null };

export async function fetchResume(profileId: string): Promise<ResumeSummary | null> {
  const result = (await invokeTool(RESUME_GET_TOOL, { profileId })) as {
    resume?: { version: number; content: unknown; updatedAt: string } | null;
  } | null;
  const resume = result?.resume;
  if (!resume || typeof resume.content !== "string") return null;
  return { version: resume.version, updatedAt: resume.updatedAt, length: resume.content.length };
}

// formatPostedOn (keyline.tsx) is a display helper for job postings, not résumé saves — this
// screen needs its own tiny "Jul 15"-style formatter over the same rule (pure string slicing, no
// ambient clock) so it isn't borrowing a job-posting-flavored name for an unrelated field.
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

function formatSavedOn(isoTimestamp: string): string | null {
  if (isoTimestamp.length < 10) return null;
  const month = Number(isoTimestamp.slice(5, 7));
  const day = Number(isoTimestamp.slice(8, 10));
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return `${MONTH_LABELS[month - 1]} ${day}`;
}

// -------------------------------------------------------------------------------------------
// Write side — the editor
// -------------------------------------------------------------------------------------------
// Task #112: a .txt/.md upload is read client-side and lands in the textarea like a paste — the
// user can see and edit it before saving. A .pdf/.docx can't be shown in a textarea, so it takes
// the "binary" branch below: raw bytes, uploaded as-is, extracted server-side on the worker's read
// (packages/chat/src/attachments-service.ts). Kept as two separate Sets (not one combined list)
// because every call site needs to know which branch a given extension takes, not just whether
// it's supported at all.
const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const BINARY_EXTENSIONS = new Set([".pdf", ".docx"]);

// Mime derived from the extension, never from `file.type` — `file.type` is "" for a .txt/.md file
// in every browser, and a fallback to application/octet-stream 415s on the vault-upload route
// (packages/chat/src/attachments-service.ts's classifyAttachmentMime has no entry for it). The
// values themselves mirror that same file's PDF_MIME/DOCX_MIME constants.
const EXTENSION_MIMES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

// Mirrors MAX_DOCUMENT_ATTACHMENT_BYTES (packages/chat/src/attachments-service.ts) — rejecting
// client-side gives a readable message instead of a bare 413 round trip. Not imported: that file
// lives in a server package (fs/mammoth/pdf-parse) this browser bundle must never pull in.
const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;

function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

type EditorMode = "idle" | "editing" | "confirming";

// "pending" is the in-between Ben was missing: the save has been accepted by the queue but the
// worker hasn't written the row yet. It reads as work-in-progress, not as done and not as broken.
type Feedback = { tone: "success" | "pending" | "error"; message: string };

// What a queued save is waiting to see. `baselineVersion` is the version that was on screen when
// the save was queued — anything higher means the worker committed. `fileName` is only carried so
// the success line can name the file the user picked, which is what they asked to see instead of
// a character count.
type SaveWatch = { baselineVersion: number; fileName: string | null };

// ~2s x 30 = about a minute of watching. The worker writes the résumé row before it starts
// scoring, so a healthy save lands in the first few ticks; the long tail only exists to cover a
// busy queue. Past that the copy switches to "still saving in the background" — never to an error,
// because a save that is merely slow has not failed.
const SAVE_WATCH_INTERVAL_MS = 2000;
const SAVE_WATCH_MAX_ATTEMPTS = 30;

// A selected .pdf/.docx file, held as opaque bytes until save — mutually exclusive with `draft`
// (the text/paste path); selecting one clears the other, see handleFileChange/handleDraftChange.
//
// `bytes: ArrayBuffer`, not `Uint8Array` — File.arrayBuffer() already returns an ArrayBuffer, and
// this module's tsconfig DOES pull in the default DOM lib (no explicit "lib" key, so ES2022's
// default set applies — the header comment in ../api.ts used to claim otherwise; that was wrong).
// A bare `Uint8Array` annotation defaults its generic to `ArrayBufferLike`, which lib.dom.d.ts's
// `BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer` does not accept — a real TS 5.7+
// generic-TypedArray mismatch, not a runtime one. Passing the ArrayBuffer straight through avoids
// the mismatch entirely: no conversion, no cast, needed anywhere in this chain.
type SelectedBinary = { fileName: string; mimeType: string; bytes: ArrayBuffer };

// A minimal shape for the File methods this file actually calls — not the DOM lib's full File
// type. The DOM lib is in scope here (see SelectedBinary's comment above), but runtime.ts still
// keeps its own event/element shapes rather than reaching for real DOM types across this module,
// so this stays a small structural interface matching what event.target.files[0] hands back in a
// real browser, not an import of `File` itself.
interface UploadedFile {
  name: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function ResumeEditor(props: {
  key?: string;
  profileId: string;
  resume: ResumeSummary | null;
  onSaved(): void;
  openSignal?: number;
}): ReactNodeLike {
  const { profileId, resume, onSaved, openSignal } = props;
  const [mode, setMode] = useState<EditorMode>("idle");
  const [draft, setDraft] = useState("");
  const [selectedBinary, setSelectedBinary] = useState<SelectedBinary | null>(null);
  // The name of the file the user picked, for BOTH branches. The binary branch keeps the name on
  // `selectedBinary` because the upload needs it, but the text branch previously kept nothing at
  // all: it read the file into `draft` and dropped `file.name` on the floor. That left the screen
  // with no way to say which file had been chosen — and because `handleFileChange` clears the
  // native input's value (see there for why), the browser's own "No file selected" label came
  // straight back the instant a file was picked. Ben, on the first live upload: "after selecting a
  // file it still says No file selected... it just says the char count not the file name, which is
  // useless really."
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Non-null while a queued save is being watched for completion; see the effect below.
  const [watch, setWatch] = useState<SaveWatch | null>(null);

  // onSaved is a fresh closure on every ProfileScreen render, so depending on it directly would
  // restart the poll below on every parent render. Same ref idiom as root.tsx's refetchRef.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // The success state Ben asked for: "after saving it says it is queued for saving, and the user
  // doesn't know what to do. There's no success so the user doesn't know if they need to stay on
  // the page, try again, etc."
  //
  // Ruling I5 is still true — runQueue resolves on ACCEPTANCE and there is no push channel back to
  // the browser — so "saved" cannot come from the enqueue call. It has to be observed, and it is
  // observable: the worker's handler commits the résumé row (store.setResume) BEFORE it starts
  // scoring, so the row shows up within a second or two even though the rescore that follows can
  // run for minutes. This re-reads resume.get until the version moves past the one on screen when
  // the save was queued, which is exactly "the worker wrote it".
  //
  // A byte-identical re-save deliberately does NOT bump the version (the handler returns the
  // existing row rather than spending model calls on a résumé that cannot have changed), so it
  // falls through to the timeout copy below — which is why that copy is worded as "still working",
  // not as a failure.
  useEffect(() => {
    if (watch === null) return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > SAVE_WATCH_MAX_ATTEMPTS) {
        clearInterval(timer);
        if (cancelled) return;
        setWatch(null);
        setFeedback({
          tone: "pending",
          message:
            "Still saving. It runs in the background, so you can leave this page — this screen " +
            "will catch up on its own."
        });
        onSavedRef.current();
        return;
      }
      fetchResume(profileId)
        .then((fresh) => {
          if (cancelled || fresh === null || fresh.version <= watch.baselineVersion) return;
          clearInterval(timer);
          setWatch(null);
          setFeedback({
            tone: "success",
            message:
              (watch.fileName === null ? "Résumé saved" : `${watch.fileName} saved`) +
              " — every open role is being read against it now. You can leave this page."
          });
          onSavedRef.current();
        })
        .catch(() => {
          // A single failed poll is not a failed save; the next tick tries again.
        });
    }, SAVE_WATCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watch, profileId]);

  // Arriving from the board's "Add résumé" button. Sending the user to a screen where the thing
  // they clicked for is behind one more button is the kind of hop that loses people, so the
  // editor is already open when they land. Zero (or absent) means they got here by clicking the
  // Profile tab themselves, which carries no such intent — root.tsx resets the counter on a
  // manual tab click for exactly that reason.
  useEffect(() => {
    if (openSignal === undefined || openSignal <= 0) return;
    setFeedback(null);
    setDraft("");
    setSelectedBinary(null);
    setSelectedFileName(null);
    setMode("editing");
  }, [openSignal]);

  function openEditor(): void {
    setFeedback(null);
    setDraft("");
    setSelectedBinary(null);
    setSelectedFileName(null);
    setMode("editing");
  }

  function cancelEditor(): void {
    setDraft("");
    setSelectedBinary(null);
    setSelectedFileName(null);
    setMode("idle");
  }

  // The draft actually being saved, whichever branch produced it — null means neither a paste/
  // text-upload nor a binary upload is ready yet, and the Save button stays disabled for it.
  function currentDraft(): ResumeDraft | null {
    if (selectedBinary !== null) return { kind: "binary", ...selectedBinary };
    if (draft.trim().length > 0) return { kind: "text", content: draft };
    return null;
  }

  function handleDraftChange(event: { target: { value: string } }): void {
    // Typing directly means the user wants the pasted text, not the file they picked earlier.
    setSelectedBinary(null);
    // ...and the filename goes with it. Once the text has been edited by hand, still showing
    // "resume.md selected" would be claiming to save a file whose contents no longer match.
    setSelectedFileName(null);
    setDraft(event.target.value);
  }

  function handleFileChange(event: {
    target: { files?: ArrayLike<UploadedFile> | null; value: string };
  }): void {
    const file = event.target.files?.[0];
    // Cleared immediately, same as settings-skills-pane.tsx's upload input, so picking the same
    // file twice in a row still fires onChange the second time.
    event.target.value = "";
    if (!file) return;
    const extension = extensionOf(file.name);
    if (!TEXT_EXTENSIONS.has(extension) && !BINARY_EXTENSIONS.has(extension)) {
      setFeedback({
        tone: "error",
        message: "Only .txt, .md, .pdf, and .docx files are supported."
      });
      return;
    }
    if (file.size > MAX_RESUME_FILE_BYTES) {
      setFeedback({ tone: "error", message: "That file is larger than the 10 MB limit." });
      return;
    }
    setFeedback(null);
    setSelectedFileName(file.name);
    if (TEXT_EXTENSIONS.has(extension)) {
      setSelectedBinary(null);
      file
        .text()
        .then((text) => setDraft(text))
        .catch(() => {
          // The name is only shown as a promise that this file is what will be saved. If the read
          // failed there is nothing to save, so drop it rather than leave a stale claim on screen.
          setSelectedFileName(null);
          setFeedback({ tone: "error", message: "Couldn't read that file." });
        });
      return;
    }
    // Binary branch — nothing to preview, so the draft textarea stays empty and this is what
    // Save actually sends (see currentDraft/doSave).
    setDraft("");
    file
      .arrayBuffer()
      .then((buffer) =>
        setSelectedBinary({
          fileName: file.name,
          mimeType: EXTENSION_MIMES[extension],
          bytes: buffer
        })
      )
      .catch(() => {
        // The name is only shown as a promise that this file is what will be saved. If the read
        // failed there is nothing to save, so drop it rather than leave a stale claim on screen.
        setSelectedFileName(null);
        setFeedback({ tone: "error", message: "Couldn't read that file." });
      });
  }

  function requestSave(): void {
    const next = currentDraft();
    if (next === null) return;
    if (resume !== null) {
      // Genuinely destructive (this file's own header) — gate behind an explicit confirm rather
      // than saving on the first click.
      setMode("confirming");
      return;
    }
    void doSave(next);
  }

  async function doSave(next: ResumeDraft): Promise<void> {
    const fileName = selectedFileName;
    setPending(true);
    const outcome = await saveResume(profileId, next);
    setPending(false);
    if (outcome.kind === "queued" || outcome.kind === "already-queued") {
      // The enqueue only proves acceptance, so this is still "saving", not "saved" — but the
      // screen no longer stops here. The watch set below re-reads the résumé until the worker's
      // write shows up, and turns this into a real success line.
      setFeedback({ tone: "pending", message: "Saving your résumé…" });
      setDraft("");
      setSelectedBinary(null);
      setSelectedFileName(null);
      setMode("idle");
      setWatch({ baselineVersion: resume?.version ?? 0, fileName });
      return;
    }
    // Back to the editor, draft intact, so a failed save doesn't cost the user their paste/upload.
    setFeedback({ tone: "error", message: outcome.message });
    setMode("editing");
  }

  const showEditor = mode === "editing" || mode === "confirming";

  // h(Fragment, null, ...) call form, not JSX `<Fragment>` — this module's `Fragment` is typed
  // `unknown` (runtime.ts), so the JSX tag form doesn't type-check here. Same idiom as keyline.tsx's
  // `KeyRow` and settings.tsx's `RunNowControl`.
  return h(
    Fragment,
    null,
    !showEditor ? (
      <div className="jsm-pf-resume-trigger">
        <button
          type="button"
          className="jds-btn jds-btn--secondary jds-btn--sm"
          onClick={openEditor}
        >
          {resume === null ? "Add résumé" : "Replace résumé"}
        </button>
        <FeedbackLine feedback={feedback} />
      </div>
    ) : null,
    showEditor ? (
      <div className="jsm-pf-resume-editor">
        {/*
          The input itself is visually hidden rather than `display: none` — hiding it outright takes
          it out of the tab order and the trigger below stops being reachable by keyboard. The
          <label htmlFor> is the whole click target, which is why it carries the button classes:
          `.jds-btn` is a plain class selector, so it styles a label exactly as it styles a button,
          and the browser's own "Browse… No file selected." chrome never renders. That chrome is
          what Ben saw as unfinished styling, and its stale "No file selected" is what kept showing
          after a file had been picked.
        */}
        <input
          className="jsm-pf-resume-file-input"
          id="jsm-pf-resume-file"
          type="file"
          accept=".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={handleFileChange}
          disabled={pending}
        />
        <div className="jsm-pf-resume-picker">
          <label className="jds-btn jds-btn--secondary jds-btn--sm" htmlFor="jsm-pf-resume-file">
            Choose file
          </label>
          <span className="jds-hint">
            {selectedFileName ?? "No file chosen — .txt, .md, .pdf, or .docx"}
          </span>
        </div>
        <textarea
          className="jds-textarea jsm-pf-resume-textarea"
          aria-label="Résumé text"
          placeholder="…or paste your résumé text here."
          value={draft}
          onChange={handleDraftChange}
          disabled={pending || selectedBinary !== null}
        />
        {/* The filename itself is already on the picker row above; this only explains why the
            textarea is empty and disabled for a PDF or DOCX. */}
        {selectedBinary !== null ? (
          <p className="jds-hint">The text is extracted from this file when it saves.</p>
        ) : null}
        {feedback !== null && feedback.tone === "error" ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {feedback.message}
          </p>
        ) : null}
        {/* One hierarchy for the pair: Save is the primary action of this screen, Cancel recedes.
            Both stay --sm so they sit at the same height as the picker trigger above. */}
        <div className="jsm-pf-resume-actions">
          <button
            type="button"
            className="jds-btn jds-btn--quiet jds-btn--sm"
            onClick={cancelEditor}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="jds-btn jds-btn--primary jds-btn--sm"
            onClick={requestSave}
            disabled={pending || currentDraft() === null}
          >
            {pending ? "Saving…" : "Save résumé"}
          </button>
        </div>
      </div>
    ) : null,
    mode === "confirming" ? (
      <div
        className="jds-dialog-scrim"
        role="presentation"
        onClick={(event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) setMode("editing");
        }}
      >
        <div className="jds-dialog" role="dialog" aria-modal="true" aria-label="Replace résumé">
          <div className="jds-dialog__head">
            <div className="jds-dialog__title">Replace résumé?</div>
            <div className="jds-dialog__desc">
              Roles you have not saved or passed are scored again against the new résumé, so their
              Fit scores will change. Saved and passed roles keep the score they have.
            </div>
          </div>
          <div className="jds-dialog__foot">
            <button
              type="button"
              className="jds-btn jds-btn--quiet"
              onClick={() => setMode("editing")}
            >
              Cancel
            </button>
            <button
              type="button"
              className="jds-btn jds-btn--danger"
              onClick={() => {
                const next = currentDraft();
                if (next !== null) void doSave(next);
              }}
            >
              Replace résumé
            </button>
          </div>
        </div>
      </div>
    ) : null
  );
}

// The one place a save's state is rendered, so "saving" and "saved" can never drift apart in
// wording or in shape. The badge carries the state at a glance and the sentence says what the user
// should do about it — which for a success is explicitly "nothing, you can leave". There is no
// `jds-hint--success`, so the success tone is a badge plus ordinary hint text rather than an
// invented class.
function FeedbackLine(props: { feedback: Feedback | null }): ReactNodeLike {
  const { feedback } = props;
  if (feedback === null) return null;
  if (feedback.tone === "error") {
    return (
      <p className="jds-hint jds-hint--error" role="alert">
        {feedback.message}
      </p>
    );
  }
  return (
    <p className="jds-hint jsm-pf-resume-status" role="status">
      <span
        className={
          feedback.tone === "success"
            ? "jds-badge jds-badge--pill jds-badge--forest"
            : "jds-badge jds-badge--pill jds-badge--steel"
        }
      >
        {feedback.tone === "success" ? "Saved" : "Saving"}
      </span>
      <span>{feedback.message}</span>
    </p>
  );
}

// -------------------------------------------------------------------------------------------
// Section
// -------------------------------------------------------------------------------------------
export function ResumeSection(props: {
  profileId: string;
  state: ResumeState;
  onSaved(): void;
  openSignal?: number;
}): ReactNodeLike {
  const { profileId, state, onSaved, openSignal } = props;
  if (state.status === "loading") {
    return (
      <section className="jsm-settings__group">
        <SectionHead label="Résumé" />
        <p className="jds-hint" role="status">
          Checking…
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="jsm-settings__group">
        <SectionHead label="Résumé" />
        <p className="jds-hint" role="alert">
          Couldn&rsquo;t check whether a résumé is on file.
        </p>
      </section>
    );
  }
  const { resume } = state;
  const savedOn = resume ? (formatSavedOn(resume.updatedAt) ?? "—") : "—";
  return (
    <section className="jsm-settings__group">
      <SectionHead label="Résumé">
        {resume === null ? <span className="jds-badge jds-badge--outline">None yet</span> : null}
      </SectionHead>
      <div className="jsm-fields">
        <FieldPair label="On file">{resume ? "Yes" : "No"}</FieldPair>
        <FieldPair label="Version">{resume ? String(resume.version) : "—"}</FieldPair>
        <FieldPair label="Saved on">{savedOn}</FieldPair>
        <FieldPair label="Length">{resume ? `${resume.length} characters` : "—"}</FieldPair>
      </div>
      <p className="jds-hint">
        {resume === null
          ? "Nothing on file. Fit stays empty until there is one — it's the only thing Fit is " +
            "judged against."
          : "Every open role gets read again against whatever you save here."}
      </p>
      <ResumeEditor
        key={profileId}
        profileId={profileId}
        resume={resume}
        onSaved={onSaved}
        openSignal={openSignal}
      />
    </section>
  );
}
