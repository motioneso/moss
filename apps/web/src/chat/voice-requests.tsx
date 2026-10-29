import type { ComponentProps, ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatSurface,
  type ChatVoiceRequestCursor,
  type ChatVoiceRequestStatus,
  type ListChatVoiceRequestsResponse
} from "@moss/shared";
import { Button, Note, Thread } from "@moss/ui";
import { listChatThreadMessages } from "../api/client";
import { recordsFromMessages } from "./use-chat-stream";
import { RecordRow } from "./message-row";
import { mergeVoiceInputRecords } from "./voice-input-records";

interface VoiceScope {
  readonly ownerId?: string;
  readonly surface: ChatSurface;
  readonly mainThreadId?: string;
  readonly selectedThreadId: string | null;
  readonly privateMode: boolean;
  readonly selectionPending: boolean;
  readonly privacyConfirmed: boolean;
}
type VoiceThreadProps = ComponentProps<typeof Thread> &
  VoiceScope & { readonly children?: ReactNode };

export function canReviewVoiceRequests(props: VoiceScope): boolean {
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

/** Lives inside the drawer's scrolling transcript; ineligible selections never mount receipt queries. */
export function VoiceInputThread(props: VoiceThreadProps) {
  if (!canReviewVoiceRequests(props))
    return props.records.length ? <Thread {...props} /> : props.children;
  return <OwnerVoiceThread key={`${props.ownerId}:${props.mainThreadId}`} {...props} />;
}

function OwnerVoiceThread(props: VoiceThreadProps) {
  const client = useQueryClient();
  const key = ["chat", "voice-requests", props.ownerId];
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as ChatVoiceRequestCursor | null,
    queryFn: ({ pageParam }) => {
      const params = pageParam
        ? `?${new URLSearchParams({ beforeCreatedAt: pageParam.createdAt, beforeId: pageParam.id })}`
        : "";
      return requestJson<ListChatVoiceRequestsResponse>(`/api/chat/voice-requests${params}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5000
  });
  const requests =
    query.data?.pages
      .flatMap((page) => page.requests)
      .filter((request) => request.threadId === props.mainThreadId) ?? [];
  const completed = requests.filter((request) => request.state === "replied");
  const history = useQuery({
    queryKey: [
      "chat",
      "voice-history",
      props.ownerId,
      props.mainThreadId,
      completed.map((r) => r.id).sort()
    ],
    queryFn: () => listChatThreadMessages(props.mainThreadId!, props.surface),
    enabled: completed.length > 0
  });
  const recovered = new Map(
    completed.map((request) => [
      request.turnId,
      recordsFromMessages(
        history.data?.messages.filter((message) => message.turnId === request.turnId) ?? []
      )
    ])
  );
  const records = mergeVoiceInputRecords(
    props.records,
    requests,
    recovered,
    recordsFromMessages(history.data?.messages ?? [])
  );
  // An interrupted notice only matters until the conversation moves on.
  const latestUserTurn = [...records].reverse().find((record) => record.kind === "user")?.turnId;
  const send = useMutation({
    mutationFn: (id: string) =>
      requestJson<ChatVoiceRequestStatus>(
        `/api/chat/voice-requests/${encodeURIComponent(id)}/send`,
        { method: "POST" }
      ),
    // Keep retry disabled until this authoritative refresh settles after an uncertain response.
    onSettled: () => client.invalidateQueries({ queryKey: key })
  });
  return (
    <>
      {query.hasNextPage ? (
        <Button
          variant="link"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older voice inputs
        </Button>
      ) : null}
      {records.length ? (
        <Thread
          records={records}
          working={props.working}
          renderRecord={(record, index, context) => (
            <>
              {props.renderRecord ? (
                props.renderRecord(record, index, context)
              ) : (
                <RecordRow record={record} />
              )}
              {record.kind === "user" ? (
                <VoiceInputStatus
                  request={requests.find((request) => request.turnId === record.turnId)}
                  latest={record.turnId === latestUserTurn}
                  sending={
                    send.isPending ||
                    query.isFetching ||
                    (send.isError && (query.isError || query.dataUpdatedAt < send.submittedAt))
                  }
                  onSend={send.mutate}
                />
              ) : null}
            </>
          )}
        />
      ) : (
        props.children
      )}
      {query.isPending ? <Note variant="practical">Loading voice inputs…</Note> : null}
      {query.isError || history.isError ? (
        <Note variant="practical">
          Could not load voice inputs.{" "}
          <Button
            variant="link"
            onClick={() => {
              void query.refetch();
              void history.refetch();
            }}
          >
            Retry
          </Button>
        </Note>
      ) : null}
      {send.isError ? (
        <Note variant="practical">
          Send could not be confirmed. Status will refresh; review it before trying again.
        </Note>
      ) : null}
    </>
  );
}
function VoiceInputStatus(props: {
  readonly request?: ChatVoiceRequestStatus;
  readonly sending: boolean;
  readonly latest: boolean;
  readonly onSend: (id: string) => void;
}) {
  const request = props.request;
  if (!request || request.state === "replied") return null;
  if (request.state === "interrupted" && !props.latest) return null;
  return (
    <Note variant="practical">
      {request.statusMessage}
      {request.state === "ready-to-send" ? (
        <>
          {" "}
          <Button size="sm" disabled={props.sending} onClick={() => props.onSend(request.id)}>
            Send to Main
          </Button>
        </>
      ) : null}
    </Note>
  );
}
