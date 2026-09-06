import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@moss/ui";
import { createAiModel, updateAiModel } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { readError } from "./settings-types.js";
import { useFeedback } from "./settings-feedback.js";
import { Field, Segmented } from "./settings-ui.js";
import {
  AI_MODEL_CAPABILITIES,
  type AiConfiguredModelDto,
  type AiModelCapability,
  type AiModelTier
} from "@moss/shared";

const ALL_CAPABILITIES: readonly AiModelCapability[] = AI_MODEL_CAPABILITIES;

export const CAP_SHORT: Record<AiModelCapability, string> = {
  chat: "Chat",
  "tool-use": "Tools",
  json: "JSON",
  vision: "Vision",
  summarization: "Summary",
  transcription: "Voice",
  "web-search": "Web search"
};

export const TIERS: Record<AiModelTier, { label: string; hint: string }> = {
  reasoning: { label: "Reasoning", hint: "Deepest and slowest. Hard planning and judgment." },
  interactive: { label: "Interactive", hint: "Fast and balanced. The everyday default." },
  economy: { label: "Economy", hint: "Cheapest and quickest. Light, high-volume work." }
};

export const MODEL_TIERS: readonly AiModelTier[] = ["reasoning", "interactive", "economy"];

export interface ModelFormValues {
  readonly providerModelId: string;
  readonly displayName: string;
  readonly tier: AiModelTier;
  readonly capabilities: readonly AiModelCapability[];
}

/**
 * The one model form (Model id, Display name, Tier, Capabilities) behind both the inline edit
 * (B513) and #2208's "Add model". The caller owns the request; this owns the fields.
 */
function ModelForm(props: {
  readonly initial: ModelFormValues;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly pending: boolean;
  readonly onSubmit: (values: ModelFormValues) => void;
  readonly onClose: () => void;
}) {
  const [providerModelId, setProviderModelId] = useState(props.initial.providerModelId);
  const [displayName, setDisplayName] = useState(props.initial.displayName);
  const [tier, setTier] = useState<AiModelTier>(props.initial.tier);
  const [capabilities, setCapabilities] = useState<readonly AiModelCapability[]>(
    props.initial.capabilities
  );
  const valid = providerModelId.trim() !== "" && displayName.trim() !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    props.onSubmit({
      providerModelId: providerModelId.trim(),
      displayName: displayName.trim(),
      tier,
      capabilities
    });
  };

  return (
    <form className="ai-model-form ai-model-form--edit" onSubmit={submit}>
      <Field label="Model id">
        <input
          className="jds-input"
          value={providerModelId}
          onChange={(e) => setProviderModelId(e.target.value)}
          aria-label="Model id"
        />
      </Field>
      <Field label="Display name">
        <input
          className="jds-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-label="Display name"
        />
      </Field>
      <Field label="Tier">
        <Segmented<AiModelTier>
          value={tier}
          options={MODEL_TIERS}
          ariaLabel="Model tier"
          onChange={setTier}
        />
      </Field>
      <div className="cap-list" aria-label="Model capabilities">
        {ALL_CAPABILITIES.map((capability) => (
          <label className="cap-list__item" key={capability}>
            <input
              type="checkbox"
              checked={capabilities.includes(capability)}
              onChange={(e) =>
                setCapabilities((cur) =>
                  e.target.checked ? [...cur, capability] : cur.filter((x) => x !== capability)
                )
              }
            />
            {CAP_SHORT[capability]}
          </label>
        ))}
      </div>
      <div className="ai-model-form__acts">
        <Button type="submit" size="sm" disabled={props.pending || !valid}>
          {props.pending ? props.pendingLabel : props.submitLabel}
        </Button>
        <Button variant="quiet" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditModelForm(props: {
  readonly model: AiConfiguredModelDto;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const { model } = props;

  const editMutation = useMutation({
    mutationFn: (values: ModelFormValues) => updateAiModel(model.id, values),
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.models }),
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
      ]);
      toast("Model updated", { icon: <Pencil size={17} /> });
      props.onClose();
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  return (
    <ModelForm
      initial={{
        providerModelId: model.providerModelId ?? "",
        displayName: model.displayName,
        tier: model.tier,
        capabilities: model.capabilities
      }}
      submitLabel="Save"
      pendingLabel="Saving…"
      pending={editMutation.isPending}
      onSubmit={(values) => editMutation.mutate(values)}
      onClose={props.onClose}
    />
  );
}

/**
 * #2208: add a model by hand under one provider. The row is stored as `manual`, so a later
 * "Refresh models" or re-login never removes it.
 */
export function AddModelForm(props: {
  readonly providerConfigId: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const addMutation = useMutation({
    mutationFn: (values: ModelFormValues) =>
      createAiModel({ providerConfigId: props.providerConfigId, ...values }),
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.models }),
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
      ]);
      toast("Model added", { icon: <Plus size={17} /> });
      props.onClose();
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  return (
    <ModelForm
      initial={{
        providerModelId: "",
        displayName: "",
        tier: "interactive",
        capabilities: ["chat"]
      }}
      submitLabel="Add model"
      pendingLabel="Adding…"
      pending={addMutation.isPending}
      onSubmit={(values) => addMutation.mutate(values)}
      onClose={props.onClose}
    />
  );
}
