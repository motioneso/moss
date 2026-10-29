import "./heartbeat-message.css";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import {
  readHeartbeatMuteResult,
  type ChatHeartbeatOriginV1,
  type TranscriptRecord,
  type UsefulnessFeedbackDto,
  type UsefulnessFeedbackKind
} from "@moss/shared";
import { Badge, BrandMark, Button, IconButton } from "@moss/ui";

import { createHeartbeatMute, deleteHeartbeatMute } from "../api/client-heartbeat";
import { queryKeys } from "../api/query-keys";
import {
  createUsefulnessFeedback,
  undoUsefulnessFeedback
} from "../api/usefulness-feedback-client";
import { formatDateTime, formatTime, useUserLocale } from "../locale/locale-format";

/** A check-in written by the heartbeat: intro, one card per item, and an always-visible rating. */
export function HeartbeatMessage(props: {
  readonly record: TranscriptRecord;
  readonly origin: ChatHeartbeatOriginV1;
}) {
  const locale = useUserLocale();
  const { origin } = props;
  const time = props.record.createdAt ? formatTime(props.record.createdAt, locale) : null;
  const count = origin.items.length;
  const eyebrow = ["Check-in", count > 1 ? `${count} items` : null, time]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="chatd-msg hb-message">
      <span className="chatd-msg__av">
        <BrandMark size={14} />
      </span>
      <div className="chatd-bubble">
        <div className="hb-message__eyebrow">{eyebrow}</div>
        {origin.intro ? <p>{origin.intro}</p> : null}
        <ul className="hb-message__items">
          {origin.items.map((item) => (
            <li key={item.findingId}>
              <strong>{item.title}</strong>
              {item.at ? (
                <span className="hb-message__at">
                  {item.at.includes("T") ? formatDateTime(item.at, locale) : item.at}
                </span>
              ) : null}
              <span>{item.note}</span>
            </li>
          ))}
        </ul>
      </div>
      {props.record.messageId ? <HeartbeatRating messageId={props.record.messageId} /> : null}
    </div>
  );
}

const RATINGS: readonly {
  readonly kind: UsefulnessFeedbackKind;
  readonly label: string;
  readonly Icon: typeof ThumbsUp;
}[] = [
  { kind: "more_like_this", label: "Useful", Icon: ThumbsUp },
  { kind: "not_useful", label: "Not useful", Icon: ThumbsDown }
];

function HeartbeatRating(props: { readonly messageId: string }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<UsefulnessFeedbackDto | null>(null);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.usefulnessFeedback.list });
  const rate = useMutation({
    mutationFn: async (kind: UsefulnessFeedbackKind) => {
      if (saved) {
        await undoUsefulnessFeedback(saved.id);
        setSaved(null);
        if (saved.kind === kind) return null;
      }
      return (
        await createUsefulnessFeedback({
          targetKind: "chat_message",
          targetRef: props.messageId,
          surface: "chat",
          kind
        })
      ).feedback;
    },
    onSuccess: (feedback) => {
      setSaved(feedback);
      refresh();
    }
  });

  return (
    <div className="hb-message__rate">
      {RATINGS.map(({ kind, label, Icon }) => (
        <IconButton
          key={kind}
          aria-label={label}
          title={label}
          aria-pressed={saved?.kind === kind}
          disabled={rate.isPending}
          onClick={() => rate.mutate(kind)}
        >
          <Icon size={17} aria-hidden="true" />
        </IconButton>
      ))}
      {rate.isError ? (
        <span className="hb-message__rate-error" role="alert">
          Could not save your rating.{" "}
          <Button variant="link" onClick={() => rate.reset()}>
            Dismiss
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** The result of "stop telling me about X": a Muted label with Undo, or choices to pick from. */
export function HeartbeatMuteRecord(props: {
  readonly result: Record<string, unknown> | undefined;
}) {
  const queryClient = useQueryClient();
  const parsed = readHeartbeatMuteResult(props.result);
  const [picked, setPicked] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.heartbeat.mutes });

  const choose = useMutation({
    mutationFn: (findingId: string) => createHeartbeatMute(findingId),
    onSuccess: (response) => {
      setPicked(response.mute.id);
      setUndone(false);
      refresh();
    }
  });
  const undo = useMutation({
    mutationFn: (id: string) => deleteHeartbeatMute(id),
    onSuccess: () => {
      setUndone(true);
      refresh();
    }
  });

  if (!parsed || parsed.status === "not_found") return null;

  if (parsed.status === "muted") {
    return (
      <MutePill
        label={parsed.mute.label}
        undone={undone}
        pending={undo.isPending}
        failed={undo.isError}
        onUndo={() => undo.mutate(parsed.mute.id)}
      />
    );
  }

  const chosen = parsed.candidates.find((candidate) => candidate.findingId === choose.variables);
  return picked && chosen ? (
    <MutePill
      label={chosen.label}
      undone={undone}
      pending={undo.isPending}
      failed={undo.isError}
      onUndo={() => undo.mutate(picked)}
    />
  ) : (
    <div className="hb-mute">
      <p>Which one should I stop?</p>
      <div className="hb-mute__choices">
        {parsed.candidates.map((candidate) => (
          <Button
            key={candidate.findingId}
            variant="chip"
            disabled={choose.isPending}
            onClick={() => choose.mutate(candidate.findingId)}
          >
            {candidate.label}
          </Button>
        ))}
      </div>
      {choose.isError ? <p role="alert">Could not save that. Try again.</p> : null}
    </div>
  );
}

function MutePill(props: {
  readonly label: string;
  readonly undone: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly onUndo: () => void;
}) {
  return (
    <div className="hb-mute">
      <div className="hb-mute__pill">
        <Badge>{props.undone ? "Unmuted" : "Muted"}</Badge>
        <span>{props.label}</span>
        {props.undone ? null : (
          <Button variant="link" disabled={props.pending} onClick={props.onUndo}>
            Undo
          </Button>
        )}
      </div>
      {props.failed ? <p role="alert">Could not undo that. Try again.</p> : null}
    </div>
  );
}
