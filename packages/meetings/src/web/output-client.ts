import { requestJson } from "@moss/module-web-sdk";
import type {
  EditMeetingOutputInput,
  ExportMeetingOutputInput,
  GenerateMeetingOutputInput,
  MeetingActionCandidate,
  MeetingExportReceipt,
  MeetingOutputArtifact,
  MeetingOutputResult,
  ReviewMeetingActionInput
} from "@moss/shared";

export const outputKeys = {
  list: (id: string) => ["meetings", "outputs", id] as const,
  session: (id: string) => ["meetings", "output-session", id] as const
};
export interface MeetingOutputsResponse {
  readonly artifacts: readonly MeetingOutputArtifact[];
  readonly candidates: readonly MeetingActionCandidate[];
  readonly headVersion: number;
  readonly templates: readonly {
    id: GenerateMeetingOutputInput["templateId"];
    version: number;
    name: string;
  }[];
}
const path = (id: string) => `/api/meetings/records/${encodeURIComponent(id)}`;
export function getMeetingOutputs(
  id: string,
  signal?: AbortSignal
): Promise<MeetingOutputsResponse> {
  return requestJson(`${path(id)}/outputs`, { signal });
}
export function generateMeetingOutput(
  id: string,
  body: GenerateMeetingOutputInput
): Promise<MeetingOutputResult> {
  return requestJson(`${path(id)}/outputs`, { method: "POST", body });
}
export function editMeetingOutput(
  id: string,
  body: EditMeetingOutputInput
): Promise<MeetingOutputArtifact> {
  return requestJson(`${path(id)}/outputs`, { method: "PUT", body });
}
export function reviewMeetingAction(
  id: string,
  candidateId: string,
  body: ReviewMeetingActionInput
): Promise<MeetingActionCandidate> {
  return requestJson(`${path(id)}/actions/${encodeURIComponent(candidateId)}/review`, {
    method: "POST",
    body
  });
}
export function exportMeetingOutput(
  id: string,
  body: ExportMeetingOutputInput
): Promise<{ receipt: MeetingExportReceipt }> {
  return requestJson(`${path(id)}/exports`, { method: "POST", body });
}

export function getMeetingExports(
  id: string,
  signal?: AbortSignal
): Promise<{ receipts: MeetingExportReceipt[] }> {
  return requestJson(`${path(id)}/exports`, { signal });
}

export function getMeetingOutputArtifact(
  id: string,
  version: number,
  signal?: AbortSignal
): Promise<{ artifact: MeetingOutputArtifact }> {
  return requestJson(`${path(id)}/outputs/${version}`, { signal });
}
