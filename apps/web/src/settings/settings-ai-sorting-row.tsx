import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, MinusCircle } from "lucide-react";

import { Badge, Field, FormLabel, InfoTip, Segmented, Select } from "@moss/ui";
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

import {
  deleteAiServiceBinding,
  getAdminRuntimeConfig,
  putAdminRuntimeConfig,
  putAiServiceBinding
} from "../api/client";
import { queryKeys } from "../api/query-keys";
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

// Task 1.3 (#2892), approving mockup docs/superpowers/mockups/classifier-gate/settings-row.html.
// Ruling 1 (Ben, 2026-10-01): the admin-wide switch must say plainly that when the gate is on,
// every user's eligible messages reach the classifier provider.
export const CLASSIFIER_API_DISCLOSURE =
  "API model: eligible chat messages also go to its provider. When the gate is on, every " +
  "user's eligible messages go to that provider.";

// The same ruling, shown in the Chat gate help and asserted by the unit test.
export const CLASSIFIER_GATE_ON_NOTE =
  "When the gate is on, every user's eligible messages go to the classifier's provider.";

export const CLASSIFIER_HEADING = "Classifier";
export const CLASSIFIER_HELP = "Optional model to handle classification requests.";

const CLASSIFIER_TIP =
  "Picks a tool and fills in simple values for quick chat requests, so they skip your default " +
  "model. Also used for yes/no and pick-one questions in the background.";

const GATE_TIP = (
  <>
    Lets the classifier answer quick chat requests before your default model sees them.
    <ul style={{ margin: "var(--space-2) 0 0", paddingLeft: "var(--space-4)" }}>
      <li>
        <b>Off</b>: not used.
      </li>
      <li>
        <b>Shadow</b>: it guesses and logs, but your default model still answers.
      </li>
      <li>
        <b>On</b>: it answers requests it is sure about.
      </li>
    </ul>
    <p style={{ margin: "var(--space-2) 0 0" }}>{CLASSIFIER_GATE_ON_NOTE}</p>
  </>
);

const GATE_LABELS: Readonly<Record<ClassifierGateMode, string>> = {
  off: "Off",
  shadow: "Shadow",
  on: "On"
};

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
  const queryClient = useQueryClient();
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
  // Ruling: `on` is not usable before the release gate. With no release signal available at this
  // slice, the control stays disabled unless the saved record already reads `on` (written through
  // the admin boundary by the later release step).
  const canChooseOn = savedGateMode === "on";
  const gateMutation = useMutation({
    mutationFn: (mode: ClassifierGateMode) =>
      putAdminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY, mode),
    onSuccess: (data) => {
      queryClient.setQueryData(
        queryKeys.settings.adminRuntimeConfig(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY),
        data
      );
      toast("Classifier gate updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const eligible = eligibleSortingModels(props.models);
  const boundId = props.binding?.kind === "model" ? props.binding.modelId : null;
  const bound = boundId ? (eligible.find((model) => model.id === boundId) ?? null) : null;
  const unavailableName =
    boundId && !bound
      ? (props.models.find((model) => model.id === boundId)?.displayName ?? "Unavailable model")
      : null;
  const groups = new Map<string, AiConfiguredModelDto[]>();
  for (const model of eligible) {
    const list = groups.get(model.providerDisplayName) ?? [];
    list.push(model);
    groups.set(model.providerDisplayName, list);
  }

  const badge =
    savedGateMode === "shadow" ? (
      <Badge tone="amber">Shadow</Badge>
    ) : savedGateMode === "on" ? (
      <Badge tone="forest">On</Badge>
    ) : null;
  // The approved disclosure covers the chosen classifier taking eligible chat messages. Every
  // bindable classifier kind is a hosted provider, so it shows whenever a model is bound and the
  // gate is Shadow or On (the mockup's `api` pattern).
  const showApiDisclosure = bound != null && savedGateMode !== "off";
  // The mockup keeps the gate unusable until a classifier is chosen (chdis/gdis on the no-model
  // and unavailable views).
  const gateDisabled = bound == null;

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">
          {CLASSIFIER_HEADING} {badge}{" "}
          <InfoTip label="What the classifier does">{CLASSIFIER_TIP}</InfoTip>
        </div>
        <div className="rt__desc">{CLASSIFIER_HELP}</div>
        {bound?.providerKind === "system-one" ? (
          <div className="rt__desc">{SYSTEM_ONE_SORTING_NOTE}</div>
        ) : boundId ? (
          <div className="rt__desc">
            {SORTING_DISCLOSURE} {TRAIL_MARKER_DISCLOSURE}
          </div>
        ) : null}
        {showApiDisclosure ? <div className="rt__desc">{CLASSIFIER_API_DISCLOSURE}</div> : null}
      </div>
      <div className="rt__pick">
        <Field>
          <FormLabel htmlFor="classifier-model">Classifier model</FormLabel>
          <Select
            id="classifier-model"
            value={boundId ? `model:${boundId}` : ""}
            aria-label="Classifier model"
            disabled={mutation.isPending}
            onChange={(event) => {
              const raw = event.target.value;
              mutation.mutate(raw.startsWith("model:") ? raw.slice("model:".length) : null);
            }}
          >
            <option value="">Use main model</option>
            {unavailableName ? (
              <option value={`model:${boundId}`} disabled>
                {`${unavailableName} (unavailable)`}
              </option>
            ) : null}
            {[...groups].map(([providerName, list]) => (
              <optgroup key={providerName} label={providerName}>
                {list.map((model) => (
                  <option key={model.id} value={`model:${model.id}`}>
                    {model.displayName}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {boundId && !bound ? (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            Chosen model is unavailable. Using your main model.
          </span>
        ) : null}
        <Field>
          <span className="jds-label">
            Chat gate <InfoTip label="What the chat gate does">{GATE_TIP}</InfoTip>
          </span>
          <Segmented
            value={savedGateMode}
            ariaLabel="Gate state"
            onChange={(mode) => gateMutation.mutate(mode)}
            options={CLASSIFIER_GATE_MODES.map((mode) => ({
              value: mode,
              label: GATE_LABELS[mode],
              disabled: gateMutation.isPending || gateDisabled || (mode === "on" && !canChooseOn),
              title:
                mode === "on" && !canChooseOn
                  ? "Available after shadow results are reviewed"
                  : undefined
            }))}
          />
        </Field>
        {!gateDisabled && !canChooseOn ? (
          <div className="rt__desc">On opens after shadow review.</div>
        ) : null}
      </div>
    </div>
  );
}
