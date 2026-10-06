import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUuid } from "@moss/module-web-sdk";
import { Button } from "@moss/ui";
import { MeetingSetup } from "./meeting-setup.js";
import { MeetingHistory } from "./meeting-history.js";
import { MeetingRecord } from "./meeting-record.js";
import { createMeeting, getMeetingPreferences, meetingKeys } from "./client.js";
import { historyKeys } from "./history-client.js";
import { useSessionDraft } from "./session-draft.js";
import "./styles.css";

interface NewMeetingState {
  readonly requestKey?: string;
  readonly phase: "idle" | "checking" | "setup" | "creating" | "failed";
}

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const client = useQueryClient();
  const historyView = useSessionDraft(historyKeys.view, () => ({ query: "" }));
  const creationKey = ["meetings", "new-meeting"] as const;
  const creation = useSessionDraft<NewMeetingState>(creationKey, () => ({ phase: "idle" }));
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences,
    retry: false
  });
  const [setup, setSetup] = useState(false);
  const navigation = useLocation().key;
  const locationRef = useRef(navigation);
  locationRef.current = navigation;
  const hasReference = ["segmentId", "segmentRevision", "startCharacter", "endCharacter"].some(
    (field) => params.has(field)
  );
  useEffect(() => {
    if (!id || !hasReference) return;
    void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
    void client.invalidateQueries({ queryKey: meetingKeys.transcript(id), exact: true });
  }, [client, id, hasReference, navigation]);
  const open = (meetingId: string) => {
    setSetup(false);
    setParams({ id: meetingId });
  };
  const currentCreation = () => client.getQueryData<NewMeetingState>(creationKey);
  async function create() {
    const current = currentCreation();
    if (!current || current.phase === "creating") return;
    const requestKey = current.requestKey ?? randomUuid();
    const startingLocation = locationRef.current;
    creation.update(() => ({ requestKey, phase: "creating" }));
    const owns = () =>
      creation.currentSession() &&
      currentCreation()?.requestKey === requestKey &&
      currentCreation()?.phase === "creating";
    try {
      const result = await createMeeting({ requestKey, title: "Untitled meeting" });
      if (!owns()) return;
      creation.update(() => ({ phase: "idle" }));
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      if (startingLocation === locationRef.current) open(result.meeting.id);
    } catch {
      if (owns()) creation.update(() => ({ requestKey, phase: "failed" }));
    }
  }
  async function newMeeting() {
    const current = currentCreation();
    if (!current || current.phase === "creating" || current.phase === "checking") return;
    if (current.phase === "failed") {
      void create();
      return;
    }
    const requestKey = current.requestKey ?? randomUuid();
    const startingLocation = locationRef.current;
    creation.update(() => ({ requestKey, phase: "checking" }));
    const checked = await preferences.refetch();
    if (
      !creation.currentSession() ||
      currentCreation()?.requestKey !== requestKey ||
      currentCreation()?.phase !== "checking"
    )
      return;
    if (checked.isError || !checked.data || startingLocation !== locationRef.current) {
      creation.update(() => ({ phase: "idle" }));
      return;
    }
    if (!checked.data.setupCompletedAt) {
      creation.update(() => ({ requestKey, phase: "setup" }));
      setSetup(true);
    } else void create();
  }
  const cancelSetup = () => {
    creation.update(() => ({ phase: "idle" }));
    setSetup(false);
  };
  return (
    <div className="meetings-page">
      {id ? (
        <MeetingRecord
          key={id}
          id={id}
          onBack={() => setParams({})}
          onDeleted={() => setParams({})}
        />
      ) : setup ? (
        <MeetingSetup
          onCompleted={() => {
            if (creation.currentSession() && currentCreation()?.phase === "setup") {
              setSetup(false);
              void create();
            }
          }}
          onCancel={cancelSetup}
          onNotesOnly={() => {
            if (creation.currentSession() && currentCreation()?.phase === "setup") {
              setSetup(false);
              void create();
            }
          }}
        />
      ) : (
        <>
          <div className="meetings-list-heading">
            <h1>Meetings</h1>
            <Button
              disabled={creation.data.phase === "creating" || preferences.isFetching}
              onClick={() => void newMeeting()}
            >
              {creation.data.phase === "creating" ? "Opening meeting…" : "New meeting"}
            </Button>
          </div>
          {preferences.isError ? (
            <p role="alert" className="jds-hint jds-hint--error">
              Couldn’t check your meeting setup.{" "}
              <Button variant="link" onClick={() => void preferences.refetch()}>
                Try again
              </Button>
            </p>
          ) : null}
          {creation.data.phase === "failed" ? (
            <p role="alert" className="jds-hint jds-hint--error">
              Couldn’t confirm the new meeting.{" "}
              <Button variant="link" onClick={() => void create()}>
                Retry opening meeting
              </Button>
            </p>
          ) : null}
          <MeetingHistory
            search={historyView.data.query}
            onSearch={(query) => historyView.update(() => ({ query }))}
            onOpen={open}
          />
        </>
      )}
    </div>
  );
}
