import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal } from "lucide-react";
import { useId } from "react";

import type { AiCliToolsDto } from "@moss/shared";

import { getChatSettings, putChatSettings } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { Field, Select } from "./settings-ui";

/** #2689: "Claude CLI 2.1.282" when the runner reported a version, "Claude CLI" otherwise. */
export function cliVersionLine(name: string, tools: AiCliToolsDto | undefined): string {
  return tools?.version ? `${name} CLI ${tools.version}` : `${name} CLI`;
}

export function OpenCodeAcpCard(props: { readonly cli: AiCliToolsDto | undefined }) {
  const queryClient = useQueryClient();
  const modelId = useId();
  const settingsQuery = useQuery({
    queryKey: queryKeys.chat.settings,
    queryFn: getChatSettings,
    retry: false
  });
  const settingsMutation = useMutation({
    mutationFn: putChatSettings,
    onSuccess: (result) => queryClient.setQueryData(queryKeys.chat.settings, result)
  });
  const model = settingsQuery.data?.chat.openCodeModel ?? "default";

  return (
    <div className="prov" aria-label="OpenCode ACP provider">
      <div className="prov__head">
        <span className="prov__mark">O</span>
        <div className="prov__id">
          <div className="prov__name">OpenCode</div>
          <div className="prov__auth">
            <Terminal size={12} aria-hidden="true" />{" "}
            {props.cli?.version ? cliVersionLine("OpenCode", props.cli) : "ACP chat provider"}
          </div>
        </div>
      </div>
      <div className="prov__edit">
        <Field
          label="Chat model"
          controlId={modelId}
          hintId={`${modelId}-hint`}
          hint="Saved for the next OpenCode ACP session; the agent applies it when it advertises a model choice."
        >
          <Select
            id={modelId}
            aria-describedby={`${modelId}-hint`}
            value={model}
            disabled={settingsQuery.isLoading || settingsMutation.isPending}
            onChange={(event) =>
              settingsMutation.mutate({
                chat: {
                  responseStyle: settingsQuery.data?.chat.responseStyle ?? "balanced",
                  openCodeModel: event.target.value as "default" | "muse-spark-1.3-free"
                }
              })
            }
          >
            <option value="default">Login default</option>
            <option value="muse-spark-1.3-free">Muse Spark 1.3 free</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}
