import { useEffect } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Masthead } from "@moss/ui";
import { MeetingSetup } from "./meeting-setup.js";
import { MeetingHistory } from "./meeting-history.js";
import { MeetingRecord } from "./meeting-record.js";
import { meetingKeys, meetingRecordQueryOptions } from "./client.js";
import "./styles.css";

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const client = useQueryClient();
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
  const showHistory = () => setParams({ view: "history" });
  const showSetup = () => setParams({});
  const open = (meetingId: string) => setParams({ id: meetingId });
  return (
    <div className="meetings-page">
      <Masthead
        tone="field"
        eyebrow={id ? "Meeting draft" : history ? "Your meetings" : "Meeting companion"}
        title={
          id
            ? !record.isError && !record.isFetching
              ? (record.data?.meeting.title ?? "Your meeting draft")
              : "Your meeting draft"
            : history
              ? "Good conversations, kept useful."
              : "A clear record. Room to listen."
        }
        lede={
          id
            ? "Draft · Not recorded"
            : "Create a draft, keep your personal notes, and find them again."
        }
        aside={
          <Button variant="field" onClick={history ? showSetup : showHistory}>
            {history ? "New meeting draft" : "View meeting history"}
          </Button>
        }
      />
      <main className="meetings-body">
        {id ? (
          <MeetingRecord key={id} id={id} onBack={showHistory} />
        ) : history ? (
          <MeetingHistory onOpen={open} onNew={showSetup} />
        ) : (
          <MeetingSetup onCreated={open} />
        )}
      </main>
    </div>
  );
}
