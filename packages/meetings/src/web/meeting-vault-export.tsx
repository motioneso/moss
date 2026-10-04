import { useQuery } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import { Button, Note, SectionHead } from "@moss/ui";
import type { ExportMeetingOutputInput, MeetingExportReceipt } from "@moss/shared";
import { exportMeetingOutput, getMeetingExports } from "./output-client.js";
import { operationError, useOutputSession, type OutputOperation } from "./output-session.js";

interface ExportState {
  readonly receipt?: MeetingExportReceipt;
  readonly operation?: OutputOperation<ExportMeetingOutputInput>;
}
export function exportStatus(receipt: MeetingExportReceipt): string {
  if (receipt.writeStatus === "conflict" || receipt.errorCode === "meeting_vault_conflict")
    return "The saved note was changed or removed. It has not been overwritten. Save a new summary version instead.";
  if (receipt.writeStatus === "failed") return "The private note could not be saved.";
  if (receipt.writeStatus === "pending") return "The private note write is pending.";
  if (receipt.indexStatus === "queued")
    return "Saved to Moss private vault. Search indexing queued.";
  if (receipt.indexStatus === "delayed")
    return "Saved to Moss private vault. Search indexing delayed; retry to request indexing again.";
  if (receipt.indexStatus === "conflict")
    return "Saved to Moss private vault. Search indexing needs review.";
  return "Saved to Moss private vault. Search indexing not requested.";
}
export function MeetingVaultExport({
  meetingId,
  version
}: {
  readonly meetingId: string;
  readonly version: number;
}) {
  const session = useOutputSession<ExportState>(meetingId, `export:${version}`, () => ({}));
  const { state, update } = session;
  const receipts = useQuery({
    queryKey: ["meetings", "exports", meetingId],
    queryFn: async ({ signal }) => {
      try {
        return await getMeetingExports(meetingId, signal);
      } catch (error) {
        session.deny(error);
        throw error;
      }
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  if (state === undefined || session.denied)
    return (
      <p role="status" className="jds-hint">
        Summary access is unavailable. Return to history or sign in again.
      </p>
    );
  const receipt =
    state.receipt ?? receipts.data?.receipts.find((item) => item.artifactVersion === version);
  const busy = state.operation?.status === "running";
  const conflict =
    receipt?.writeStatus === "conflict" || receipt?.errorCode === "meeting_vault_conflict";
  async function save() {
    if (busy || !session.authorized()) return;
    // Unknown transport outcome retries the same command. A known partial receipt needs
    // a new command key so the server can safely reconcile the same immutable content.
    const input =
      state.operation?.status === "retry"
        ? state.operation.input
        : { requestKey: randomUuid(), artifactVersion: version };
    update((current) => ({
      ...current,
      operation: { input, status: "running", message: "Saving private copy…" }
    }));
    try {
      const { receipt } = await exportMeetingOutput(meetingId, input);
      if (!session.authorized()) return;
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : {
              ...current,
              receipt,
              operation: { input, status: "done", message: exportStatus(receipt) }
            }
      );
    } catch (error) {
      if (session.deny(error) || !session.authorized()) return;
      const failure =
        error instanceof ApiError && error.status === 409
          ? {
              status: "failed" as const,
              message:
                "The saved note was changed or removed. It has not been overwritten. Save a new summary version instead."
            }
          : operationError(error);
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : { ...current, operation: { input, ...failure } }
      );
    }
  }
  return (
    <section className="meetings-section" aria-label="Save to vault">
      <SectionHead number="03" title="Save to vault" rule />
      <Note variant="practical">
        Save version {version} as a new private note in Moss private vault. Later summary versions
        create separate notes.
      </Note>
      <Button disabled={busy || conflict} onClick={() => void save()}>
        {state.operation?.status === "retry"
          ? "Retry save"
          : receipt
            ? "Retry private save"
            : "Save new private version"}
      </Button>
      {state.operation ? (
        <p role="status" className="jds-hint">
          {state.operation.message}
        </p>
      ) : receipt ? (
        <p role="status" className="jds-hint">
          {exportStatus(receipt)}
        </p>
      ) : null}
      {receipts.isError ? (
        <p role="status" className="jds-hint">
          Couldn’t check earlier vault saves. Retry the private save to reconcile this version.
        </p>
      ) : null}
      {receipt?.noteReference ? (
        <details>
          <summary>Saved file details</summary>
          <p className="jds-hint">{receipt.noteReference}</p>
        </details>
      ) : null}
    </section>
  );
}
