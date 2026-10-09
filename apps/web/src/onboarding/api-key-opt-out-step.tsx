import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock } from "lucide-react";

import { createAiProvider, getAiSummary } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { FootNote, OptionCard, StepHeader } from "./onboarding-ui";
import { personalize } from "../api/use-assistant-name.js";
import { PROVIDER_CATALOG } from "../settings/settings-ai-provider-catalog";
import { readError } from "../settings/settings-types";

// Key-based providers that need no preset form; the member picks which service the key is for.
const KEY_PROVIDERS = PROVIDER_CATALOG.filter(
  (option) => option.authMethod === "api_key" && option.preset === undefined
);

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
  const queryClient = useQueryClient();
  const [providerLabel, setProviderLabel] = useState(KEY_PROVIDERS[0]?.label ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const saveKey = useMutation({
    mutationFn: () => {
      const option = KEY_PROVIDERS.find((entry) => entry.label === providerLabel);
      if (!option) throw new Error("Choose a provider for this key.");
      return createAiProvider({
        providerKind: option.kind,
        displayName: option.label,
        authMethod: option.authMethod,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        credentialPayload: { apiKey: apiKey.trim() }
      });
    },
    onSuccess: async () => {
      setApiKey("");
      setBaseUrl("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.ai.summary });
    }
  });

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
          <select
            aria-label="Provider for this key"
            value={providerLabel}
            onChange={(event) => setProviderLabel(event.target.value)}
          >
            {KEY_PROVIDERS.map((option) => (
              <option key={option.label} value={option.label}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Service address (optional)"
            placeholder="Service address (optional)"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
          <input
            id="member-personal-ai-key"
            type="password"
            autoComplete="off"
            placeholder="Paste your key (kept private to you)"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            data-testid="member-personal-ai-key-save"
            disabled={apiKey.trim() === "" || saveKey.isPending}
            onClick={() => saveKey.mutate()}
          >
            Save key
          </button>
          {saveKey.isError ? <div role="alert">{readError(saveKey.error)}</div> : null}
          <div className="onb-keyfield__hint">
            You can save your key now or add it later under {"Settings > Assistant"}. This key is
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
