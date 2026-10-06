import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type { MeetingRecordingNoticeStatus } from "@moss/shared";
import { useSessionDraft } from "./session-draft.js";

export const recordingNoticeKey = ["meetings", "recording-notice"] as const;
const acknowledgementKey = ["meetings", "recording-notice-save"] as const;
interface NoticeSave {
  readonly requestKey: string | null;
  readonly error: string | null;
}
export function isRecordingNoticeAcknowledged(client: QueryClient): boolean {
  const query = client.getQueryState<MeetingRecordingNoticeStatus>(recordingNoticeKey);
  return (
    query?.status === "success" &&
    !!query.data?.acknowledgement &&
    query.data.acknowledgement.policyVersion === query.data.currentNotice.policyVersion
  );
}
/** A server rejection invalidates advisory browser readiness; only the server authorizes capture. */
export function refreshRecordingNotice(client: QueryClient) {
  client.setQueryData<MeetingRecordingNoticeStatus>(recordingNoticeKey, (current) =>
    current ? { ...current, acknowledgement: null } : undefined
  );
  void client.invalidateQueries({ queryKey: recordingNoticeKey, exact: true });
}
export function useRecordingNotice() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: recordingNoticeKey,
    queryFn: ({ signal }) =>
      requestJson<MeetingRecordingNoticeStatus>("/api/meetings/recording-notice", { signal }),
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: true
  });
  const save = useSessionDraft<NoticeSave>(acknowledgementKey, () => ({
    requestKey: null,
    error: null
  }));
  async function acknowledge(policyVersion: string) {
    const current = client.getQueryData<NoticeSave>(acknowledgementKey);
    const notice = client.getQueryData<MeetingRecordingNoticeStatus>(recordingNoticeKey);
    if (!current || current.requestKey || !notice || query.isError || query.isPending) return;
    if (notice.currentNotice.policyVersion !== policyVersion) {
      save.update(() => ({
        requestKey: null,
        error: "The recording notice changed. Review the latest text before acknowledging it."
      }));
      void query.refetch();
      return;
    }
    const requestKey = randomUuid();
    const noticeIdentity = client
      .getQueryCache()
      .find({ queryKey: recordingNoticeKey, exact: true });
    save.update(() => ({ requestKey, error: null }));
    const currentRequest = () =>
      save.currentSession() &&
      client.getQueryCache().find({ queryKey: recordingNoticeKey, exact: true }) ===
        noticeIdentity &&
      client.getQueryData<NoticeSave>(acknowledgementKey)?.requestKey === requestKey;
    try {
      const status = await requestJson<MeetingRecordingNoticeStatus>(
        "/api/meetings/recording-notice",
        {
          method: "PUT",
          body: { policyVersion }
        }
      );
      if (!currentRequest()) return;
      if (
        client.getQueryData<MeetingRecordingNoticeStatus>(recordingNoticeKey)?.currentNotice
          .policyVersion !== policyVersion
      ) {
        save.update(() => ({
          requestKey: null,
          error: "The recording notice changed. Review the latest text before acknowledging it."
        }));
        void query.refetch();
        return;
      }
      // A GET begun before the write can still carry the old null acknowledgement.
      // Cancel its cache update before installing the receipt, then read current policy anew.
      await client.cancelQueries({ queryKey: recordingNoticeKey, exact: true });
      if (!currentRequest()) return;
      if (
        client.getQueryData<MeetingRecordingNoticeStatus>(recordingNoticeKey)?.currentNotice
          .policyVersion !== policyVersion
      ) {
        save.update(() => ({
          requestKey: null,
          error: "The recording notice changed. Review the latest text before acknowledging it."
        }));
        void query.refetch();
        return;
      }
      client.setQueryData(recordingNoticeKey, status);
      save.update(() => ({ requestKey: null, error: null }));
      void client.invalidateQueries({ queryKey: recordingNoticeKey, exact: true });
    } catch {
      if (!currentRequest()) return;
      save.update(() => ({
        requestKey: null,
        error: "Couldn’t save the recording notice. Check the latest notice and try again."
      }));
      refreshRecordingNotice(client);
    }
  }
  return {
    query,
    acknowledged: isRecordingNoticeAcknowledged(client),
    saving: save.data.requestKey !== null,
    error: save.data.error,
    acknowledge
  };
}
