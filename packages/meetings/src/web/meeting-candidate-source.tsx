import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button } from "@moss/ui";
import type { MeetingActionCandidate, MeetingOutputArtifact } from "@moss/shared";
import { getMeetingOutputArtifact } from "./output-client.js";
import { outputAccessEpoch } from "./output-access.js";
import { denyMeetingOutputs } from "./output-session.js";
import { MeetingActionReview } from "./meeting-action-review.js";

/** Candidate identity can outlive the bounded summary history window. */
export function MeetingCandidateSource({
  candidate,
  artifact
}: {
  readonly candidate: MeetingActionCandidate;
  readonly artifact: MeetingOutputArtifact | undefined;
}) {
  const client = useQueryClient();
  const source = useQuery({
    queryKey: ["meetings", "output-artifact", candidate.meetingId, candidate.artifactVersion],
    queryFn: async ({ signal }) => {
      const epoch = outputAccessEpoch(client, candidate.meetingId);
      try {
        return await getMeetingOutputArtifact(
          candidate.meetingId,
          candidate.artifactVersion,
          signal
        );
      } catch (error) {
        if (!signal.aborted && outputAccessEpoch(client, candidate.meetingId) === epoch)
          denyMeetingOutputs(client, candidate.meetingId, error);
        throw error;
      }
    },
    enabled: !artifact,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  const resolved =
    artifact ?? (!source.isError && !source.isFetching ? source.data?.artifact : undefined);
  if (resolved) return <MeetingActionReview candidate={candidate} artifact={resolved} />;
  return (
    <article className="meetings-section">
      <p>
        {candidate.proposal.text} ·{" "}
        {candidate.reviewState === "pending"
          ? "Pending review"
          : candidate.reviewState === "accepted"
            ? "Accepted"
            : "Dismissed"}
      </p>
      <p role="status" className="jds-hint">
        {source.isError
          ? `Couldn’t load evidence version ${candidate.artifactVersion}. Load it before reviewing this suggestion.`
          : `Loading evidence version ${candidate.artifactVersion}…`}
      </p>
      {source.isError ? (
        <Button variant="secondary" onClick={() => void source.refetch()}>
          Retry loading action evidence
        </Button>
      ) : null}
      {candidate.reviewState === "accepted" && candidate.acceptedTaskId ? (
        <p className="jds-hint">
          Task reference: {candidate.acceptedTaskId} · <Link to="/tasks">Go to Tasks</Link>
        </p>
      ) : null}
    </article>
  );
}
