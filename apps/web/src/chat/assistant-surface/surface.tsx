import { Paperclip, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import type { ChatSurface } from "@moss/shared";
import { Button } from "@moss/ui";

import { sendChatTurn } from "../../api/client";
import { useAssistantName } from "../../api/use-assistant-name";
import { BrandMark } from "../../shell/brand-mark";
import "../../styles/kit-chat-attach.css";
import {
  ATTACHMENT_ACCEPT,
  CLIENT_MAX_ATTACHMENTS_PER_TURN,
  addPendingAttachment,
  attachmentValidationError,
  formatAttachmentSize,
  hasUploadingAttachment,
  markAttachmentError,
  markAttachmentReady,
  readyAttachmentDtos,
  removePendingAttachment,
  type PendingAttachment
} from "../attachments";
import { Thread } from "../message-row";
import type { ChatRecordKind } from "../use-chat-stream";
import type { AssistantSurfaceViewProps } from "./contracts";
import { useAssistantSurfaceHost } from "./host-context";
import "./assistant-surface.css";

const DEFAULT_RECORD_KINDS: ReadonlySet<ChatRecordKind> = new Set([
  "user",
  "reply",
  "action_request",
  "action_result",
  "error"
]);

export function AssistantSurface(props: AssistantSurfaceViewProps) {
  const { records, registerComposer } = useAssistantSurfaceHost(props.surface);
  const assistantName = useAssistantName("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<readonly PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const allowed = props.recordKinds ? new Set(props.recordKinds) : DEFAULT_RECORD_KINDS;
  const visibleRecords = records.filter((record) => allowed.has(record.kind));

  useEffect(
    () =>
      registerComposer((nextDraft) => {
        setDraft(nextDraft);
        requestAnimationFrame(() => inputRef.current?.focus());
      }),
    [registerComposer]
  );

  const submit = () => {
    const text = draft.trim();
    const attachments = readyAttachmentDtos(pending);
    if (!text && attachments.length === 0) return;
    if (hasUploadingAttachment(pending)) return;
    const attachmentIds = attachments.map((attachment) => attachment.id);
    const onSubmitText = props.composer?.onSubmitText;
    const outcome = onSubmitText
      ? attachmentIds.length > 0
        ? onSubmitText(text, attachmentIds)
        : onSubmitText(text)
      : "send";
    if (outcome === "send") {
      void (props.surface
        ? sendChatTurn(
            text,
            attachmentIds.length > 0 ? attachmentIds : undefined,
            undefined,
            props.surface as ChatSurface
          )
        : attachmentIds.length > 0
          ? sendChatTurn(text, attachmentIds)
          : sendChatTurn(text));
    }
    setDraft("");
    setPending([]);
    setAttachError(null);
  };

  const attachFiles = (files: readonly File[]) => {
    const uploadAttachment = props.composer?.uploadAttachment;
    if (!uploadAttachment || files.length === 0) return;
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
      const localId =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const fileName = file.name || "attachment";
      current = addPendingAttachment(current, {
        localId,
        fileName,
        sizeBytes: file.size,
        mimeType: file.type
      });
      void uploadAttachment(file)
        .then(({ id }) => setPending((list) => markAttachmentReady(list, localId, id)))
        .catch(() =>
          setPending((list) =>
            markAttachmentError(list, localId, "Upload failed. Please try again.")
          )
        );
    }
    setPending(current);
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    attachFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  // Nothing said yet, by anyone — no records, no locally-injected rows, nobody typing, no control
  // card. The composer draws a rule along its top edge to separate itself from the transcript, and
  // on a thread this empty that rule separates the composer from nothing: it renders as a stray
  // line floating above the input. Surfaced by the job-search onboarding screen, where an empty
  // conversation IS the first screen, but it is the same stray line in a brand-new drawer chat.
  const threadIsEmpty =
    visibleRecords.length === 0 &&
    !props.localRows?.length &&
    !props.typing &&
    !props.activeControl;

  return (
    <section
      className={`assistant-surface${threadIsEmpty ? " assistant-surface--empty" : ""}`}
      aria-label={assistantName ? `${assistantName} conversation` : "Conversation"}
    >
      <div className="assistant-surface__thread" aria-live="polite">
        {props.localRows?.map((row) => (
          <div
            className={`assistant-surface__row assistant-surface__row--${row.role}`}
            key={row.id}
          >
            {row.role === "assistant" ? <MossIdentity /> : null}
            <div className={`jds-bubble jds-bubble--${row.role}`}>{row.content}</div>
          </div>
        ))}
        <Thread records={visibleRecords} />
        {props.typing ? <TypingRow /> : null}
        {props.activeControl ? (
          <div className="assistant-surface__row assistant-surface__row--control">
            <MossIdentity />
            {props.activeControl}
          </div>
        ) : null}
      </div>
      {props.composer ? (
        <form
          className="assistant-surface__composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {attachError ? (
            <p className="form-error assistant-surface__attach-error">{attachError}</p>
          ) : null}
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
                    onClick={() =>
                      setPending((list) => removePendingAttachment(list, item.localId))
                    }
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {props.composer.uploadAttachment ? (
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
                aria-label={props.composer.attachmentLabel ?? "Attach files"}
                className="chatd-attach__btn"
                title={props.composer.attachmentLabel ?? "Attach files"}
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <textarea
            ref={inputRef}
            aria-label={assistantName ? `Message ${assistantName}` : "Message"}
            placeholder={
              props.composer.placeholder ??
              (assistantName ? `Message ${assistantName}…` : "Message…")
            }
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button
            variant="primary"
            disabled={
              (!draft.trim() && readyAttachmentDtos(pending).length === 0) ||
              hasUploadingAttachment(pending)
            }
            type="submit"
          >
            Send
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function TypingRow() {
  const assistantName = useAssistantName("");
  return (
    <div className="assistant-surface__row assistant-surface__row--assistant assistant-surface__typing-row">
      <MossIdentity />
      <div
        className="assistant-surface__typing"
        aria-label={assistantName ? `${assistantName} is typing` : "Assistant is typing"}
        aria-live="polite"
      >
        <span className="jds-typing-dot" />
        <span className="jds-typing-dot" />
        <span className="jds-typing-dot" />
      </div>
    </div>
  );
}

function MossIdentity() {
  const assistantName = useAssistantName("");
  return (
    <span className="assistant-surface__identity">
      <BrandMark size={14} />
      {assistantName ? <span>{assistantName}</span> : null}
    </span>
  );
}
