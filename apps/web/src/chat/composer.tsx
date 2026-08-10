import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";

import type { ChatAttachmentDto } from "@moss/shared";

import {
  ApiError,
  listChatSkills,
  lookupAiCapabilityRoute,
  transcribeAudio,
  uploadChatAttachment
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import {
  ATTACHMENT_ACCEPT,
  CLIENT_MAX_ATTACHMENTS_PER_TURN,
  addPendingAttachment,
  attachmentValidationError,
  formatAttachmentSize,
  hasUploadingAttachment,
  markAttachmentError,
  markAttachmentReady,
  pastedImageFiles,
  readyAttachmentDtos,
  removePendingAttachment,
  type PendingAttachment
} from "./attachments";
import { ConnectProviderEmpty } from "./connect-provider-empty";
import {
  activeSlashQuery,
  composeTurnText,
  filterEnabledSkills,
  moveSkillActiveIndex,
  resolveBoundSkill,
  resolveTurnInvocation,
  skillCommandName,
  SkillAutocomplete
} from "./skill-autocomplete";

/**
 * Chat composer, extracted from chat-drawer.tsx (#738) so the mic/voice-input control has
 * headroom to grow without pushing the drawer file over the file-size gate.
 *
 * Voice input (#738): tap-to-record via MediaRecorder, then POST the clip to
 * /api/ai/transcriptions (transient — raw audio never leaves this component and is never
 * persisted). The transcript is inserted into the text field for the user to review/edit; it
 * is NEVER auto-sent — send stays a manual, explicit action, identical to typed text. The mic
 * button is always rendered; it's disabled with an explanatory tooltip until the
 * "transcription" AI capability route reports available (the same capability-route
 * mechanism every other AI feature uses to know a provider is configured+healthy).
 */
export function Composer(props: {
  readonly modelSelector?: React.ReactNode;
  readonly readOnly: boolean;
  readonly isFounder: boolean;
  readonly initialText?: string;
  readonly isSending: boolean;
  readonly sendError: string | null;
  readonly needsProvider: boolean;
  readonly lockedModelUnavailable: boolean;
  /** #1133 — attach UI is hidden and pending chips are dropped in private/incognito chat. */
  readonly privateMode: boolean;
  readonly onSend: (text: string, attachments?: readonly ChatAttachmentDto[]) => void;
  readonly onStop: (queuedText: string | null) => void;
}) {
  // Lazy initializer: the starter seeds the input on mount only. After that, the user owns the
  // value — typing/sending clears it and we never re-seed from the prop (no useEffect that would
  // clobber edits or re-fire the chip on re-render).
  const assistantName = useAssistantName();
  const [text, setText] = useState(() => props.initialText ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // #916 — when the composer opens seeded with a starter (module draft #916 or onboarding #368),
  // move focus to the textarea and place the caret at the end so the editable draft is immediately
  // reviewable/editable. Mount-only (empty deps): it must not steal focus on later re-renders.
  useEffect(() => {
    if (!props.initialText) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const [queuedText, setQueuedText] = useState<string | null>(null);
  // Explicit autocomplete pick, tracked by record id (not name — duplicate names are allowed).
  // Bare-name text typed without a pick still resolves at send time; see resolveTurnInvocation.
  const [boundSkillId, setBoundSkillId] = useState<string | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [dismissedSkillQuery, setDismissedSkillQuery] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Denied/unavailable mic is browser/device state, not server state — kept purely local and
  // never persisted or reported anywhere.
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const chunksRef = useRef<Blob[]>([]);

  // #1133 — files staged for the next turn. Uploads start immediately on pick/paste so the
  // server id is usually ready by the time the user hits send; chips reflect per-file status.
  const [pending, setPending] = useState<readonly PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Attachments are rejected server-side in private chat (nothing persists there to clean
  // up); drop any staged chips the moment the user flips to private so the composer can't
  // submit ids the server would refuse.
  useEffect(() => {
    if (props.privateMode) {
      setPending([]);
      setAttachError(null);
    }
  }, [props.privateMode]);

  const attachFiles = (files: readonly File[]) => {
    if (props.privateMode || files.length === 0) return;
    setAttachError(null);
    let current = pending;
    for (const file of files) {
      if (current.length >= CLIENT_MAX_ATTACHMENTS_PER_TURN) {
        setAttachError(
          `You can attach up to ${CLIENT_MAX_ATTACHMENTS_PER_TURN} files per message.`
        );
        break;
      }
      const rejection = attachmentValidationError(file);
      if (rejection) {
        setAttachError(rejection);
        continue;
      }
      // randomUUID is HTTPS-only in some browsers; keep LAN HTTP uploads usable.
      const localId =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const fileName = file.name || "pasted-image.png";
      current = addPendingAttachment(current, {
        localId,
        fileName,
        sizeBytes: file.size,
        mimeType: file.type
      });
      void uploadChatAttachment(file, fileName)
        .then(({ attachment }) => {
          setPending((list) => markAttachmentReady(list, localId, attachment.id));
        })
        .catch((error: unknown) => {
          setPending((list) =>
            markAttachmentError(
              list,
              localId,
              error instanceof ApiError ? error.message : "Upload failed. Please try again."
            )
          );
        });
    }
    // #1415 fix (B): use functional update to avoid race with upload callbacks
    setPending((list) => [...list, ...current.slice(list.length)]);
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    attachFiles(Array.from(event.target.files ?? []));
    // Reset so picking the same file again re-fires change.
    event.target.value = "";
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = pastedImageFiles(event.clipboardData?.items ?? []);
    if (images.length === 0) return;
    event.preventDefault();
    attachFiles(images);
  };

  const transcriptionRouteQuery = useQuery({
    queryKey: queryKeys.ai.capability("transcription"),
    queryFn: () => lookupAiCapabilityRoute("transcription")
  });
  const micAvailable = Boolean(transcriptionRouteQuery.data?.route?.available);

  const skillsQuery = useQuery({
    queryKey: queryKeys.chat.skills,
    queryFn: listChatSkills
  });
  const skills = skillsQuery.data?.skills ?? [];
  const slashQuery = activeSlashQuery(text);
  const skillMatches = slashQuery === null ? [] : filterEnabledSkills(skills, slashQuery);
  const skillMenuOpen =
    !props.readOnly &&
    !boundSkillId &&
    slashQuery !== null &&
    skillMatches.length > 0 &&
    dismissedSkillQuery !== slashQuery;
  const activeSkill = skillMatches[activeSkillIndex];
  useEffect(() => {
    setActiveSkillIndex((index) =>
      Math.min(Math.max(index, 0), Math.max(skillMatches.length - 1, 0))
    );
  }, [skillMatches.length]);
  useEffect(() => {
    setActiveSkillIndex(0);
    setDismissedSkillQuery(null);
  }, [slashQuery]);
  const boundSkill = resolveBoundSkill(skills, boundSkillId);
  const invocation = resolveTurnInvocation(text, boundSkillId, skills);
  const composedText = composeTurnText(invocation.skill, invocation.remainder);

  const selectSkill = (skillId: string) => {
    setBoundSkillId(skillId);
    setText("");
    setActiveSkillIndex(0);
    setDismissedSkillQuery(null);
  };

  const clearBoundSkill = () => setBoundSkillId(null);

  const readyAttachments = readyAttachmentDtos(pending);

  const send = () => {
    if (props.readOnly) return;
    // #1133 — a turn can be attachment-only, but never truly empty; and never send while a
    // chip is still uploading (its server id doesn't exist yet — it would be silently lost).
    if (!composedText && readyAttachments.length === 0) return;
    if (hasUploadingAttachment(pending)) return;
    if (props.isSending) {
      // #1415 fix (A): block send-while-streaming when attachments are pending, since the
      // drain path can't replay attachments (they would be silently lost).
      if (readyAttachments.length > 0) return;
      if (!composedText) return;
      setQueuedText(composedText);
      setText("");
      setBoundSkillId(null);
      return;
    }
    props.onSend(composedText, readyAttachments.length > 0 ? readyAttachments : undefined);
    setText("");
    setBoundSkillId(null);
    setPending([]);
    setAttachError(null);
  };

  const restoreQueuedText = () => {
    if (queuedText === null) return;
    setText(queuedText);
    setQueuedText(null);
  };

  const discardQueuedText = () => setQueuedText(null);

  const stop = () => {
    props.onStop(queuedText);
    setQueuedText(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSkillIndex((index) =>
          moveSkillActiveIndex(index, event.key === "ArrowDown" ? 1 : -1, skillMatches.length)
        );
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && activeSkill) {
        event.preventDefault();
        selectSkill(activeSkill.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSkillQuery(slashQuery);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const insertTranscript = (transcript: string) => {
    // Lands in the composer for review/edit — the normal typed-message send path (Enter /
    // the send button) is the only way it goes out. No auto-send here.
    setText((current) => mergeTranscriptIntoText(current, transcript));
  };

  const startRecording = async () => {
    setMicError(null);
    const mediaDevicesAvailable = typeof navigator.mediaDevices?.getUserMedia === "function";
    if (!mediaDevicesAvailable) {
      setMicError(classifyMicError(undefined, false));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        void transcribeAndInsert(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (error) {
      // Denied permission or no device — surfaced inline, never sent to the server.
      if (mountedRef.current) setMicError(classifyMicError(error, true));
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  useEffect(() => {
    // StrictMode double-invokes effects (setup → cleanup → setup) to verify cleanup safety —
    // without this reset, the first cleanup permanently latches mountedRef.current to false and
    // every mic start after the simulated remount is wrongly treated as post-unmount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Stopping the last track auto-stops an active MediaRecorder, which would otherwise still
      // fire onstop/ondataavailable after unmount and upload a partial recording (#900/#1134 QA
      // finding) — detach the recorder's callbacks first so that can't happen.
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorderRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const transcribeAndInsert = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const { text: transcript } = await transcribeAudio(blob);
      insertTranscript(transcript);
    } catch (error) {
      setMicError(
        error instanceof ApiError ? error.message : "Transcription failed. Please try again."
      );
    } finally {
      setTranscribing(false);
    }
  };

  const micDisabled =
    props.readOnly || props.lockedModelUnavailable || !micAvailable || transcribing;
  const micTitle = !micAvailable
    ? "Set up a transcription model in Settings → Assistant & AI to enable voice input"
    : recording
      ? "Stop recording"
      : transcribing
        ? "Transcribing…"
        : "Record a voice message";

  return (
    <div className="chatd__composer">
      {props.modelSelector ? <div className="chatd__modelrow">{props.modelSelector}</div> : null}
      {props.needsProvider ? <ConnectProviderEmpty isFounder={props.isFounder} /> : null}
      {props.lockedModelUnavailable ? (
        <p className="chatd-lock-warn">
          The locked chat model is unavailable. Contact your admin or go to <b>Settings → AI</b> to
          re-enable it or clear the lock.
        </p>
      ) : null}
      {props.sendError ? <p className="form-error">{props.sendError}</p> : null}
      {micError ? <p className="form-error">{micError}</p> : null}
      {attachError ? <p className="form-error">{attachError}</p> : null}
      {pending.length > 0 ? (
        <div className="chatd-attach__row" aria-label="Pending attachments">
          {pending.map((item) => (
            <span
              className={`chatd-attach__chip${item.status === "error" ? " is-error" : ""}${
                item.status === "uploading" ? " is-uploading" : ""
              }`}
              key={item.localId}
              title={item.status === "error" ? item.error : item.fileName}
            >
              <Paperclip size={12} aria-hidden="true" />
              <span className="chatd-attach__name">{item.fileName}</span>
              <span className="chatd-attach__meta">
                {item.status === "uploading"
                  ? "uploading…"
                  : item.status === "error"
                    ? "failed"
                    : formatAttachmentSize(item.sizeBytes)}
              </span>
              <button
                aria-label={`Remove ${item.fileName}`}
                className="chatd-attach__x"
                type="button"
                onClick={() => setPending((list) => removePendingAttachment(list, item.localId))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {boundSkill ? (
        <div className="chatd-skillac__bound">
          <span>/{skillCommandName(boundSkill.name)}</span>
          <button
            aria-label="Clear selected skill"
            className="chatd-skillac__bound-x"
            title="Clear selected skill"
            type="button"
            onClick={clearBoundSkill}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {skillMenuOpen ? (
        <SkillAutocomplete
          query={slashQuery}
          skills={skills}
          activeIndex={activeSkillIndex}
          listboxId="chat-skill-listbox"
          onSelect={(skill) => selectSkill(skill.id)}
        />
      ) : null}
      <div className={`chatd-input${props.readOnly ? " is-readonly" : ""}`}>
        <textarea
          ref={textareaRef}
          aria-label={`Message ${assistantName}`}
          aria-controls={skillMenuOpen ? "chat-skill-listbox" : undefined}
          aria-expanded={skillMenuOpen}
          aria-autocomplete={skillMenuOpen ? "list" : undefined}
          aria-activedescendant={
            skillMenuOpen && activeSkill ? `chat-skill-listbox-option-${activeSkill.id}` : undefined
          }
          aria-haspopup={skillMenuOpen ? "listbox" : undefined}
          disabled={props.readOnly || props.lockedModelUnavailable}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            props.lockedModelUnavailable
              ? "Chat locked — model unavailable"
              : props.readOnly
                ? "Read-only history"
                : `Message ${assistantName}…`
          }
          rows={1}
          value={text}
        />
        {!props.privateMode ? (
          <>
            <input
              ref={fileInputRef}
              accept={ATTACHMENT_ACCEPT}
              aria-hidden="true"
              className="chatd-attach__input"
              multiple
              tabIndex={-1}
              type="file"
              onChange={onFileInputChange}
            />
            <button
              aria-label="Attach files"
              className="chatd-attach__btn"
              disabled={props.readOnly || props.lockedModelUnavailable}
              title="Attach files (or paste an image)"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          aria-label={recording ? "Stop recording" : "Record voice message"}
          className={`chatd-mic${recording ? " is-recording" : ""}`}
          disabled={micDisabled}
          title={micTitle}
          type="button"
          onClick={recording ? stopRecording : () => void startRecording()}
        >
          {recording ? (
            <Square size={15} aria-hidden="true" fill="currentColor" />
          ) : (
            <Mic size={17} aria-hidden="true" />
          )}
        </button>
        <button
          aria-label={props.isSending ? "Stop generating" : "Send"}
          className="chatd-send"
          disabled={
            props.readOnly ||
            props.lockedModelUnavailable ||
            (!props.isSending &&
              ((!composedText && readyAttachments.length === 0) || hasUploadingAttachment(pending)))
          }
          title={props.isSending ? "Stop" : "Send"}
          type="button"
          onClick={props.isSending ? stop : send}
        >
          {props.isSending ? (
            <Square size={15} aria-hidden="true" fill="currentColor" />
          ) : (
            <ArrowUp size={17} aria-hidden="true" />
          )}
        </button>
      </div>
      {queuedText !== null ? (
        <div className="chatd-next" aria-live="polite">
          <button
            aria-label="Edit queued message"
            className="chatd-next__text"
            type="button"
            onClick={restoreQueuedText}
          >
            Next: &quot;{queuedText}&quot;
          </button>
          <button
            aria-label="Discard queued message"
            className="chatd-next__x"
            title="Discard queued message"
            type="button"
            onClick={discardQueuedText}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pure merge used by voice-input transcript insertion (#738). Exported so the "insert, don't
 * auto-send" behavior — a hard requirement of the spec — is directly unit-testable without
 * needing a full interactive render of the composer.
 */
export function mergeTranscriptIntoText(current: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) return current;
  const trimmedCurrent = current.trim();
  return trimmedCurrent ? `${trimmedCurrent} ${trimmedTranscript}` : trimmedTranscript;
}

/**
 * Classifies a mic-start failure into a user-facing message (#900). Exported so the insecure-origin
 * and permission/device branches are directly unit-testable without needing a full interactive
 * render of the composer.
 */
export function classifyMicError(error: unknown, mediaDevicesAvailable: boolean): string {
  if (!mediaDevicesAvailable) {
    return "Voice input needs a secure connection (HTTPS). You're on an insecure origin.";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  ) {
    return "Microphone permission was denied. Enable it in your browser settings.";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "NotReadableError")
  ) {
    return "No microphone found.";
  }
  return "Microphone access was denied or unavailable.";
}
