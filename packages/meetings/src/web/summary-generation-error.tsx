import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { requestJson } from "@moss/module-web-sdk";
import type { MeResponse } from "@moss/shared";

/** Only known failure codes become recovery copy; never display provider error text. */
export function summaryGenerationFailure(code?: string): {
  readonly status: "failed";
  readonly message: string;
  readonly remediation?: "ai-providers" | "ai-settings";
} {
  switch (code) {
    case "meeting_output_queue_unavailable":
      return {
        status: "failed",
        message: "Recording stopped, but the summary couldn’t be queued."
      };
    case "meeting_output_interrupted":
      return {
        status: "failed",
        message: "The automatic summary was interrupted. Your transcript and notes are kept."
      };
    case "meeting_output_subscription_unsupported":
      return {
        status: "failed",
        message: "Summaries on this subscription aren’t supported yet. No other model was used."
      };
    case "meeting_output_subscription_isolation_unavailable":
      return {
        status: "failed",
        message:
          "Subscription summaries aren’t available on this server setup. No other model was used."
      };
    case "meeting_output_claude_subscription_unsupported":
      return {
        status: "failed",
        message:
          "Summaries on this Claude subscription aren’t supported yet. No other model was used."
      };
    case "meeting_output_isolation_failed":
      return {
        status: "failed",
        message:
          "Moss couldn’t write this summary because Claude didn’t accept the settings that keep your meeting private. Your transcript and notes are kept; try Rewrite summary later.",
        remediation: "ai-settings"
      };
    case "meeting_output_runner_offline":
      return {
        status: "failed",
        message:
          "Moss couldn’t write this summary because it couldn’t reach Claude. Your transcript and notes are kept; try Rewrite summary once it’s back.",
        remediation: "ai-settings"
      };
    case "meeting_output_route_unavailable":
      return {
        status: "failed",
        message:
          "Moss couldn’t write this summary because no AI is chosen for summaries yet. Your transcript and notes are kept; try Rewrite summary after one is chosen.",
        remediation: "ai-settings"
      };
    case "meeting_output_provider_failed":
      return {
        status: "failed",
        message:
          "Your model couldn’t complete the summary. Check its connection and try again. No other model was used.",
        remediation: "ai-providers"
      };
    case "meeting_output_timed_out":
      return {
        status: "failed",
        message: "The summary took too long and was stopped. Try again when you’re ready."
      };
    case "meeting_output_route_changed":
      return {
        status: "failed",
        message:
          "The summary model configuration changed during generation. Review it before generating again.",
        remediation: "ai-providers"
      };
    default:
      return {
        status: "failed",
        message:
          "The summary could not be generated. Try again when you’re ready. No other model was used."
      };
  }
}

/** Codes whose message already ends with the Rewrite summary pointer. */
export const SELF_CONTAINED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "meeting_output_isolation_failed",
  "meeting_output_runner_offline",
  "meeting_output_route_unavailable"
]);

/** Admins get the settings link; members are told to ask an admin. */
export function SummaryAiSettingsHint() {
  const me = useQuery({
    queryKey: ["meetings", "summary-settings-access"],
    queryFn: ({ signal }) => requestJson<MeResponse>("/api/me", { signal }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: "always"
  });
  const admin = me.isSuccess && !me.isFetching && me.data.user.isInstanceAdmin;
  return (
    <p className="jds-hint">
      {admin ? (
        <>
          Check your AI settings in{" "}
          <Link to="/settings?section=aiproviders">Settings → AI providers</Link>.
        </>
      ) : (
        "Ask an admin to check the AI settings."
      )}
    </p>
  );
}

export function SummaryModelRecovery() {
  const me = useQuery({
    queryKey: ["meetings", "summary-settings-access"],
    queryFn: ({ signal }) => requestJson<MeResponse>("/api/me", { signal }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: "always"
  });
  const admin = me.isSuccess && !me.isFetching && me.data.user.isInstanceAdmin;
  return (
    <p className="jds-hint">
      {admin ? (
        <>
          Check your default model in{" "}
          <Link to="/settings?section=aiproviders">Settings → AI providers</Link>.
        </>
      ) : (
        "Contact an instance admin to check your default model."
      )}{" "}
      Refresh summaries after the configuration is updated, then generate again.
    </p>
  );
}
