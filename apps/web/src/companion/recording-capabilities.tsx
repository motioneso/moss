import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Note } from "@moss/ui";
import { decideRecordingCapability } from "./recording-capability-client.js";
import { requestJson } from "@moss/module-web-sdk";

import type { RecordingCapabilitiesResponse, DecideRecordingCapabilityInput } from "@moss/shared";

const key = ["companion", "recording-capabilities"] as const;
export const RECORDING_CAPABILITY_DISCLOSURE =
  "Use this Mac for Meetings when you choose Start. Only your selected microphone and app or computer audio are sent to your configured transcription service. Backtrack keeps its separate consent and buffer settings.";
export function RecordingCapabilities() {
  const client = useQueryClient();
  const connections = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      requestJson<RecordingCapabilitiesResponse>("/api/companion/recording-capabilities", {
        signal
      }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.devices.some((device) => device.state !== "approved" || device.pending)
        ? 10000
        : false,
    refetchIntervalInBackground: false
  });
  const decide = useMutation({
    mutationFn: async (input: DecideRecordingCapabilityInput) => {
      const identity = client.getQueryCache().find({ queryKey: key, exact: true });
      const result = await decideRecordingCapability(
        input,
        () => identity === client.getQueryCache().find({ queryKey: key, exact: true })
      );
      return { result, identity };
    },
    onSuccess: ({ identity }) => {
      if (identity !== client.getQueryCache().find({ queryKey: key, exact: true })) return;
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ["meetings", "capture-devices"] });
    }
  });
  if (connections.isError)
    return (
      <p role="status" className="jds-hint">
        Couldn’t check recording access.{" "}
        <Button variant="link" onClick={() => void connections.refetch()}>
          Retry connection status
        </Button>
      </p>
    );
  return (
    <>
      {connections.data?.devices.map((device) => (
        <div key={device.deviceId} className="page-stack">
          <span className="jds-label">
            {device.deviceName} ·{" "}
            {device.state === "approved"
              ? "Meeting recording enabled"
              : "Recording access needs an update"}
          </span>
          {device.state !== "approved" && !device.pending ? (
            <p className="jds-hint">
              Open Trail Marker on this Mac and update its connection. Approve the one-time
              recording access here. Connecting never starts a meeting.
            </p>
          ) : null}
          {device.pending && Date.parse(device.pending.expiresAt) > Date.now() ? (
            <Note variant="practical">
              <div className="page-stack">
                <p>{RECORDING_CAPABILITY_DISCLOSURE}</p>
                <p className="jds-hint">
                  Approve only if you requested this connection update on {device.deviceName}.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                  <Button
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        attemptId: device.pending!.attemptId,
                        decision: "approve",
                        policyVersion: device.pending!.policyVersion
                      })
                    }
                  >
                    Enable meeting recording
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        attemptId: device.pending!.attemptId,
                        decision: "deny",
                        policyVersion: device.pending!.policyVersion
                      })
                    }
                  >
                    Decline
                  </Button>
                </div>
              </div>
            </Note>
          ) : null}
        </div>
      ))}
      {decide.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t confirm the connection update. Refresh its status and try again.
        </p>
      ) : null}
    </>
  );
}
