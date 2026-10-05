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
    case "meeting_output_route_unavailable":
      return {
        status: "failed",
        message:
          "No supported summary model is available. Summaries need an available API-key model with summarization and structured-output support. CLI models aren’t supported for summaries.",
        remediation: "ai-providers"
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
          Configure an available summary model in{" "}
          <Link to="/settings?section=aiproviders">Settings → AI providers</Link>.
        </>
      ) : (
        "Contact an instance admin to configure an available summary model."
      )}{" "}
      Refresh summaries after the configuration is updated, then generate again.
    </p>
  );
}
