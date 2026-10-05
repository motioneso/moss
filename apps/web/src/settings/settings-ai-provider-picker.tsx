import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";

import { Button } from "@moss/ui";
import {
  cloudflareDecisionBaseUrl,
  decisionModelDialect,
  isCloudflareAccountId,
  isTypesafeDecisionBaseUrl,
  type AiProviderConfigDto
} from "@moss/shared";

import { createAiProvider } from "../api/client";
import { useAssistantName } from "../api/use-assistant-name.js";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Field } from "./settings-ui";
import { CREDENTIAL_EXAMPLES, PROVIDER_CATALOG } from "./settings-ai-provider-catalog";

/**
 * #3057: which catalog entry is already present. A decision-model entry is matched by its address,
 * not its label, because all three presets share the `system-one` kind. "Any compatible service" is
 * never considered added, so a second compatible service can always be added.
 */
function catalogEntryIsAdded(
  option: (typeof PROVIDER_CATALOG)[number],
  providers: readonly AiProviderConfigDto[]
): boolean {
  if (option.acpAgentId !== undefined) {
    return providers.some(
      (provider) => provider.authMethod === "cli" && provider.acpAgentId === option.acpAgentId
    );
  }
  if (option.preset === "cloudflare") {
    return providers.some(
      (provider) =>
        provider.providerKind === "system-one" &&
        decisionModelDialect(provider.baseUrl) === "cloudflare"
    );
  }
  if (option.preset === "typesafe") {
    return providers.some(
      (provider) =>
        provider.providerKind === "system-one" && isTypesafeDecisionBaseUrl(provider.baseUrl)
    );
  }
  if (option.preset === "compatible") return false;
  return providers.some((provider) => provider.displayName === option.label);
}

/**
 * The "Add provider" panel: a catalog grid, then the credential form for the chosen entry. It owns
 * the field state and the create request; the caller owns the open/closed toggle and refresh.
 */
export function ProviderAddPanel(props: {
  readonly providers: readonly AiProviderConfigDto[];
  readonly onAdded: (label: string) => void;
}) {
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const [credentialFor, setCredentialFor] = useState<(typeof PROVIDER_CATALOG)[number] | null>(
    null
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");

  const createMutation = useMutation({
    mutationFn: (input: {
      option: (typeof PROVIDER_CATALOG)[number];
      baseUrl: string;
      apiKey: string;
    }) =>
      createAiProvider({
        providerKind: input.option.kind,
        displayName: input.option.label,
        authMethod: input.option.authMethod,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.option.acpAgentId ? { acpAgentId: input.option.acpAgentId } : {}),
        ...(input.apiKey ? { credentialPayload: { apiKey: input.apiKey } } : {})
      }),
    onSuccess: (_data, input) => {
      setCredentialFor(null);
      setBaseUrl("");
      setApiKey("");
      setAccountId("");
      props.onAdded(input.option.label);
    },
    onError: (error) => toast(readError(error), { tone: "drift", icon: <X size={17} /> })
  });

  const isCloudflarePreset = credentialFor?.preset === "cloudflare";
  const isCompatiblePreset = credentialFor?.preset === "compatible";
  const canAddCredential = isCloudflarePreset
    ? isCloudflareAccountId(accountId.trim()) && apiKey.trim() !== ""
    : isCompatiblePreset
      ? baseUrl.trim() !== "" && apiKey.trim() !== ""
      : apiKey.trim() !== "";

  return (
    <div className="provpick">
      <div className="provpick__hd">
        {credentialFor ? `${credentialFor.label} credentials` : "Add a provider"}
      </div>
      {credentialFor ? (
        <>
          {isCloudflarePreset ? (
            <>
              <Field label="Account ID" hint="On the Cloudflare dashboard, top right of Overview.">
                <input
                  className="jds-input"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="0123456789abcdef0123456789abcdef"
                  aria-label="Account ID"
                />
              </Field>
              <Field label="API token" hint='Use the "Workers AI" template. Stored encrypted.'>
                <input
                  className="jds-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Cloudflare API token"
                  aria-label="API token"
                />
              </Field>
            </>
          ) : isCompatiblePreset ? (
            <>
              <Field
                label="Address"
                hint="A service that speaks the System One API, such as OpenRouter or your own server."
              >
                <input
                  className="jds-input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://openrouter.ai/api/v1"
                  aria-label="Address"
                />
              </Field>
              <Field label="API key" hint="Stored encrypted. Never shown in briefings or logs.">
                <input
                  className="jds-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Your API key"
                  aria-label="API key"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Base URL" hint="Leave blank to use the provider's default endpoint.">
                <input
                  className="jds-input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={CREDENTIAL_EXAMPLES[credentialFor.kind].baseUrl}
                  aria-label="Base URL"
                />
              </Field>
              <Field label="API key" hint="Stored encrypted. Never shown in briefings or logs.">
                <input
                  className="jds-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={CREDENTIAL_EXAMPLES[credentialFor.kind].apiKey}
                  aria-label="API key"
                />
              </Field>
            </>
          )}
          <div className="provpick__cred-acts">
            <Button
              variant="secondary"
              size="sm"
              disabled={!canAddCredential}
              onClick={() =>
                createMutation.mutate({
                  option: credentialFor,
                  baseUrl: isCloudflarePreset
                    ? cloudflareDecisionBaseUrl(accountId.trim())
                    : baseUrl.trim(),
                  apiKey: apiKey.trim()
                })
              }
            >
              Add
            </Button>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                setCredentialFor(null);
                setBaseUrl("");
                setApiKey("");
                setAccountId("");
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="provpick__grid">
            {PROVIDER_CATALOG.map((option) => {
              const has = catalogEntryIsAdded(option, props.providers);
              return (
                <button
                  key={option.label}
                  type="button"
                  className="provpick__item"
                  disabled={has}
                  onClick={() =>
                    option.authMethod === "cli"
                      ? createMutation.mutate({ option, baseUrl: "", apiKey: "" })
                      : setCredentialFor(option)
                  }
                >
                  <span className="provpick__dot" />
                  {option.label}
                  {has ? <span className="provpick__on">Added</span> : null}
                </button>
              );
            })}
          </div>
          <div className="provpick__foot">
            {assistantName} reads the available models from the provider automatically when it
            connects.
          </div>
        </>
      )}
    </div>
  );
}
