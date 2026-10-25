import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";

import { Button, Dialog, RadioCardGroup, SectionHead } from "@moss/ui";
import {
  cloudflareDecisionBaseUrl,
  isCloudflareAccountId,
  type AiProviderConfigDto
} from "@moss/shared";

import { createAiProvider } from "../api/client";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Field } from "./settings-ui";
import {
  CREDENTIAL_EXAMPLES,
  PROVIDER_CATALOG,
  PROVIDER_GROUPS,
  SUBSCRIPTION_TAKEN_NOTE,
  nextFreeName,
  subscriptionChoiceTaken,
  type ProviderChoice
} from "./settings-ai-provider-catalog";

/**
 * The Add provider dialog, in two steps. Choose picks what to connect, Connect names it and asks
 * for only the fields that choice needs. The caller owns open/closed and the refresh after adding.
 */
export function AddProviderDialog(props: {
  readonly providers: readonly AiProviderConfigDto[];
  readonly onClose: () => void;
  readonly onAdded: (provider: AiProviderConfigDto, choice: ProviderChoice) => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { toast } = useFeedback();
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [step, setStep] = useState<"choose" | "connect">("choose");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();

  const choice = PROVIDER_CATALOG.find((entry) => entry.id === choiceId) ?? null;
  const existingNames = props.providers.map((provider) => provider.displayName);

  // Focus lands on the first choice you can pick, resolved when the dialog opens.
  const firstChoiceRef = {
    get current() {
      return (
        bodyRef.current?.querySelector<HTMLElement>("input[type=radio]:not(:disabled)") ?? null
      );
    }
  } as RefObject<HTMLElement | null>;

  const createMutation = useMutation({
    mutationFn: (input: {
      choice: ProviderChoice;
      name: string;
      baseUrl: string;
      apiKey: string;
    }) =>
      createAiProvider({
        providerKind: input.choice.kind,
        displayName: input.name,
        authMethod: input.choice.authMethod,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.choice.acpAgentId ? { acpAgentId: input.choice.acpAgentId } : {}),
        ...(input.apiKey ? { credentialPayload: { apiKey: input.apiKey } } : {})
      }),
    onSuccess: ({ provider }, input) => props.onAdded(provider, input.choice),
    onError: (error) => toast(readError(error), { tone: "drift", icon: <X size={17} /> })
  });

  const isSubscription = choice?.authMethod === "cli";
  const isCloudflare = choice?.preset === "cloudflare";
  const isCompatible = choice?.preset === "compatible";
  const fieldsValid = isSubscription
    ? true
    : isCloudflare
      ? isCloudflareAccountId(accountId.trim()) && apiKey.trim() !== ""
      : isCompatible
        ? baseUrl.trim() !== "" && apiKey.trim() !== ""
        : apiKey.trim() !== "";
  const canAdd = choice !== null && name.trim() !== "" && fieldsValid;

  const choose = (id: string) => setChoiceId(id);
  const next = () => {
    if (!choice) return;
    setName(nextFreeName(choice.label, existingNames));
    setStep("connect");
  };
  const back = () => {
    setStep("choose");
    setBaseUrl("");
    setApiKey("");
    setAccountId("");
  };

  const footer =
    step === "choose" ? (
      <>
        <Button variant="quiet" onClick={props.onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={choice === null} onClick={next}>
          Next
        </Button>
      </>
    ) : (
      <>
        <Button variant="quiet" onClick={back}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={!canAdd || createMutation.isPending}
          onClick={() =>
            choice &&
            createMutation.mutate({
              choice,
              name: name.trim(),
              baseUrl: isCloudflare ? cloudflareDecisionBaseUrl(accountId.trim()) : baseUrl.trim(),
              apiKey: apiKey.trim()
            })
          }
        >
          {createMutation.isPending ? "Adding" : isSubscription ? "Add and sign in" : "Add"}
        </Button>
      </>
    );

  return (
    <Dialog
      className="provdlg"
      title={step === "choose" ? "Add a provider" : `Connect ${choice?.label ?? ""}`}
      onClose={props.onClose}
      closeLabel="Close"
      initialFocusRef={step === "choose" ? firstChoiceRef : undefined}
      returnFocusRef={props.returnFocusRef}
      footer={footer}
    >
      <div ref={bodyRef} className="provdlg__body">
        {step === "choose" ? (
          PROVIDER_GROUPS.map((group) => {
            const options = PROVIDER_CATALOG.filter((entry) => entry.group === group.id).map(
              (entry) => {
                const taken = subscriptionChoiceTaken(entry, props.providers);
                return {
                  value: entry.id,
                  label: entry.label,
                  description: taken ? SUBSCRIPTION_TAKEN_NOTE : entry.description,
                  disabled: taken
                };
              }
            );
            const selected = options.some((option) => option.value === choiceId) ? choiceId : null;
            return (
              <section key={group.id} className="provdlg__group">
                <SectionHead title={group.label} titleAs="h3" />
                <RadioCardGroup
                  name="provider-choice"
                  ariaLabel={group.label}
                  value={selected}
                  options={options}
                  onChange={choose}
                />
              </section>
            );
          })
        ) : choice ? (
          <>
            <Field
              label="Name"
              hint="Shown on the card and in model lists."
              controlId={`${fieldId}-name`}
              hintId={`${fieldId}-name-hint`}
            >
              <input
                id={`${fieldId}-name`}
                aria-describedby={`${fieldId}-name-hint`}
                className="jds-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Name"
              />
            </Field>
            {isCloudflare ? (
              <>
                <Field
                  label="Account ID"
                  hint="On the Cloudflare dashboard, top right of Overview."
                  controlId={`${fieldId}-account`}
                  hintId={`${fieldId}-account-hint`}
                >
                  <input
                    id={`${fieldId}-account`}
                    aria-describedby={`${fieldId}-account-hint`}
                    className="jds-input"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="0123456789abcdef0123456789abcdef"
                    aria-label="Account ID"
                  />
                </Field>
                <Field
                  label="API token"
                  hint='Use the "Workers AI" template. Stored encrypted.'
                  controlId={`${fieldId}-token`}
                  hintId={`${fieldId}-token-hint`}
                >
                  <input
                    id={`${fieldId}-token`}
                    aria-describedby={`${fieldId}-token-hint`}
                    className="jds-input"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Cloudflare API token"
                    aria-label="API token"
                  />
                </Field>
              </>
            ) : isSubscription ? null : (
              <>
                <Field
                  label={isCompatible ? "Address" : "Base URL"}
                  controlId={`${fieldId}-address`}
                  hintId={`${fieldId}-address-hint`}
                  hint={
                    isCompatible
                      ? "A decision model service, such as OpenRouter or your own server."
                      : "Leave blank to use the provider's default endpoint."
                  }
                >
                  <input
                    id={`${fieldId}-address`}
                    aria-describedby={`${fieldId}-address-hint`}
                    className="jds-input"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={
                      isCompatible
                        ? "https://openrouter.ai/api"
                        : CREDENTIAL_EXAMPLES[choice.kind].baseUrl
                    }
                    aria-label={isCompatible ? "Address" : "Base URL"}
                  />
                </Field>
                <Field
                  label="API key"
                  hint="Stored encrypted."
                  controlId={`${fieldId}-key`}
                  hintId={`${fieldId}-key-hint`}
                >
                  <input
                    id={`${fieldId}-key`}
                    aria-describedby={`${fieldId}-key-hint`}
                    className="jds-input"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      isCompatible ? "Your API key" : CREDENTIAL_EXAMPLES[choice.kind].apiKey
                    }
                    aria-label="API key"
                  />
                </Field>
              </>
            )}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
