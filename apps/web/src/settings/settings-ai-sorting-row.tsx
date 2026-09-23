import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, MinusCircle } from "lucide-react";

import {
  SORTING_SERVICE_KEY,
  isSortingProviderKind,
  type AiConfiguredModelDto,
  type AiProviderConfigDto,
  type AiServiceBinding
} from "@moss/shared";

import { deleteAiServiceBinding, putAiServiceBinding } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Select } from "./settings-ui";

export const SORTING_DISCLOSURE =
  "Story details and your saved story preferences go to this model first, and to your main " +
  "model if it does not answer. Each may charge for the request.";

// Models the sorting path can run: active, ready provider, json, structured-capable kind.
function eligibleSortingModels(
  models: readonly AiConfiguredModelDto[],
  providers: readonly AiProviderConfigDto[]
): AiConfiguredModelDto[] {
  return models.filter((model) => {
    const provider = providers.find((candidate) => candidate.id === model.providerConfigId);
    const providerReady =
      provider?.status === "active" &&
      (provider.authMethod === "cli" ? provider.cliAvailable : provider.hasCredential);
    return (
      model.status === "active" &&
      model.providerStatus === "active" &&
      providerReady &&
      isSortingProviderKind(model.providerKind) &&
      model.capabilities.includes("json")
    );
  });
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

  const eligible = eligibleSortingModels(props.models, props.providers);
  const boundId = props.binding?.kind === "model" ? props.binding.modelId : null;
  const bound = boundId ? (eligible.find((model) => model.id === boundId) ?? null) : null;
  const groups = new Map<string, AiConfiguredModelDto[]>();
  for (const model of eligible) {
    const list = groups.get(model.providerDisplayName) ?? [];
    list.push(model);
    groups.set(model.providerDisplayName, list);
  }

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">Sorting model</div>
        <div className="rt__desc">
          A small, fast model for sorting, filtering and picking out details. Leave empty to use
          your main model.
        </div>
        {bound ? <div className="rt__desc">{SORTING_DISCLOSURE}</div> : null}
      </div>
      <div className="rt__pick">
        <Select
          value={bound ? `model:${bound.id}` : ""}
          aria-label="Binding for Sorting model"
          disabled={mutation.isPending}
          onChange={(event) => {
            const raw = event.target.value;
            mutation.mutate(raw.startsWith("model:") ? raw.slice("model:".length) : null);
          }}
        >
          <option value="">Use main model</option>
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
        {boundId && !bound ? (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            Chosen model is unavailable. Using your main model.
          </span>
        ) : null}
      </div>
    </div>
  );
}
