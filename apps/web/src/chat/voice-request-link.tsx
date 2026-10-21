import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import type { ChatVoiceRequestStatus } from "@moss/shared";
import { Button, Note } from "@moss/ui";

/** A link is a lookup of an owned receipt, never an instruction to send its transcript. */
export function VoiceRequestLink(props: {
  readonly ownerId: string;
  readonly enabled: boolean;
  readonly onOpenThread: (id: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const id = new URLSearchParams(location.search).get("voiceRequest");
  const valid =
    id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  const query = useQuery({
    queryKey: ["chat", "voice-request-link", props.ownerId, id],
    queryFn: () =>
      requestJson<ChatVoiceRequestStatus>(`/api/chat/voice-requests/${encodeURIComponent(id!)}`),
    enabled: valid && props.enabled,
    retry: false
  });
  const dismiss = () => {
    const search = new URLSearchParams(location.search);
    search.delete("voiceRequest");
    navigate(
      { pathname: location.pathname, search: search.toString(), hash: location.hash },
      { replace: true }
    );
  };
  useEffect(() => {
    if (!props.enabled || !query.data || query.data.id !== id) return;
    props.onOpenThread(query.data.threadId);
    dismiss();
  });
  if (id === null) return null;
  if (!valid || query.isError)
    return (
      <Note variant="practical">
        Could not open this voice request.{" "}
        {valid ? (
          <Button variant="link" onClick={() => void query.refetch()}>
            Retry
          </Button>
        ) : null}
        <Button variant="link" onClick={dismiss}>
          Dismiss
        </Button>
      </Note>
    );
  return (
    <Note variant="practical">
      {props.enabled ? "Opening voice request…" : "Open Main chat to review this voice request."}
    </Note>
  );
}
