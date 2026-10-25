import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, LockKeyholeOpen, ServerCog } from "lucide-react";

import { getAdminUserAiPin, putAdminUserAiPin } from "../api/client-admin";
import { getMe } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Note, Row, Select } from "./settings-ui";
import type { AiConfiguredModelDto } from "@moss/shared";

function modelGroupLabel(model: AiConfiguredModelDto): string {
  return model.providerDisplayName || "Unknown provider";
}

/** The chat lock for this account, as rows inside the "Which model does what" section. */
export function ChatLockRows() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const meQuery = useQuery({ queryKey: queryKeys.auth.me, queryFn: getMe, retry: false });
  const userId = meQuery.data?.user.id ?? null;

  const pinQueryKey = userId ? queryKeys.ai.adminUserAiPin(userId) : null;
  const pinQuery = useQuery({
    queryKey: pinQueryKey ?? ["ai", "admin", "users", "__none__", "pin"],
    queryFn: () => getAdminUserAiPin(userId!),
    enabled: userId !== null,
    retry: false
  });

  const mutation = useMutation({
    mutationFn: (modelId: string | null) => putAdminUserAiPin(userId!, { modelId }),
    onSuccess: (data) => {
      if (pinQueryKey) queryClient.setQueryData(pinQueryKey, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.capability("chat") });
      toast(data.pin.pinnedModelId ? "Chat model locked" : "Chat lock cleared", {
        icon: data.pin.pinnedModelId ? <LockKeyhole size={17} /> : <LockKeyholeOpen size={17} />
      });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const pin = pinQuery.data?.pin;
  const models = pin?.availableModels?.filter((m) => m.capabilities.includes("chat")) ?? [];
  const value = pin?.pinnedModelId ?? "";
  const busy = pinQuery.isLoading || mutation.isPending || !userId;
  const isUnavailable = pin?.effectiveChatReason === "admin-pin-unavailable";

  // Group models by provider for optgroups
  const grouped = new Map<string, AiConfiguredModelDto[]>();
  for (const model of models) {
    const group = modelGroupLabel(model);
    const existing = grouped.get(group);
    if (existing) existing.push(model);
    else grouped.set(group, [model]);
  }

  const effectiveDesc = (): string => {
    if (!pin) return "";
    if (pin.effectiveChatModel) {
      return `Current effective model: ${pin.effectiveChatModel.displayName}`;
    }
    return "No active chat model";
  };

  return (
    <>
      <Row
        name="Lock my chat to one model"
        desc={effectiveDesc()}
        control={
          <Select
            value={value}
            aria-label="Locked chat model"
            disabled={busy || (models.length === 0 && !value)}
            onChange={(event) => mutation.mutate(event.target.value || null)}
          >
            <option value="">Unlocked — use instance default</option>
            {[...grouped.entries()].map(([group, groupModels]) => (
              <optgroup key={group} label={group}>
                {groupModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                    {model.status === "disabled" ? " (disabled)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        }
      />
      {isUnavailable ? (
        <Note icon={<ServerCog size={13} />}>
          The locked model is unavailable or disabled. Chat is blocked until the lock is cleared or
          the model is re-enabled.
        </Note>
      ) : null}
      {models.length === 0 && !pinQuery.isLoading ? (
        <Note icon={<LockKeyholeOpen size={13} />}>
          No chat-capable active models on your account.
        </Note>
      ) : null}
    </>
  );
}
