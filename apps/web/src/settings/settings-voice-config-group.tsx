import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AudioLines, GitCommitHorizontal } from "lucide-react";

import { getVoiceEndpoint, putVoiceEndpoint } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Field, Group, Note, Row, Switch } from "./settings-ui";
import { Button } from "@moss/ui";

/**
 * #874 — the dedicated Voice (STT) admin section.
 *
 * Deliberately SEPARATE from the LLM Providers list: Voice is a single instance-wide,
 * OpenAI-compatible transcription endpoint configured by hand (base URL + API key + free-text
 * model name). No vendor catalog, no auto-discovery — the backend upsert writes exactly one
 * `purpose='voice'` provider row and never probes /models (CRIT-1). The API key is write-only:
 * the GET DTO reports only `hasKey`, never the key itself, and PUT is omit-means-keep (leaving
 * `apiKey` blank on edit keeps the stored key).
 */
export function VoiceConfigGroup() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const endpointQuery = useQuery({
    queryKey: queryKeys.ai.voiceEndpoint,
    queryFn: getVoiceEndpoint,
    retry: false
  });
  const endpoint = endpointQuery.data?.endpoint;
  const configured = endpoint?.configured ?? false;
  const hasKey = endpoint?.hasKey ?? false;

  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);

  // Seed the form from the stored endpoint once it loads (and whenever it changes after a save).
  // The API key is never returned, so it always starts blank — a blank key on save = keep-existing.
  useEffect(() => {
    if (!endpoint) return;
    setBaseUrl(endpoint.baseUrl ?? "");
    setModelName(endpoint.modelName ?? "");
    setEnabled(endpoint.enabled);
  }, [endpoint]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.voiceEndpoint });

  const saveMutation = useMutation({
    mutationFn: () =>
      putVoiceEndpoint({
        baseUrl: baseUrl.trim(),
        modelName: modelName.trim(),
        enabled,
        // Omit-means-keep: only send a key when the admin actually typed one.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      }),
    onSuccess: () => {
      setApiKey("");
      void invalidate();
      toast("Voice endpoint saved", { icon: <AudioLines size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const enabledMutation = useMutation({
    mutationFn: (next: boolean) =>
      // Toggling enable/disable reuses the existing base URL / model (unchanged) and keeps the key.
      putVoiceEndpoint({ baseUrl: baseUrl.trim(), modelName: modelName.trim(), enabled: next }),
    onSuccess: () => {
      void invalidate();
      toast("Voice endpoint updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  // A save needs a base URL and a model name always; on the FIRST create it also needs a key (the
  // backend rejects a keyless create with 400 — mirror that here so the button is clearly gated).
  const missingRequired = !baseUrl.trim() || !modelName.trim();
  const missingInitialKey = !configured && !apiKey.trim();
  const canSave = !missingRequired && !missingInitialKey && !saveMutation.isPending;

  return (
    <Group
      title="Voice (speech-to-text)"
      titleAs="h4"
      desc="A single OpenAI-compatible transcription endpoint powers the microphone for everyone on this instance. Configure it here — it is separate from the chat providers above."
    >
      {configured ? (
        <Row
          name="Enabled"
          desc="When off, the microphone is unavailable across the instance."
          control={
            <Switch
              ariaLabel="Enable the voice transcription endpoint"
              checked={enabled}
              disabled={enabledMutation.isPending || saveMutation.isPending}
              onChange={(next) => {
                setEnabled(next);
                enabledMutation.mutate(next);
              }}
            />
          }
        />
      ) : null}
      <Field
        label="Base URL"
        hint="e.g. https://api.openai.com — the /v1/audio/transcriptions path is appended automatically."
      >
        <input
          className="jds-input"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com"
          aria-label="Voice endpoint base URL"
        />
      </Field>
      <Field
        label="Model"
        hint="The transcription model name, exactly as the endpoint expects it (e.g. whisper-1)."
      >
        <input
          className="jds-input"
          type="text"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          placeholder="whisper-1"
          aria-label="Voice endpoint model name"
        />
      </Field>
      <Field
        label="API key"
        hint="Stored encrypted. Never shown in chat, briefings or logs. Leave blank to keep the current key."
      >
        <input
          className="jds-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? "•••••••• (stored)" : "sk-…"}
          aria-label="Voice endpoint API key"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!canSave}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </Field>
      <Note icon={<AudioLines size={13} />}>
        {configured ? (
          <>The microphone transcribes through this endpoint for every user.</>
        ) : (
          <>
            The microphone stays unavailable until a base URL, model and API key are saved. Any
            OpenAI-compatible speech-to-text server works.
          </>
        )}
      </Note>
    </Group>
  );
}
