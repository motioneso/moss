import { useEffect } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Masthead } from "@moss/ui";
import { MeetingSetup } from "./meeting-setup.js";
import { MeetingHistory } from "./meeting-history.js";
import { MeetingRecord } from "./meeting-record.js";
import { useMeetingDate } from "./locale.js";
import { isMeetingAccessDenied, meetingKeys, meetingRecordQueryOptions } from "./client.js";
import { historyKeys } from "./history-client.js";
import { historyFilter } from "./history-presentation.js";
import "./styles.css";

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const date = useMeetingDate();
  const client = useQueryClient();
  const historyView = useQuery({
    queryKey: historyKeys.view,
    queryFn: () => ({ query: "" }),
    initialData: () => client.getQueryData<{ query: string }>(historyKeys.view) ?? { query: "" },
    enabled: false,
    gcTime: Infinity
  });
  const navigation = useLocation().key;
  const hasReference = ["segmentId", "segmentRevision", "startCharacter", "endCharacter"].some(
    (field) => params.has(field)
  );
  // Citation navigation can stay on this mounted meeting while newer text arrives.
  // Reauthorize the record as well as refreshing the latest transcript; keep this
  // effect above the loading boundary so child remounts cannot retrigger it.
  useEffect(() => {
    if (!id || !hasReference) return;
    void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
    void client.invalidateQueries({ queryKey: meetingKeys.transcript(id), exact: true });
  }, [client, id, hasReference, navigation]);
  const history = params.get("view") === "history";
  const record = useQuery(meetingRecordQueryOptions(id ?? ""));
  const showHistory = () => {
    const next = new URLSearchParams({ view: "history" });
    const selected = id ?? params.get("selected");
    if (selected) next.set("selected", selected);
    if (params.has("state")) next.set("state", historyFilter(params.get("state")));
    setParams(next);
  };
  const showSetup = () => setParams({});
  const open = (meetingId: string) => {
    const next = new URLSearchParams({ id: meetingId, selected: meetingId });
    if (params.has("state")) next.set("state", historyFilter(params.get("state")));
    setParams(next);
  };
  return (
    <div className="meetings-page">
      <Masthead
        tone={id ? "default" : "field"}
        compact={!!id}
        eyebrow={id ? "Meeting review" : history ? "Your meetings" : "Meeting companion"}
        title={
          id
            ? !isMeetingAccessDenied(record.error)
              ? (record.data?.meeting.title ?? "Your meeting draft")
              : "Your meeting draft"
            : history
              ? "Good conversations, kept useful."
              : "A clear record. Room to listen."
        }
        lede={
          id
            ? !isMeetingAccessDenied(record.error) && record.data
              ? date(record.data.meeting.createdAt)
              : undefined
            : history
              ? "Find a conversation, revisit its notes, or ask Moss what happened."
              : "Create a draft, keep your personal notes, and find them again."
        }
        aside={
          <Button variant={id ? "secondary" : "field"} onClick={history ? showSetup : showHistory}>
            {history ? "New meeting draft" : "View meeting history"}
          </Button>
        }
      />
      <main className="meetings-body">
        {id ? (
          <MeetingRecord key={id} id={id} onBack={showHistory} />
        ) : history ? (
          <MeetingHistory
            search={historyView.data?.query ?? ""}
            filter={historyFilter(params.get("state"))}
            selectedId={params.get("selected")}
            detailOpen={params.has("selected") && params.get("panel") !== "results"}
            onSearch={(query) => {
              client.setQueryData<{ query: string }>(historyKeys.view, (current) =>
                current ? { query } : undefined
              );
              setParams(
                (current) => {
                  current.delete("selected");
                  current.delete("panel");
                  return current;
                },
                { replace: true }
              );
            }}
            onFilter={(filter) =>
              setParams((current) => {
                current.set("state", filter);
                current.delete("selected");
                current.delete("panel");
                return current;
              })
            }
            onSelect={(selected) =>
              setParams((current) => {
                current.set("selected", selected);
                current.delete("panel");
                return current;
              })
            }
            onResults={() =>
              setParams((current) => {
                current.set("panel", "results");
                return current;
              })
            }
            onOpen={open}
            onNew={showSetup}
          />
        ) : (
          <MeetingSetup onCreated={open} />
        )}
      </main>
    </div>
  );
}
