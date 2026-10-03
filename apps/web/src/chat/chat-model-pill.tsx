import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitCommitHorizontal, Lock } from "lucide-react";
import { useRef, useState } from "react";

import {
  getChatModelFavorites,
  getChatSettings,
  getChatModelOverrideSettings,
  putChatModelFavorites,
  putChatModelOverride,
  putChatSettings,
  switchChatProvider
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import { ChatModelPickerMenu } from "./chat-model-picker-menu.js";
import {
  providerLabelFor,
  toggleFavoriteIds,
  type ModelChoice
} from "./chat-model-picker-model.js";
import type {
  AiConfiguredModelDto,
  ChatModelFavoritesDto,
  ChatModelOverrideSettingsDto,
  ChatSurface
} from "@moss/shared";
import "./chat-model-pill.css";

export function ChatModelPill(props: {
  readonly disabled: boolean;
  readonly privateMode: boolean;
  readonly surface: ChatSurface;
  readonly onCrossProviderSwitch: (surface: ChatSurface) => void;
}) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.ai.chatModelOverride,
    queryFn: getChatModelOverrideSettings,
    retry: false
  });
  const settings = settingsQuery.data?.settings;
  const choices = settings ? buildChatModelChoices(settings) : [];
  const active = activeChatModel(settings ?? null);
  const activeLabel = active?.displayName || active?.providerModelId || "Instance default";
  const locked = settings ? !settings.overrideEnabled : false;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const { ref: menuRef } = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: closeMenu
  });
  // Favorites are a convenience: a failed load shows the picker without them. Starring waits for
  // a successful load, because each save replaces the whole stored list.
  const favoritesQuery = useQuery({
    queryKey: queryKeys.ai.chatModelFavorites,
    queryFn: getChatModelFavorites,
    retry: false
  });
  const favoriteIds = favoritesQuery.data?.modelIds ?? [];
  const favoritesReady = favoritesQuery.isSuccess;

  // Saves share a scope so they reach the server in click order. Each one is built from the
  // optimistic list, so the last click wins. Refetch only once the queue drains, so an earlier
  // response cannot overwrite a later optimistic state; a failure refetches the stored list.
  const favoritesMutation = useMutation({
    mutationKey: queryKeys.ai.chatModelFavorites,
    scope: { id: "chat-model-favorites" },
    mutationFn: (modelIds: readonly string[]) => putChatModelFavorites({ modelIds }),
    onMutate: async (modelIds) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.ai.chatModelFavorites });
      queryClient.setQueryData<ChatModelFavoritesDto>(queryKeys.ai.chatModelFavorites, {
        modelIds
      });
    },
    onSettled: async (_data, error) => {
      const pending = queryClient.isMutating({ mutationKey: queryKeys.ai.chatModelFavorites });
      if (error || pending <= 1) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.ai.chatModelFavorites });
      }
    }
  });
  const toggleFavorite = (choice: ModelChoice) => {
    if (choice.modelId === null) return;
    const offeredIds = choices.flatMap((c) => (c.modelId === null ? [] : [c.modelId]));
    favoritesMutation.mutate(toggleFavoriteIds(favoriteIds, choice.modelId, offeredIds));
  };
  const mutation = useMutation({
    mutationFn: async (vars: { readonly choice: ModelChoice; readonly surface: ChatSurface }) => {
      // OpenCode is an ACP variant of the Codex route. Choosing a configured Codex model must
      // retire a previous OpenCode card choice before the next launch resolves its provider.
      if (vars.choice.model.providerKind === "openai-compatible") {
        const chatSettings = await getChatSettings();
        if (chatSettings.chat.openCodeModel !== undefined) {
          const cleared = await putChatSettings({
            chat: { responseStyle: chatSettings.chat.responseStyle }
          });
          queryClient.setQueryData(queryKeys.chat.settings, cleared);
        }
      }
      const result = await putChatModelOverride({ modelId: vars.choice.modelId });
      queryClient.setQueryData(queryKeys.ai.chatModelOverride, result);
      if (vars.choice.relation === "same-provider") {
        await switchChatProvider(vars.surface);
      } else {
        props.onCrossProviderSwitch(vars.surface);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.chatModelOverride }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(vars.surface) })
      ]);
    }
  });

  if (settingsQuery.isLoading) {
    return <div className="chatd-model chatd-model--muted">Model</div>;
  }
  if (!settings?.defaultModel) {
    return <div className="chatd-model chatd-model--muted">No model configured</div>;
  }
  if (locked || choices.length === 0) {
    return (
      <div className="chatd-model chatd-model--locked">
        <Lock size={13} aria-hidden="true" />
        {activeLabel}
      </div>
    );
  }

  const selectChoice = (choice: ModelChoice) => {
    if (
      (choice.selected && choice.model.providerKind !== "openai-compatible") ||
      mutation.isPending ||
      props.disabled
    )
      return;
    if (choice.relation === "cross-provider") {
      // COPY-TBD: final product copy can tune this native confirm text.
      const ok = window.confirm(
        props.privateMode
          ? "Switching providers starts a new chat and permanently destroys this private session."
          : "Switching providers starts a new chat. This conversation's context will not carry over."
      );
      if (!ok) return;
    } else if (props.privateMode) {
      const ok = window.confirm(
        "Switching models relaunches this private chat. Private context cannot be replayed."
      );
      if (!ok) return;
    }
    mutation.mutate({ choice, surface: props.surface });
  };

  return (
    <div className="chatd-model" ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        className="chatd-model__trigger"
        onClick={() => (open ? closeMenu() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Chat model: ${activeLabel}`}
      >
        <GitCommitHorizontal size={13} aria-hidden="true" />
        <span>{activeLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <ChatModelPickerMenu
          choices={choices}
          favoriteIds={favoriteIds}
          favoritesReady={favoritesReady}
          disabled={props.disabled || mutation.isPending}
          onPick={(choice) => {
            closeMenu();
            selectChoice(choice);
          }}
          onToggleFavorite={toggleFavorite}
        />
      ) : null}
    </div>
  );
}

export function activeChatModel(
  settings: ChatModelOverrideSettingsDto | null
): AiConfiguredModelDto | null {
  if (!settings) return null;
  return settings.effectiveOverrideModelId ? settings.selectedModel : settings.defaultModel;
}

export function buildChatModelChoices(settings: ChatModelOverrideSettingsDto): ModelChoice[] {
  const current = activeChatModel(settings);
  if (!settings.defaultModel) return [];
  const currentId = settings.currentOverrideModelId ?? null;
  const models: readonly { modelId: string | null; model: AiConfiguredModelDto; label: string }[] =
    [
      { modelId: null, model: settings.defaultModel, label: "Instance default" },
      ...settings.selectableOverrideModels.map((model) => ({
        modelId: model.id,
        model,
        label: model.displayName
      }))
    ];

  return models.map((choice) => ({
    ...choice,
    providerLabel: providerLabelFor(choice.model),
    relation:
      current?.providerConfigId && choice.model.providerConfigId === current.providerConfigId
        ? "same-provider"
        : "cross-provider",
    selected: choice.modelId === currentId
  }));
}
