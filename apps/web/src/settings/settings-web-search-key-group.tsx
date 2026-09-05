import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Globe, Trash2 } from "lucide-react";

import { deleteWebSearchKey, getWebSearchKey, putWebSearchKey } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Field, Group, Note, Row, Switch } from "./settings-ui";
import { Button } from "@moss/ui";

export function WebSearchKeyGroup() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const assistantName = useAssistantName();
  const [apiKey, setApiKey] = useState("");

  const statusQuery = useQuery({
    queryKey: queryKeys.ai.webSearchKey,
    queryFn: getWebSearchKey,
    retry: false
  });
  const status = statusQuery.data?.status;
  const configured = status?.configured ?? false;
  const fromEnv = status?.source === "env";
  const nativeSearchEnabled = status?.nativeSearchEnabled ?? true;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.webSearchKey });

  const nativeSearchMutation = useMutation({
    mutationFn: (enabled: boolean) => putWebSearchKey({ nativeSearchEnabled: enabled }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const saveMutation = useMutation({
    mutationFn: (key: string) => putWebSearchKey({ apiKey: key }),
    onSuccess: () => {
      setApiKey("");
      void invalidate();
      toast("Web search key saved", { icon: <Globe size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const revokeMutation = useMutation({
    mutationFn: () => deleteWebSearchKey(),
    onSuccess: () => {
      void invalidate();
      toast("Web search key removed", { tone: "drift", icon: <Trash2 size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const statusLine = configured
    ? "On, using Brave"
    : nativeSearchEnabled
      ? "On, using each person's chat model"
      : "Off. Add a Brave key or turn on built-in search.";

  return (
    <Group
      title="Web search"
      desc={`${assistantName} can search the live web to answer questions. Each person's chat model uses its own built-in search by default; add a Brave Search key for consistent results across every model, including local ones.`}
    >
      <Row
        name="Use your model's built-in web search"
        desc={statusLine}
        control={
          <Switch
            ariaLabel="Use your model's built-in web search"
            checked={nativeSearchEnabled}
            disabled={nativeSearchMutation.isPending}
            onChange={(enabled) => nativeSearchMutation.mutate(enabled)}
          />
        }
      />
      <Field
        label="Brave Search API key"
        hint="Enhanced: consistent results for every model, including local ones. Stored encrypted. Never shown in chat, briefings or logs."
      >
        <input
          className="jds-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={configured ? "•••••••• (stored)" : "BSA…"}
          aria-label="Brave Search API key"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!apiKey.trim() || saveMutation.isPending}
          onClick={() => saveMutation.mutate(apiKey.trim())}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
        {configured && !fromEnv ? (
          <Button
            variant="quiet"
            size="sm"
            disabled={revokeMutation.isPending}
            onClick={() =>
              confirm({
                title: "Remove web search key?",
                description: `${assistantName} stops searching the web until a new key is added.`,
                confirmLabel: "Remove",
                danger: true,
                onConfirm: () => revokeMutation.mutate()
              })
            }
          >
            Revoke
          </Button>
        ) : null}
      </Field>
      <Note icon={<Globe size={13} />}>
        {fromEnv ? (
          <>
            Using a key from the <code>JARVIS_BRAVE_SEARCH_API_KEY</code> environment variable.
            Saving a key here overrides it; the env key can&apos;t be revoked from this screen.
          </>
        ) : configured ? (
          <>Web search is on. Get or manage keys at the Brave Search API dashboard.</>
        ) : (
          <>
            Add a Brave Search key for the same results on every model. Get one at{" "}
            <a href="https://brave.com/search/api/" target="_blank" rel="noreferrer">
              brave.com/search/api
            </a>
            .
          </>
        )}
      </Note>
    </Group>
  );
}
