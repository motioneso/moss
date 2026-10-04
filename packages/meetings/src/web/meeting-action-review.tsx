import { Link } from "react-router";
import { randomUuid } from "@moss/module-web-sdk";
import { Button, Divider, Field, FormLabel, Note, Switch } from "@moss/ui";
import type {
  MeetingActionCandidate,
  MeetingOutputArtifact,
  ReviewMeetingActionInput
} from "@moss/shared";
import { outputKeys, reviewMeetingAction } from "./output-client.js";
import { operationError, useOutputSession, type OutputOperation } from "./output-session.js";
import { OutputEvidence } from "./output-evidence.js";

interface ReviewState {
  readonly title: string;
  readonly ownerReviewed: boolean;
  readonly matchesReviewed: boolean;
  readonly operation?: OutputOperation<ReviewMeetingActionInput>;
  readonly result?: MeetingActionCandidate;
}
export function MeetingActionReview({
  candidate,
  artifact
}: {
  readonly candidate: MeetingActionCandidate;
  readonly artifact: MeetingOutputArtifact;
}) {
  const session = useOutputSession<ReviewState>(
    candidate.meetingId,
    `action:${candidate.id}`,
    () => ({
      title: candidate.proposal.text,
      ownerReviewed: false,
      matchesReviewed: false
    })
  );
  const { state, update, client } = session;
  if (state === undefined || session.denied)
    return (
      <p role="status" className="jds-hint">
        Summary access is unavailable. Return to history or sign in again.
      </p>
    );
  const result = state.result ?? candidate;
  const busy = state.operation?.status === "running";
  const uncertain = candidate.possibleMatchIds.length > 0;
  async function review(decision: "accept" | "dismiss") {
    if (busy || !session.authorized()) return;
    const input =
      state.operation?.status === "retry"
        ? state.operation.input
        : {
            requestKey: randomUuid(),
            decision,
            ...(decision === "accept"
              ? {
                  title: state.title.trim(),
                  dueAt: null,
                  createDespitePossibleMatches: state.matchesReviewed
                }
              : {})
          };
    update((current) => ({
      ...current,
      operation: { input, status: "running", message: "Saving review…" }
    }));
    try {
      const saved = await reviewMeetingAction(candidate.meetingId, candidate.id, input);
      if (!session.authorized()) return;
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : {
              ...current,
              result: saved,
              operation: {
                input,
                status: "done",
                message: saved.reviewState === "accepted" ? "Added to your Tasks." : "Dismissed."
              }
            }
      );
      void client.invalidateQueries({ queryKey: outputKeys.list(candidate.meetingId) });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    } catch (error) {
      if (session.deny(error) || !session.authorized()) return;
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : { ...current, operation: { input, ...operationError(error) } }
      );
    }
  }
  return (
    <article className="meetings-section">
      <Divider />
      {result.reviewState === "pending" ? (
        <Field>
          <FormLabel htmlFor={`action-${candidate.id}`}>
            Suggested Task · version {candidate.artifactVersion}
          </FormLabel>
          <input
            id={`action-${candidate.id}`}
            className="jds-input meetings-input"
            value={state.title}
            maxLength={500}
            disabled={busy || state.operation?.status === "retry"}
            onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
          />
        </Field>
      ) : (
        <p>
          {candidate.proposal.text} · {result.reviewState === "accepted" ? "Accepted" : "Dismissed"}
        </p>
      )}
      <p className="jds-hint">
        Owner phrase: {candidate.proposal.ownerPhrase ?? "Unassigned"} · Due phrase:{" "}
        {candidate.proposal.duePhrase ?? "No date stated"}. No due date is set here; choose one in
        Tasks.
      </p>
      <OutputEvidence evidence={candidate.proposal.evidence} artifact={artifact} />
      {result.reviewState === "pending" ? (
        <>
          <div className="meetings-actions">
            <Switch
              ariaLabel="Create in my Tasks after owner review"
              checked={state.ownerReviewed}
              disabled={busy || state.operation?.status === "retry"}
              onChange={(ownerReviewed) => update((current) => ({ ...current, ownerReviewed }))}
            />
            <span>Create in my Tasks after reviewing the owner</span>
          </div>
          {uncertain ? (
            <Note variant="practical">
              <p>
                This may overlap {candidate.possibleMatchIds.length} earlier suggestion(s). Review
                earlier versions and accepted Tasks first.
              </p>
              <div className="meetings-actions">
                <Switch
                  ariaLabel="Create a separate Task despite possible matches"
                  checked={state.matchesReviewed}
                  disabled={busy || state.operation?.status === "retry"}
                  onChange={(matchesReviewed) =>
                    update((current) => ({ ...current, matchesReviewed }))
                  }
                />
                <span>Create a separate Task despite possible matches</span>
              </div>
            </Note>
          ) : null}
          <div className="meetings-actions">
            {state.operation?.status === "retry" ? (
              <Button onClick={() => void review(state.operation!.input.decision)}>
                Retry review
              </Button>
            ) : (
              <>
                <Button
                  disabled={
                    busy ||
                    !state.ownerReviewed ||
                    !state.title.trim() ||
                    state.title.includes("\0") ||
                    (uncertain && !state.matchesReviewed)
                  }
                  onClick={() => void review("accept")}
                >
                  Accept Task
                </Button>
                <Button variant="quiet" disabled={busy} onClick={() => void review("dismiss")}>
                  Dismiss
                </Button>
              </>
            )}
          </div>
        </>
      ) : result.acceptedTaskId ? (
        <p className="jds-hint">
          Task reference: {result.acceptedTaskId} · <Link to="/tasks">Go to Tasks</Link>
        </p>
      ) : null}
      {state.operation ? (
        <p role="status" className="jds-hint">
          {state.operation.message}
        </p>
      ) : null}
    </article>
  );
}
