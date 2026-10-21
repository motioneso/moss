import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import { DEFAULT_CHAT_SURFACE, type ChatSurface, type ChatVoiceRequestStatus } from "@moss/shared";
import { Button, DisclosureToggle, EmptyState, Note } from "@moss/ui";
import "../styles/chat-voice-requests.css";

interface VoiceRequestsProps {
  readonly ownerId?: string;
  readonly surface: ChatSurface;
  readonly mainThreadId?: string;
  readonly selectedThreadId: string | null;
  readonly privateMode: boolean;
  readonly selectionPending: boolean;
  readonly privacyConfirmed: boolean;
  readonly onOpenThread: (id: string) => void;
}
export function canReviewVoiceRequests(props: VoiceRequestsProps): boolean {
  return Boolean(
    props.ownerId &&
    props.surface === DEFAULT_CHAT_SURFACE &&
    props.mainThreadId &&
    props.selectedThreadId === props.mainThreadId &&
    !props.privateMode &&
    !props.selectionPending &&
    props.privacyConfirmed
  );
}
export function VoiceRequests(props: VoiceRequestsProps) {
  return canReviewVoiceRequests(props) ? (
    <VoiceRequestList
      key={props.ownerId}
      ownerId={props.ownerId!}
      onOpenThread={props.onOpenThread}
    />
  ) : null;
}
function VoiceRequestList(props: {
  readonly ownerId: string;
  readonly onOpenThread: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const client = useQueryClient();
  const key = ["chat", "voice-requests", props.ownerId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      requestJson<{ requests: readonly ChatVoiceRequestStatus[] }>("/api/chat/voice-requests"),
    refetchInterval: 5000
  });
  const send = useMutation({
    mutationFn: (id: string) =>
      requestJson<ChatVoiceRequestStatus>(
        `/api/chat/voice-requests/${encodeURIComponent(id)}/send`,
        { method: "POST" }
      ),
    // Always re-read after an uncertain response; the server owns admission and replay protection.
    onSettled: () => client.invalidateQueries({ queryKey: key })
  });
  return (
    <section className="chat-voice-requests" aria-label="Ring voice requests">
      <DisclosureToggle
        expanded={expanded}
        controls={region}
        onClick={() => setExpanded(!expanded)}
      >
        Ring voice requests{query.data ? ` (${query.data.requests.length})` : ""}
      </DisclosureToggle>
      {expanded ? (
        <div id={region} className="chat-voice-requests__list">
          {query.isPending ? <Note variant="practical">Loading voice requests…</Note> : null}
          {query.isError ? (
            <Note variant="practical">
              Could not load voice requests.{" "}
              <Button variant="link" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </Note>
          ) : null}
          {query.data?.requests.length === 0 ? (
            <EmptyState
              title="No voice requests"
              description="Finish a hold-to-talk recording with voice input enabled in the companion."
            />
          ) : null}
          {query.data?.requests.map((request) => (
            <article key={request.id} className="chat-voice-requests__item">
              <p>{request.transcript || "No speech detected."}</p>
              <Note variant="practical">{request.statusMessage}</Note>
              {request.state === "ready-to-send" ? (
                <Button size="sm" disabled={send.isPending} onClick={() => send.mutate(request.id)}>
                  Send to Main
                </Button>
              ) : null}
              {request.state === "replied" ? (
                <Button variant="link" onClick={() => props.onOpenThread(request.threadId)}>
                  Open reply
                </Button>
              ) : null}
            </article>
          ))}
          {send.isError ? (
            <Note variant="practical">
              Send could not be confirmed. Status will refresh; review it before trying again.
            </Note>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
