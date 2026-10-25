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

/** The signed-in admin's own AI lock (read side), shared by the lock row and the chat picker. */
export function useOwnAiPin(enabled = true) {
  const meQuery = useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: () => getMe(),
    enabled,
    retry: false
  });
  const userId = meQuery.data?.user.id ?? null;
  const pinQueryKey = userId ? queryKeys.ai.adminUserAiPin(userId) : null;
  const pinQuery = useQuery({
    queryKey: pinQueryKey ?? ["ai", "admin", "users", "__none__", "pin"],
    queryFn: () => getAdminUserAiPin(userId!),
    enabled: enabled && userId !== null,
    retry: false
  });
  return { userId, pinQueryKey, pinQuery };
}

/**
 * The lock for this account, shown on Personal > Your assistant. A set lock wins over the chat
 * picker and applies to chat, voice and background work, so the copy says so.
 */
export function ChatLockRows() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const { userId, pinQueryKey, pinQuery } = useOwnAiPin();

  const mutation = useMutation({
    mutationFn: (modelId: string | null) => putAdminUserAiPin(userId!, { modelId }),
    onSuccess: (data) => {
      if (pinQueryKey) queryClient.setQueryData(pinQueryKey, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.capability("chat") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.chatModelOverride });
      toast(data.pin.pinnedModelId ? "AI locked to one model" : "AI lock cleared", {
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
      return `Right now you are using ${pin.effectiveChatModel.displayName}`;
    }
    return "No chat model is active for you";
  };

  return (
    <>
      <Row
        name="Lock my own AI to one model"
        desc={`Only your account. A lock wins over the chat model picker and covers chat, voice and background work. ${effectiveDesc()}. To lock someone else, use People & access.`}
        control={
          <Select
            value={value}
            aria-label="Locked chat model"
            disabled={busy || (models.length === 0 && !value)}
            onChange={(event) => mutation.mutate(event.target.value || null)}
          >
            <option value="">Not locked</option>
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
          The locked model is unavailable or disabled. Chat is blocked until you clear the lock or
          the model is turned back on.
        </Note>
      ) : null}
      {models.length === 0 && !pinQuery.isLoading ? (
        <Note icon={<LockKeyholeOpen size={13} />}>
          No model that can chat is available to you yet.
        </Note>
      ) : null}
    </>
  );
}
