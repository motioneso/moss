import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Lock } from "lucide-react";

import { getAiSummary } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { FootNote, OptionCard, StepHeader } from "./onboarding-ui";
import { personalize } from "../api/use-assistant-name.js";

export function ApiKeyOptOutStep(props: { readonly onSkipStep: () => void }) {
  const [assistant, setAssistant] = useState<"shared" | "personal">("shared");
  // Client-side apiKeyOptOut.done derivation (module isolation): the AI module's own public
  // endpoint is the source of truth — settings/onboarding NEVER reads an AI table directly.
  // "done" means the member has already configured at least one of their own AI providers
  // (i.e. opted IN to a personal key); a member who uses the shared assistant simply skips.
  const summaryQuery = useQuery({
    queryKey: queryKeys.ai.summary,
    queryFn: () => getAiSummary(),
    retry: false
  });
  const done = summaryQuery.data?.summary.hasPersonalAiProvider ?? false;

  return (
    <section className="onb-step" aria-labelledby="member-apikey-title">
      <StepHeader
        eyebrow="Step 1 · Your assistant"
        title={personalize("Moss is ready to use.")}
        lede={
          done
            ? "You have added a custom AI provider. You can manage it in Settings at any time."
            : personalize(
                "Moss runs on a shared server, so there is nothing to install on your computer. If you want to use your own API key to manage your usage limits, you can add it here. Most users do not need to."
              )
        }
      />
      <div className="onb-opts">
        <OptionCard
          selected={assistant === "shared"}
          onClick={() => setAssistant("shared")}
          name="Use the shared setup"
          mono="recommended"
          desc={personalize(
            "Run Moss on the shared system. Easiest option, with no setup required."
          )}
        />
        <OptionCard
          selected={assistant === "personal"}
          onClick={() => setAssistant("personal")}
          name="Add a personal key"
          mono="optional"
          desc="Use your own AI key. Kept secure and private to your account."
        />
      </div>
      {assistant === "personal" ? (
        <div className="onb-keyfield">
          <label className="onb-keyfield__lbl" htmlFor="member-personal-ai-key">
            <span className="ic">
              <KeyRound size={14} aria-hidden="true" />
            </span>
            Personal AI key
          </label>
          <input
            id="member-personal-ai-key"
            type="text"
            placeholder="sk-…  (kept private to you)"
            spellCheck={false}
          />
          <div className="onb-keyfield__hint">
            You can paste your key now or add it later under {"Settings > Assistant"}. This key is
            private.
          </div>
        </div>
      ) : null}
      <FootNote icon={<Lock size={15} aria-hidden="true" />}>
        You can change this later in Settings. In either case, your conversations remain private.
      </FootNote>
    </section>
  );
}
