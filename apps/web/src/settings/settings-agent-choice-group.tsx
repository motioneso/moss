import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";

import {
  ACP_AGENT_DEFAULT,
  agentsForSurface,
  isKnownAcpAgentId,
  type AcpAgentSurface
} from "@moss/shared";
import { listInstanceSettings, putInstanceSetting } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Group, Note, Row, Select } from "./settings-ui";

const SURFACE_ROWS: readonly {
  surface: AcpAgentSurface;
  settingKey: string;
  name: string;
  desc: string;
}[] = [
  {
    surface: "workshop",
    settingKey: "workshop.agent",
    name: "Workshop builds",
    desc: "Which agent answers Workshop project messages and runs build commands."
  },
  {
    surface: "chat",
    settingKey: "chat.agent",
    name: "Chat",
    desc: "Which agent answers chat. No outside agent passes the chat gate yet."
  }
];

function settingValue(
  settings: readonly { key: string; value: Record<string, unknown> }[] | undefined,
  key: string
): string {
  const raw = settings?.find((entry) => entry.key === key)?.value?.value;
  return typeof raw === "string" && isKnownAcpAgentId(raw) ? raw : ACP_AGENT_DEFAULT;
}

export function AgentChoiceGroup() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const settingsQuery = useQuery({
    queryKey: queryKeys.ai.agentSettings,
    queryFn: listInstanceSettings,
    retry: false
  });

  const mutation = useMutation({
    mutationFn: ({ key, agentId }: { key: string; agentId: string }) =>
      putInstanceSetting(key, { value: agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.agentSettings });
      toast("Agent choice saved", { icon: <Bot size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  return (
    <Group
      title="Agents"
      desc="Choose which agent answers each surface. Only agents that pass that surface's capability check are offered."
    >
      {SURFACE_ROWS.map((row) => {
        const agents = agentsForSurface(row.surface);
        const current = settingValue(settingsQuery.data?.settings, row.settingKey);
        return (
          <Row
            key={row.settingKey}
            name={row.name}
            desc={row.desc}
            control={
              <Select
                value={current}
                aria-label={`Agent for ${row.name}`}
                disabled={settingsQuery.isLoading || mutation.isPending}
                onChange={(event) =>
                  mutation.mutate({ key: row.settingKey, agentId: event.target.value })
                }
              >
                <option value={ACP_AGENT_DEFAULT}>Moss default</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </Select>
            }
          />
        );
      })}
      {SURFACE_ROWS.map((row) =>
        agentsForSurface(row.surface)
          .filter(
            (agent) =>
              agent.loginNote &&
              settingValue(settingsQuery.data?.settings, row.settingKey) === agent.id
          )
          .map((agent) => <Note key={`${row.settingKey}-${agent.id}`}>{agent.loginNote}</Note>)
      )}
      {agentsForSurface("chat").length === 0 ? (
        <Note>Chat stays on Moss default until an outside agent passes its gate.</Note>
      ) : null}
    </Group>
  );
}
