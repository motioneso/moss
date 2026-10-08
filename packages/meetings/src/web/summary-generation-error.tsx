import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { requestJson } from "@moss/module-web-sdk";
import type { MeResponse } from "@moss/shared";

/** Only known failure codes become recovery copy; never display provider error text. */
export function summaryGenerationFailure(code?: string): {
  readonly status: "failed";
  readonly message: string;
  readonly remediation?: "ai-providers";
} {
  switch (code) {
    case "meeting_output_subscription_unsupported":
      return {
        status: "failed",
        message: "Summaries on this subscription aren’t supported yet. No other model was used."
      };
    case "meeting_output_subscription_isolation_unavailable":
      return {
        status: "failed",
        message: "Claude summaries aren’t available on this server setup. No other model was used."
      };
    case "meeting_output_claude_subscription_unsupported":
      return {
        status: "failed",
        message:
          "Summaries on this Claude subscription aren’t supported yet. No other model was used."
      };
    case "meeting_output_route_unavailable":
      return {
        status: "failed",
        message:
          "Your default model is unavailable or cannot produce structured summaries. Check its connection and try again. No other model will be used.",
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
        message: "Generation failed. Review the saved inputs before starting a new request."
      };
  }
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
