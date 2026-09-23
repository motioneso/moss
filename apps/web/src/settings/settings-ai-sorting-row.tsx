import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, MinusCircle } from "lucide-react";

import {
  SORTING_SERVICE_KEY,
  isSortingBindableProviderKind,
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

export const TRAIL_MARKER_DISCLOSURE =
  "Trail Marker sends the app name, window title and calendar block title to this model for " +
  "every focus check. A model served through a command-line tool also keeps them in that " +
  "tool's own files on this server.";

export const SYSTEM_ONE_SORTING_NOTE =
  "A System One (TypeSafe) model sends them to TypeSafe. It only judges Trail Marker focus; " +
  "sorting uses your main model until System One can sort.";

// Models the sorting model may be: the model and its provider are active, it has the json
// capability, and its provider kind is one generateStructured executes, or System One, which only
// judges Trail Marker focus. The save route applies this same rule.
function eligibleSortingModels(models: readonly AiConfiguredModelDto[]): AiConfiguredModelDto[] {
  return models.filter(
    (model) =>
      model.status === "active" &&
      model.providerStatus === "active" &&
      isSortingBindableProviderKind(model.providerKind) &&
      model.capabilities.includes("json")
  );
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

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">Sorting model</div>
        <div className="rt__desc">
          A small, fast model for sorting, filtering and picking out details. It also judges Trail
          Marker focus. Leave empty to use your main model for sorting; Trail Marker judges nothing
          until a model is chosen here.
        </div>
        {boundId && bound?.providerKind !== "system-one" ? (
          <div className="rt__desc">{SORTING_DISCLOSURE}</div>
        ) : null}
        {boundId ? <div className="rt__desc">{TRAIL_MARKER_DISCLOSURE}</div> : null}
        {bound?.providerKind === "system-one" ? (
          <div className="rt__desc">{SYSTEM_ONE_SORTING_NOTE}</div>
        ) : null}
      </div>
      <div className="rt__pick">
        <Select
          value={boundId ? `model:${boundId}` : ""}
          aria-label="Binding for Sorting model"
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
