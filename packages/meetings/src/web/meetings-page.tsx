import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Masthead } from "@moss/ui";
import { MeetingSetup } from "./meeting-setup.js";
import { MeetingHistory } from "./meeting-history.js";
import { MeetingRecord } from "./meeting-record.js";
import { getMeeting, meetingKeys } from "./client.js";
import "./styles.css";

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const history = params.get("view") === "history";
  const record = useQuery({
    queryKey: meetingKeys.record(id ?? ""),
    queryFn: () => getMeeting(id!),
    enabled: !!id,
    retry: false
  });
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
            ? (record.data?.meeting.title ?? "Your meeting draft")
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
          <MeetingRecord id={id} onBack={showHistory} />
        ) : history ? (
          <MeetingHistory onOpen={open} onNew={showSetup} />
        ) : (
          <MeetingSetup onCreated={open} />
        )}
      </main>
    </div>
  );
}
