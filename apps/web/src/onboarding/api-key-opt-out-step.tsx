import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { getAiSummary } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { FootNote, OptionCard, StepHeader } from "./onboarding-ui";
import { personalize } from "../api/use-assistant-name.js";

export function ApiKeyOptOutStep(props: { readonly onSkipStep: () => void }) {
  // Members run on the shared host subscription (ADR 0007 s4); saving a provider is
  // admin-only, so this step offers no key field. "done" reads the AI module's public summary.
  const summaryQuery = useQuery({
    queryKey: queryKeys.ai.summary,
    queryFn: () => getAiSummary(),
    retry: false
  });
  const done = summaryQuery.data?.summary.hasPersonalAiProvider ?? false;

  return (
    <section className="onb-step" aria-labelledby="member-apikey-title">
      <StepHeader
        titleId="member-apikey-title"
        eyebrow="Step 1 · Your assistant"
        title={personalize("Moss is ready to use.")}
        lede={
          done
            ? "Your account already has its own AI provider. You can manage it in Settings at any time."
            : personalize(
                "Moss runs on a shared server, so there is nothing to install on your computer. You are using the shared setup, with nothing to set up."
              )
        }
      />
      <div className="onb-opts">
        <OptionCard
          selected
          onClick={props.onSkipStep}
          name="Use the shared setup"
          mono="recommended"
          desc={personalize(
            "Run Moss on the shared system. Easiest option, with no setup required."
          )}
        />
      </div>
      <FootNote icon={<Lock size={15} aria-hidden="true" />}>
        You can change this later in Settings. Your conversations remain private.
      </FootNote>
    </section>
  );
}
