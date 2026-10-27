import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Menu } from "@moss/ui";
import { ApiError } from "@moss/module-web-sdk";
import { meetingKeys } from "./client.js";
import { getRecording, putRecordingType, recordingKeys } from "./recording-client.js";

export function RecordingTypePicker({ meetingId }: { readonly meetingId: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const query = useQuery({
    queryKey: recordingKeys.record(meetingId),
    queryFn: ({ signal }) => getRecording(meetingId, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  const data = query.data;
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  if (denied) return null;
  if (query.isError)
    return (
      <p role="alert" className="jds-hint">
        Couldn’t load recording type.{" "}
        <Button variant="link" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </p>
    );
  if (!data)
    return (
      <p role="status" className="jds-hint">
        Loading recording type…
      </p>
    );
  const current = data.configuration.types.find((type) => type.id === data.metadata?.typeId);
  async function change(typeId: string) {
    if (busy || !data) return;
    setBusy(true);
    setFailed(false);
    try {
      await putRecordingType(meetingId, { expectedRevision: data.metadata?.revision ?? 0, typeId });
      await client.invalidateQueries({ queryKey: recordingKeys.record(meetingId) });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
    } catch {
      setFailed(true);
      void query.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="meetings-section">
      <div className="meetings-actions">
        <Menu
          triggerVariant="chip"
          triggerLabel={`Recording type: ${current?.name ?? "Automatic"}`}
          triggerContent={current?.name ?? "Automatic"}
          items={data.configuration.types
            .filter((type) => !type.retired)
            .map((type) => ({
              id: type.id,
              label: type.name,
              checked: type.id === data.metadata?.typeId,
              disabled: busy
            }))}
          onSelect={(typeId) => void change(typeId)}
        />
        {data.metadata?.side ? (
          <Badge tone="neutral" pill>
            {data.metadata.side === "personal" ? "Personal" : "Work"}
          </Badge>
        ) : null}
        {busy ? (
          <span role="status" className="jds-hint">
            Saving type…
          </span>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t save the type. Review the current value and try again.
        </p>
      ) : null}
    </div>
  );
}
