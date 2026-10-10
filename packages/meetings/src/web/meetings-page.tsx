import { useEffect, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { randomUuid } from "@moss/module-web-sdk";
import { Button, SectionHead, buttonLinkClassName } from "@moss/ui";
import { MeetingNotLinked } from "./meeting-not-linked.js";
import { useMeetingConnection } from "./meeting-connection.js";
import { MeetingHistory } from "./meeting-history.js";
import { MeetingRecord } from "./meeting-record.js";
import { createMeeting, meetingKeys } from "./client.js";
import { historyKeys } from "./history-client.js";
import { useSessionDraft } from "./session-draft.js";
import "./styles.css";

interface NewMeetingState {
  readonly requestKey?: string;
  readonly phase: "idle" | "creating" | "failed";
}

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get("id");
  const client = useQueryClient();
  const historyView = useSessionDraft(historyKeys.view, () => ({ query: "" }));
  const creationKey = ["meetings", "new-meeting"] as const;
  const creation = useSessionDraft<NewMeetingState>(creationKey, () => ({ phase: "idle" }));
  const connection = useMeetingConnection();
  const navigation = useLocation().key;
  const locationRef = useRef(navigation);
  locationRef.current = navigation;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const hasReference = ["segmentId", "segmentRevision", "startCharacter", "endCharacter"].some(
    (field) => params.has(field)
  );
  useEffect(() => {
    if (!id || !hasReference) return;
    void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
    void client.invalidateQueries({ queryKey: meetingKeys.transcript(id), exact: true });
  }, [client, id, hasReference, navigation]);
  const open = (meetingId: string) => {
    setParams({ id: meetingId });
  };
  const currentCreation = () => client.getQueryData<NewMeetingState>(creationKey);
  async function create() {
    const current = currentCreation();
    if (!mounted.current || !creation.currentSession() || !current || current.phase === "creating")
      return;
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
      if (mounted.current && startingLocation === locationRef.current) open(result.meeting.id);
    } catch {
      if (owns()) creation.update(() => ({ requestKey, phase: "failed" }));
    }
  }
  return (
    <div className="meetings-page">
      {id ? (
        <MeetingRecord
          key={id}
          id={id}
          onBack={() => setParams({})}
          onDeleted={() => setParams({})}
        />
      ) : (
        <>
          <div className="meetings-list-heading">
            <SectionHead title="Meetings" titleAs="h1" />
            <Link
              className={buttonLinkClassName("link")}
              to="/settings?section=modules&module=meetings"
            >
              Settings
            </Link>
            {connection.linked.length ? (
              <Button
                disabled={
                  creation.data.phase === "creating" || connection.loading || connection.denied
                }
                onClick={() => void create()}
              >
                {creation.data.phase === "creating" ? "Opening meeting…" : "New meeting"}
              </Button>
            ) : null}
          </div>
          {connection.denied ? (
            <p role="alert" className="jds-hint jds-hint--error">
              Mac access could not be verified. Sign in again.
            </p>
          ) : connection.loading ? (
            <p role="status" className="jds-hint">
              Checking your linked Mac…
            </p>
          ) : connection.unavailable ? (
            <p role="status" className="jds-hint">
              Couldn’t confirm your Mac connection.{" "}
              <Button variant="link" onClick={connection.refresh}>
                Check again
              </Button>
            </p>
          ) : !connection.linked.length ? (
            <MeetingNotLinked />
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
            hideWhenEmpty={!connection.linked.length}
            search={historyView.data.query}
            onSearch={(query) => historyView.update(() => ({ query }))}
            onOpen={open}
          />
        </>
      )}
    </div>
  );
}
