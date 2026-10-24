import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AudioLines } from "lucide-react";
import { Button } from "@moss/ui";
import {
  deleteAiServiceBinding,
  listAiModels,
  listAiProviders,
  listAiServiceBindings,
  putAiServiceBinding
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Field, Group, Note, Select } from "./settings-ui";
import { VoiceConfigGroup } from "./settings-voice-config-group";

/** One admin-selected transcription model for the instance, using live provider credentials. */
export function TranscriptionConfigGroup() {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const providers = useQuery({
    queryKey: queryKeys.ai.providers,
    queryFn: listAiProviders,
    retry: false
  });
  const models = useQuery({ queryKey: queryKeys.ai.models, queryFn: listAiModels, retry: false });
  const bindings = useQuery({
    queryKey: queryKeys.ai.serviceBindings,
    queryFn: listAiServiceBindings,
    retry: false
  });
  const binding = bindings.data?.bindings.transcription;
  const saved = binding?.kind === "model" ? binding.modelId : "";
  const [draft, setDraft] = useState<string | null>(null);
  const selected = draft ?? saved;
  const choices = (models.data?.models ?? []).filter(
    (model) =>
      model.status === "active" &&
      model.capabilities.includes("transcription") &&
      providers.data?.providers.some(
        (provider) =>
          provider.id === model.providerConfigId &&
          provider.status === "active" &&
          provider.providerKind === "openai-compatible" &&
          provider.authMethod === "api_key" &&
          provider.hasCredential &&
          !provider.revokedAt
      )
  );
  const error = providers.error ?? models.error ?? bindings.error;
  const ready = providers.isSuccess && models.isSuccess && bindings.isSuccess;
  const save = useMutation({
    mutationFn: (modelId: string) =>
      modelId
        ? putAiServiceBinding("transcription", { binding: { kind: "model", modelId } })
        : deleteAiServiceBinding("transcription"),
    onSuccess: async (_result, modelId) => {
      client.setQueryData(queryKeys.ai.serviceBindings, {
        bindings: {
          ...bindings.data?.bindings,
          transcription: modelId ? { kind: "model", modelId } : undefined
        }
      });
      setDraft(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.ai.serviceBindings }),
        client.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
      ]);
      toast("Transcription provider saved", { icon: <AudioLines size={17} /> });
    },
    onError: (failure) => toast(readError(failure), { tone: "drift" })
  });
  return (
    <>
      <Group title="Transcription" desc="For everyone's voice input and Meeting transcripts.">
        {error ? (
          <Note>
            Could not load transcription providers: {readError(error)}{" "}
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                void providers.refetch();
                void models.refetch();
                void bindings.refetch();
              }}
            >
              Retry
            </Button>
          </Note>
        ) : !ready ? (
          <p role="status">Loading transcription providers…</p>
        ) : null}
        <Field
          label="Provider and model"
          controlId="transcription-model"
          hintId="transcription-model-hint"
          hint="Audio is sent to the selected provider."
        >
          <Select
            id="transcription-model"
            aria-describedby="transcription-model-hint"
            value={selected}
            disabled={!ready || save.isPending}
            onChange={(event) => setDraft(event.target.value)}
          >
            <option value="">Existing voice endpoint</option>
            {selected && !choices.some((model) => model.id === selected) ? (
              <option value={selected}>Saved model (unavailable)</option>
            ) : null}
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.providerDisplayName} · {model.displayName}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            disabled={
              !ready ||
              save.isPending ||
              selected === saved ||
              Boolean(selected && !choices.some((model) => model.id === selected))
            }
            onClick={() => save.mutate(selected)}
          >
            {save.isPending ? "Saving…" : "Save transcription provider"}
          </Button>
        </Field>
        {ready && !error && !saved && !choices.length ? (
          <Note>
            Add an OpenAI-compatible provider above, then a model with the Voice capability.
          </Note>
        ) : null}
        {ready && !error && saved && !choices.some((model) => model.id === saved) ? (
          <Note>
            Transcription is paused. Choose another model or use the existing voice endpoint.
          </Note>
        ) : null}
      </Group>
      {bindings.isSuccess && !saved ? <VoiceConfigGroup /> : null}
    </>
  );
}
