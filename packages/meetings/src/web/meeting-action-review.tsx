import { Link } from "react-router";
import { randomUuid } from "@moss/module-web-sdk";
import { Button, Divider, Field, FormLabel } from "@moss/ui";
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
      title: candidate.proposal.text
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
                  createDespitePossibleMatches: uncertain
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
          <FormLabel htmlFor={`action-${candidate.id}`}>Suggested task</FormLabel>
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
          {result.reviewState === "accepted"
            ? state.operation?.status === "done" && state.operation.input.decision === "accept"
              ? `Created as: ${state.operation.input.title} · Accepted`
              : `Original suggestion: ${candidate.proposal.text} · Accepted`
            : `${candidate.proposal.text} · Dismissed`}
        </p>
      )}
      <p className="jds-hint">
        {candidate.proposal.ownerPhrase
          ? `Owner mentioned: ${candidate.proposal.ownerPhrase}`
          : "Unassigned"}{" "}
        ·{" "}
        {candidate.proposal.duePhrase
          ? `Date mentioned: ${candidate.proposal.duePhrase}`
          : "No due date"}
        . Choose a due date in Tasks.
      </p>
      <OutputEvidence evidence={candidate.proposal.evidence} artifact={artifact} />
      {result.reviewState === "pending" ? (
        <>
          {uncertain ? (
            <p className="jds-hint">
              Possible duplicate of {candidate.possibleMatchIds.length} earlier suggestion(s). Add
              to Tasks creates a separate task.
            </p>
          ) : null}
          <div className="meetings-actions">
            {state.operation?.status === "retry" ? (
              <Button onClick={() => void review(state.operation!.input.decision)}>
                Retry review
              </Button>
            ) : (
              <>
                <Button
                  disabled={busy || !state.title.trim() || state.title.includes("\0")}
                  onClick={() => void review("accept")}
                >
                  Add to Tasks
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
          Current Task details and edits are in <Link to="/tasks">Tasks</Link>.
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
