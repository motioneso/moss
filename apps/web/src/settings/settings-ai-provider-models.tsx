import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  MinusCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";
import { useState } from "react";

import { Button } from "@moss/ui";
import { refreshAiProviderModels } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { readError } from "./settings-types.js";
import { AddModelForm, CAP_SHORT, EditModelForm, TIERS } from "./settings-ai-edit-model-form.js";
import type {
  AiConfiguredModelDto,
  AiProviderConfigDto,
  RefreshAiProviderModelsResponse
} from "@moss/shared";

/** #2208: the one-line outcome shown under the list after "Refresh models". */
export function describeRefreshOutcome(result: RefreshAiProviderModelsResponse): string {
  switch (result.reason) {
    case undefined:
      return `Refreshed: ${result.models.length} ${result.models.length === 1 ? "model" : "models"}`;
    case "not_logged_in":
      return "Not logged in";
    case "unsupported":
      return "This provider cannot list its models yet";
    case "unavailable":
      return "The sign-in helper is not running";
    case "error":
      return "Could not reach the provider";
  }
}

function ModelLine(props: {
  readonly model: AiConfiguredModelDto;
  readonly isEditing: boolean;
  readonly onEdit: () => void;
  readonly onOverrideChange: (model: AiConfiguredModelDto, allowed: boolean) => void;
  readonly onStatusChange: (model: AiConfiguredModelDto, status: "active" | "disabled") => void;
  readonly onDelete: (model: AiConfiguredModelDto) => void;
}) {
  const { model } = props;
  const isSentinel = model.providerModelId === "default";
  const tier = TIERS[model.tier];
  const isDisabled = model.status === "disabled";
  return (
    <div className={`mdl${isDisabled ? " mdl--disabled" : ""}`}>
      <div className="mdl__id">
        {model.providerModelId}
        {isDisabled ? <span className="mdl__off">off</span> : null}
        {/* #2208: a row the admin typed in; discovery never removes it. The list footer
            explains the mark ("* Manually added") whenever one is present. */}
        {model.origin === "manual" ? (
          <span className="mdl__origin" title="Manually added">
            *
          </span>
        ) : null}
      </div>
      <span className={`tier tier--${model.tier}`} title={tier.hint}>
        {tier.label}
      </span>
      <div className="mdl__caps">
        {model.capabilities.map((c) =>
          c === "chat" ? (
            /* The Chat tag is the switch: pressed means users may pick this model for chat;
               off dims the tag (Ben, 2026-09-04: "make this a toggle ... noticeably dim"). */
            <button
              type="button"
              key={c}
              className={`cap cap--toggle${model.allowUserOverride ? "" : " cap--off"}`}
              aria-pressed={model.allowUserOverride}
              aria-label={`Chat for ${model.displayName}`}
              title={
                model.allowUserOverride
                  ? "Chat is on for this model. Click to turn it off."
                  : "Chat is off for this model. Click to turn it on."
              }
              onClick={() => props.onOverrideChange(model, !model.allowUserOverride)}
            >
              {CAP_SHORT[c] ?? c}
            </button>
          ) : (
            <span className="cap" key={c}>
              {CAP_SHORT[c] ?? c}
            </span>
          )
        )}
      </div>
      <button
        type="button"
        className={`mdl__edit-btn${props.isEditing ? " is-active" : ""}`}
        title="Edit model"
        aria-label={`Edit ${model.displayName}`}
        onClick={props.onEdit}
      >
        <Pencil size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="mdl__toggle-btn"
        title={isDisabled ? "Enable model" : "Disable model"}
        aria-label={isDisabled ? `Enable ${model.displayName}` : `Disable ${model.displayName}`}
        onClick={() => props.onStatusChange(model, isDisabled ? "active" : "disabled")}
      >
        <MinusCircle size={12} aria-hidden="true" />
      </button>
      {/* #2208 follow-up: Remove deletes the row for good; the provider's default entry stays. */}
      <button
        type="button"
        className="mdl__delete-btn"
        title={isSentinel ? "The provider's default entry cannot be removed" : "Remove model"}
        aria-label={`Remove ${model.displayName}`}
        disabled={isSentinel}
        onClick={() => props.onDelete(model)}
      >
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The "Models · N" section of one provider card: the list, inline edit, and (#2208) the
 * "Refresh models" / "Add model" controls with the refresh outcome line under the list.
 */
export function ProviderModels(props: {
  readonly provider: AiProviderConfigDto;
  readonly models: readonly AiConfiguredModelDto[];
  readonly onModelOverride: (model: AiConfiguredModelDto, allowed: boolean) => void;
  readonly onModelStatusChange: (
    model: AiConfiguredModelDto,
    status: "active" | "disabled"
  ) => void;
  readonly onModelDelete: (model: AiConfiguredModelDto) => void;
}) {
  const { provider } = props;
  const queryClient = useQueryClient();
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Collapsed by default: a provider with a dozen discovered models made the card very tall.
  const [open, setOpen] = useState(false);
  const hasManual = props.models.some((m) => m.origin === "manual");
  const [refreshOutcome, setRefreshOutcome] = useState<string | null>(null);

  const refreshMutation = useMutation({
    mutationFn: () => refreshAiProviderModels(provider.id),
    onSuccess: (result) => {
      setRefreshOutcome(describeRefreshOutcome(result));
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.models }),
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
      ]);
    },
    onError: (error) => setRefreshOutcome(readError(error))
  });

  return (
    <div className="prov__models">
      <div className="prov__modelshd">
        <button
          type="button"
          className="prov__modelstoggle"
          aria-expanded={open}
          onClick={() => setOpen((cur) => !cur)}
        >
          {open ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
          Models · {props.models.length}
        </button>
        <span className="prov__modelacts">
          <Button
            variant="quiet"
            size="sm"
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
            icon={<RefreshCw size={13} />}
          >
            {refreshMutation.isPending ? "Refreshing" : "Refresh models"}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setAdding((cur) => !cur);
              setOpen(true);
            }}
            icon={<Plus size={13} />}
          >
            {adding ? "Close" : "Add model"}
          </Button>
        </span>
      </div>
      {!open ? null : (
        <>
          {adding ? (
            <AddModelForm providerConfigId={provider.id} onClose={() => setAdding(false)} />
          ) : null}
          <div className="prov__modellist">
            {props.models.length ? (
              props.models.map((m) => (
                <div key={m.id}>
                  <ModelLine
                    model={m}
                    isEditing={editingModelId === m.id}
                    onEdit={() => setEditingModelId((cur) => (cur === m.id ? null : m.id))}
                    onOverrideChange={props.onModelOverride}
                    onStatusChange={props.onModelStatusChange}
                    onDelete={props.onModelDelete}
                  />
                  {editingModelId === m.id ? (
                    <EditModelForm model={m} onClose={() => setEditingModelId(null)} />
                  ) : null}
                </div>
              ))
            ) : (
              <div className="prov__synced" style={{ marginTop: 0 }}>
                Models appear here automatically when the provider connects.
              </div>
            )}
          </div>
          {refreshOutcome !== null ? (
            <div className="prov__synced" role="status">
              <RefreshCw size={11} aria-hidden="true" />
              {refreshOutcome}
            </div>
          ) : null}
          {hasManual ? <div className="prov__manualnote">* Manually added</div> : null}
        </>
      )}
    </div>
  );
}
