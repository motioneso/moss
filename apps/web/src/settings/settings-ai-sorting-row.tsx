import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, MinusCircle } from "lucide-react";
import { useRef, useState } from "react";

import { Badge, Button, InfoTip } from "@moss/ui";
import {
  CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY,
  CLASSIFIER_GATE_MODE_DEFAULT,
  CLASSIFIER_GATE_MODES,
  SORTING_SERVICE_KEY,
  isSortingBindableProviderKind,
  type AiConfiguredModelDto,
  type AiProviderConfigDto,
  type AiServiceBinding,
  type ClassifierGateMode
} from "@moss/shared";
import { isTypesafeDecisionBaseUrl } from "@moss/shared";

import {
  deleteAiServiceBinding,
  getAdminRuntimeConfig,
  putAdminRuntimeConfig,
  putAiServiceBinding
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useChatControls } from "../shell/chat-controls-context";
import { DecisionModelDialog } from "./settings-ai-decision-dialog";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";

export const SORTING_DISCLOSURE =
  "Story details, your saved story preferences, and each email's subject, sender, dates and " +
  "text go to this model first, and to your main model if it does not answer. Each may charge " +
  "for the request.";

export const TRAIL_MARKER_DISCLOSURE = "Trail Marker's app and window titles also go here.";

export const SYSTEM_ONE_SORTING_NOTE =
  "Trail Marker's app and window titles go to TypeSafe. It also answers News, Sports and email " +
  "sorting questions with a yes or no, so each email's subject, sender, dates and text go there " +
  "too. Your main model still handles other sorting work.";

/**
 * #3057: the same disclosure for a decision model that is not TypeSafe (Cloudflare's Clef, or a
 * compatible service). It names the provider the admin actually chose.
 */
export function decisionModelSortingNote(providerName: string): string {
  return (
    `Trail Marker's app and window titles go to ${providerName}. It also answers News, Sports ` +
    "and email sorting questions with a yes or no, so each email's subject, sender, dates and " +
    "text go there too. Your main model still handles other sorting work."
  );
}

// Task 1.3 (#2892), approving mockup docs/superpowers/mockups/classifier-gate/settings-row.html.
// Ruling 1 (Ben, 2026-10-01): the admin-wide switch must say plainly that when the gate is on,
// every user's eligible messages reach the classifier provider.
export const CLASSIFIER_API_DISCLOSURE =
  "API model: eligible chat messages also go to its provider. When the gate is on, every " +
  "user's eligible messages go to that provider.";

// The same ruling, shown in the Use in chat help and asserted by the unit test.
export const CLASSIFIER_GATE_ON_NOTE =
  "When Use in chat is on, every user's eligible messages go to the decision model's provider.";

export const CLASSIFIER_HEADING = "Decision model";
export const CLASSIFIER_HELP =
  "Optional. A separate model for quick sorting and checking jobs. Moss never picks one for you.";

/** Neutral starting draft for "Ask Moss to help". It names no model and no provider. */
export const DECISION_MODEL_HELP_DRAFT =
  "I want to choose a decision model for this instance. Explain what it does, what the Use in chat setting changes, and what I should think about. Do not pick or recommend a model for me.";

const CLASSIFIER_TIP =
  "A decision model picks a tool and fills in simple values for quick chat requests, so they skip your default " +
  "model. Also used for yes/no and pick-one questions in the background.";

const GATE_TIP = (
  <>
    Lets the decision model answer quick chat requests before your default model sees them.
    <ul style={{ margin: "var(--space-2) 0 0", paddingLeft: "var(--space-4)" }}>
      <li>
        <b>Off</b>: not used.
      </li>
      <li>
        <b>Watch only</b>: it guesses and logs, but your default model still answers.
      </li>
      <li>
        <b>On</b>: it answers requests it is sure about.
      </li>
    </ul>
    <p style={{ margin: "var(--space-2) 0 0" }}>{CLASSIFIER_GATE_ON_NOTE}</p>
  </>
);

// Models the Classifier may be: the model and its provider are active, it has the json
// capability, and its provider kind is one generateStructured executes, or System One, which
// answers the sorting questions as choices. The save route applies this same rule.
function eligibleSortingModels(models: readonly AiConfiguredModelDto[]): AiConfiguredModelDto[] {
  return models.filter(
    (model) =>
      model.status === "active" &&
      model.providerStatus === "active" &&
      isSortingBindableProviderKind(model.providerKind) &&
      model.capabilities.includes("json")
  );
}

function readGateMode(value: string | null | undefined): ClassifierGateMode {
  return value && (CLASSIFIER_GATE_MODES as readonly string[]).includes(value)
    ? (value as ClassifierGateMode)
    : CLASSIFIER_GATE_MODE_DEFAULT;
}

export function SortingModelRow(props: {
  readonly binding: AiServiceBinding | undefined;
  readonly models: readonly AiConfiguredModelDto[];
  readonly providers: readonly AiProviderConfigDto[];
}) {
  const { toast } = useFeedback();
  const { openAssistantWithDraft } = useChatControls();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: (modelId: string | null) =>
      modelId
        ? putAiServiceBinding(SORTING_SERVICE_KEY, { binding: { kind: "model", modelId } })
        : deleteAiServiceBinding(SORTING_SERVICE_KEY),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.serviceBindings });
      toast("Service updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const gateQuery = useQuery({
    queryKey: queryKeys.settings.adminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY),
    queryFn: () => getAdminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY),
    retry: false
  });
  const savedGateMode = readGateMode(gateQuery.data?.config.value);
  const gateMutation = useMutation({
    mutationFn: (mode: ClassifierGateMode) =>
      putAdminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY, mode),
    onSuccess: (data) => {
      queryClient.setQueryData(
        queryKeys.settings.adminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY),
        data
      );
      toast("Use in chat updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const eligible = eligibleSortingModels(props.models);
  const boundId = props.binding?.kind === "model" ? props.binding.modelId : null;
  const bound = boundId ? (eligible.find((model) => model.id === boundId) ?? null) : null;
  const boundProvider = bound
    ? (props.providers.find((provider) => provider.id === bound.providerConfigId) ?? null)
    : null;
  const boundIsTypeSafe =
    bound?.providerKind === "system-one" &&
    isTypesafeDecisionBaseUrl(boundProvider?.baseUrl ?? null);
  // The Shadow badge links to the report. The Shadow switch option only changes the mode.
  const shadowReportHref = "/settings?section=shadowreport";
  const badge =
    savedGateMode === "shadow" ? (
      <a href={shadowReportHref} aria-label="See watch-only results">
        <Badge tone="amber">Watch only</Badge>
      </a>
    ) : savedGateMode === "on" ? (
      <Badge tone="forest">On</Badge>
    ) : null;
  // The approved disclosure covers the chosen classifier taking eligible chat messages. Every
  // bindable classifier kind is a hosted provider, so it shows whenever a model is bound and the
  // gate is Shadow or On (the mockup's `api` pattern).
  const showApiDisclosure = bound != null && savedGateMode !== "off";

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">
          {CLASSIFIER_HEADING} {badge}{" "}
          <InfoTip label="What the decision model does">{CLASSIFIER_TIP}</InfoTip>
        </div>
        <div className="rt__desc">{CLASSIFIER_HELP}</div>
        {bound?.providerKind === "system-one" ? (
          <div className="rt__desc">
            {boundIsTypeSafe
              ? SYSTEM_ONE_SORTING_NOTE
              : decisionModelSortingNote(bound.providerDisplayName)}
          </div>
        ) : boundId ? (
          <div className="rt__desc">
            {SORTING_DISCLOSURE} {TRAIL_MARKER_DISCLOSURE}
          </div>
        ) : null}
        {showApiDisclosure ? <div className="rt__desc">{CLASSIFIER_API_DISCLOSURE}</div> : null}
      </div>
      <div className="rt__pick">
        <div className="rt__none">
          {bound ? (
            <>
              {bound.displayName} <span className="rt__desc">{bound.providerDisplayName}</span>
            </>
          ) : (
            "Not chosen"
          )}
        </div>
        {boundId && !bound ? (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            Chosen model is unavailable. Using your main model.
          </span>
        ) : null}
        <Button
          ref={chooseButtonRef}
          variant="secondary"
          disabled={mutation.isPending || gateQuery.isPending}
          onClick={() => setDialogOpen(true)}
        >
          {bound ? "Change model" : "Choose a model"}
        </Button>
        {boundId ? (
          <Button
            variant="link"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(null)}
          >
            Use main model
          </Button>
        ) : null}
        <Button variant="link" onClick={() => openAssistantWithDraft(DECISION_MODEL_HELP_DRAFT)}>
          Ask Moss to help
        </Button>
      </div>
      {dialogOpen ? (
        <DecisionModelDialog
          models={eligible}
          initialModelId={bound ? bound.id : null}
          initialGateMode={savedGateMode}
          gateTip={GATE_TIP}
          saving={mutation.isPending || gateMutation.isPending}
          returnFocusRef={chooseButtonRef}
          onClose={() => setDialogOpen(false)}
          onAskMoss={() => {
            setDialogOpen(false);
            openAssistantWithDraft(DECISION_MODEL_HELP_DRAFT);
          }}
          onSave={(modelId, mode) => {
            void (async () => {
              try {
                if (modelId !== boundId) await mutation.mutateAsync(modelId);
                if (mode !== savedGateMode) await gateMutation.mutateAsync(mode);
                setDialogOpen(false);
              } catch {
                // The mutation already showed the error.
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}
