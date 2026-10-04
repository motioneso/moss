import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import {
  Badge,
  Button,
  Divider,
  Eyebrow,
  Field,
  FormLabel,
  Note,
  SectionHead,
  Select
} from "@moss/ui";
import type {
  GenerateMeetingOutputInput,
  MeetingOutputArtifact,
  MeetingRecord
} from "@moss/shared";
import { outputAccessEpoch, recoverOutputAccess } from "./output-access.js";
import { isMeetingAccessDenied } from "./client.js";
import { generateMeetingOutput, getMeetingOutputs, outputKeys } from "./output-client.js";
import { operationError, useOutputSession, type OutputOperation } from "./output-session.js";
import { OutputEvidence } from "./output-evidence.js";
import { MeetingCandidateSource } from "./meeting-candidate-source.js";
import { MeetingOutputEditor, hasKeptOutputEdits } from "./meeting-output-editor.js";
import { MeetingVaultExport } from "./meeting-vault-export.js";
import { summaryGenerationFailure, SummaryModelRecovery } from "./summary-generation-error.js";
interface SummaryState {
  readonly generatedVersion?: number;
  readonly pinnedArtifact?: MeetingOutputArtifact;
  readonly templateId: GenerateMeetingOutputInput["templateId"] | "";
  readonly operation?: OutputOperation<GenerateMeetingOutputInput> & {
    readonly remediation?: "ai-providers";
  };
}
export function ArtifactContent({ artifact }: { readonly artifact: MeetingOutputArtifact }) {
  return (
    <div className="meetings-section">
      <p className="meetings-transcript-text">{artifact.content.overview}</p>
      {artifact.content.decisions.map((claim, index) => (
        <article className="meetings-section" key={index}>
          <Divider />
          <p className="meetings-transcript-text">{claim.text}</p>
          <OutputEvidence evidence={claim.evidence} artifact={artifact} />
        </article>
      ))}
      {artifact.content.openQuestions.length ? (
        <div>
          <Eyebrow as="h3">Open questions</Eyebrow>
          <ul>
            {artifact.content.openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifact.content.warnings.map((warning, index) => (
        <Note key={index} variant="practical">
          {warning}
        </Note>
      ))}
    </div>
  );
}
export function MeetingSummary({
  meeting,
  transcriptRevision,
  sourceLoading,
  unsavedNotes
}: {
  readonly meeting: MeetingRecord;
  readonly transcriptRevision: number;
  readonly sourceLoading: boolean;
  readonly unsavedNotes: boolean;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const session = useOutputSession<SummaryState>(meeting.id, "generation", () => ({
    templateId: ""
  }));
  const { state, update, client } = session;
  const outputs = useQuery({
    queryKey: outputKeys.list(meeting.id),
    queryFn: async ({ signal }) => {
      const epoch = outputAccessEpoch(client, meeting.id);
      try {
        const result = await getMeetingOutputs(meeting.id, signal);
        recoverOutputAccess(client, meeting.id, epoch, signal);
        return result;
      } catch (error) {
        if (!signal.aborted && outputAccessEpoch(client, meeting.id) === epoch) session.deny(error);
        throw error;
      }
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: "always"
  });
  const [selected, setSelected] = useState<number | undefined>(
    () => state?.pinnedArtifact?.version
  );
  const pinned = state?.pinnedArtifact;
  const [editing, setEditing] = useState(false);
  const [compare, setCompare] = useState(false);
  if (state === undefined || session.denied)
    return (
      <p role="status" className="jds-hint">
        Summary access is unavailable. Return to history or sign in again.
      </p>
    );
  const data = outputs.data;
  const artifact =
    data?.artifacts.find((item) => item.version === (selected ?? data.headVersion)) ??
    (selected === pinned?.version ? pinned : undefined);
  const latest = data?.artifacts.find((item) => item.version === data.headVersion);
  const busy = state.operation?.status === "running";
  const retry = state.operation?.status === "retry" || state.operation?.status === "pending";
  async function generate() {
    if (busy || !session.authorized() || !data) return;
    const template = data.templates.find((item) => item.id === state.templateId);
    if (!retry && !template) return;
    const input = retry
      ? state.operation!.input
      : {
          requestKey: randomUuid(),
          expectedOutputVersion: data.headVersion,
          expectedTranscriptRevision: transcriptRevision,
          expectedNotesRevision: meeting.notesRevision,
          templateId: template!.id,
          templateVersion: template!.version
        };
    update((current) => ({
      ...current,
      generatedVersion: undefined,
      operation: { input, status: "running", message: "Generating a proposed version…" }
    }));
    try {
      const result = await generateMeetingOutput(meeting.id, input);
      if (!session.authorized()) return;
      const latestSession = client.getQueryData<SummaryState>(session.key);
      if (latestSession?.operation?.input.requestKey !== input.requestKey) return;
      const preserveEdits =
        !!latestSession.pinnedArtifact && hasKeptOutputEdits(client, latestSession.pinnedArtifact);
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : {
              ...current,
              pinnedArtifact:
                result.status === "saved" && !preserveEdits ? undefined : current.pinnedArtifact,
              generatedVersion:
                result.status === "saved" ? result.artifact.version : current.generatedVersion,
              operation:
                result.status === "failed"
                  ? { input, ...summaryGenerationFailure(result.code) }
                  : {
                      input,
                      status: result.status === "saved" ? "done" : "pending",
                      message:
                        result.status === "saved"
                          ? `Version ${result.artifact.version} saved. Earlier versions remain available.`
                          : "Generation is still pending. Check this request again."
                    }
            }
      );
      if (result.status === "saved" && !preserveEdits && active.current) {
        setSelected(result.artifact.version);
        setEditing(false);
        setCompare(false);
      }
      void client.invalidateQueries({ queryKey: outputKeys.list(meeting.id) });
    } catch (error) {
      if (session.deny(error) || !session.authorized()) return;
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : {
              ...current,
              operation: {
                input,
                ...(error instanceof ApiError && error.status === 422
                  ? summaryGenerationFailure(error.code)
                  : operationError(error))
              }
            }
      );
    }
  }
  return (
    <section className="meetings-section" aria-label="Summary and actions">
      <SectionHead
        number="01"
        title="Summary and actions"
        rule
        meta={artifact ? `Version ${artifact.version}` : undefined}
      />
      {outputs.isFetching && !data ? (
        <p role="status" className="jds-hint">
          Loading summaries…
        </p>
      ) : null}
      {session.denied ? (
        <p role="alert" className="jds-hint">
          Summary access is unavailable. Return to history or sign in again.
        </p>
      ) : outputs.isError && (!data || isMeetingAccessDenied(outputs.error)) ? (
        <>
          <p role="alert" className="jds-hint">
            {isMeetingAccessDenied(outputs.error)
              ? "Summary access is unavailable. Return to history or sign in again."
              : "Couldn’t load summaries. Retry to continue."}
          </p>
          <Button variant="secondary" onClick={() => void outputs.refetch()}>
            Retry loading summaries
          </Button>
        </>
      ) : data ? (
        <>
          <div className="meetings-actions">
            <Field>
              <FormLabel htmlFor="meeting-template">Summary template</FormLabel>
              <Select
                id="meeting-template"
                value={state.templateId}
                disabled={busy || retry}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    templateId: event.target.value as SummaryState["templateId"]
                  }))
                }
              >
                <option value="">Choose a template</option>
                {data.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · v{template.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              disabled={busy || (!retry && (!state.templateId || sourceLoading || unsavedNotes))}
              onClick={() => void generate()}
            >
              {retry
                ? "Check or retry generation"
                : data.headVersion
                  ? "Generate new version"
                  : "Generate summary"}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => void outputs.refetch()}>
              Refresh summaries
            </Button>
          </div>
          {unsavedNotes ? (
            <Note variant="practical">
              Generation uses saved personal notes. Save your edits first.
            </Note>
          ) : null}
          {state.operation ? (
            <p role="status" className="jds-hint">
              {state.operation.message}
            </p>
          ) : null}
          {state.operation?.remediation === "ai-providers" ? <SummaryModelRecovery /> : null}
          {state.generatedVersion && artifact?.version !== state.generatedVersion ? (
            <div className="meetings-actions">
              <p className="jds-hint">
                The new version is ready. Your kept edits stay with their original version.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setSelected(state.generatedVersion);
                  setEditing(false);
                  setCompare(false);
                }}
              >
                View generated version
              </Button>
            </div>
          ) : null}
          {data.omittedArtifactCount ? (
            <p className="jds-hint">
              Showing recent versions. Evidence from earlier versions is available from its
              suggestion.
            </p>
          ) : null}
          {data.artifacts.length ? (
            <Field>
              <FormLabel htmlFor="meeting-output-version">Saved version</FormLabel>
              <Select
                id="meeting-output-version"
                value={artifact?.version ?? ""}
                onChange={(event) => {
                  setSelected(Number(event.target.value));
                  setEditing(false);
                }}
              >
                {pinned && !data.artifacts.some((item) => item.version === pinned.version) ? (
                  <option value={pinned.version}>Version {pinned.version} · Kept edits</option>
                ) : null}
                {data.artifacts.map((item) => (
                  <option key={item.version} value={item.version}>
                    Version {item.version} ·{" "}
                    {item.origin === "manual" ? "Manual edits" : "Generated"}
                    {item.version === data.headVersion ? " · Latest" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="jds-hint">
              Choose a template to create the first summary from saved personal notes and retained
              transcript.
            </p>
          )}
          {artifact ? (
            <>
              <p className="jds-hint">
                {data.templates.find((template) => template.id === artifact.templateId)?.name ??
                  "Meeting summary"}{" "}
                · {artifact.origin === "manual" ? "Edited by you" : "Generated from saved sources"}
              </p>
              {artifact.stale ? (
                <Note variant="practical">
                  Source text changed. This version may be out of date.
                </Note>
              ) : null}
              {artifact.inputs.transcript?.containsProvisional ? (
                <Badge tone="amber">Includes provisional transcript</Badge>
              ) : null}
              {(artifact.inputs.transcript?.omittedSegments ?? 0) > 0 ? (
                <Note variant="practical">
                  Generated from a partial transcript: {artifact.inputs.transcript?.omittedSegments}{" "}
                  segments omitted.
                </Note>
              ) : null}
              <ArtifactContent artifact={artifact} />
              <div className="meetings-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    update((current) => ({ ...current, pinnedArtifact: artifact }));
                    setSelected(artifact.version);
                    setEditing(!editing);
                  }}
                >
                  {artifact.version === data.headVersion
                    ? "Edit this version"
                    : "Review kept edits"}
                </Button>
                {latest && latest.version !== artifact.version ? (
                  <Button variant="quiet" onClick={() => setCompare(!compare)}>
                    {compare ? "Hide latest comparison" : "Compare with latest"}
                  </Button>
                ) : null}
              </div>
              {compare && latest && latest.version !== artifact.version ? (
                <section className="meetings-section">
                  <Eyebrow as="h3">Latest · version {latest.version}</Eyebrow>
                  <ArtifactContent artifact={latest} />
                </section>
              ) : null}
              {editing ? (
                <MeetingOutputEditor
                  key={`editor:${artifact.version}`}
                  artifact={artifact}
                  headVersion={data.headVersion}
                  onClose={() => setEditing(false)}
                  onSaved={(version) => {
                    update((current) => ({ ...current, pinnedArtifact: undefined }));
                    setSelected(version);
                    setEditing(false);
                  }}
                />
              ) : null}
              <SectionHead number="02" title="Suggested Tasks" rule />
              <p className="jds-hint">
                Review each suggestion before accepting. Accepted Tasks are managed in Tasks;
                regeneration does not edit them.
              </p>
              {data.candidates
                .filter(
                  (item) =>
                    item.artifactVersion === artifact.version ||
                    item.reviewState === "accepted" ||
                    artifact.content.actions.some(
                      (action) => JSON.stringify(action) === JSON.stringify(item.proposal)
                    )
                )
                .map((candidate) => (
                  <MeetingCandidateSource
                    key={candidate.id}
                    candidate={candidate}
                    artifact={data.artifacts.find(
                      (item) => item.version === candidate.artifactVersion
                    )}
                  />
                ))}
              <MeetingVaultExport
                key={`export:${artifact.version}`}
                meetingId={meeting.id}
                version={artifact.version}
              />
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
