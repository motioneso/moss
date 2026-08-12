import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, GitCommitHorizontal, Lock } from "lucide-react";
import { useRef, useState } from "react";

import {
  getChatModelOverrideSettings,
  putChatModelOverride,
  switchChatProvider
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import type { AiConfiguredModelDto, ChatModelOverrideSettingsDto, ChatSurface } from "@moss/shared";
import "./chat-model-pill.css";

type ModelChoice = {
  readonly modelId: string | null;
  readonly model: AiConfiguredModelDto;
  readonly label: string;
  readonly providerLabel: string;
  readonly relation: "same-provider" | "cross-provider";
  readonly selected: boolean;
};

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
  const mutation = useMutation({
    mutationFn: async (vars: { readonly choice: ModelChoice; readonly surface: ChatSurface }) => {
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
        {active?.providerModelId ?? "Instance default"}
      </div>
    );
  }

  const selectChoice = (choice: ModelChoice) => {
    if (choice.selected || mutation.isPending || props.disabled) return;
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
      >
        <GitCommitHorizontal size={13} aria-hidden="true" />
        <span>{active?.providerModelId ?? "Instance default"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chatd-model__menu">
          {choices.map((choice) => (
            <button
              key={choice.modelId ?? "default"}
              type="button"
              disabled={props.disabled || mutation.isPending}
              onClick={() => {
                closeMenu();
                selectChoice(choice);
              }}
            >
              <span>
                <b>{choice.label}</b>
                <small>{choice.providerLabel}</small>
              </span>
              {choice.selected ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
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
    providerLabel: choice.model.providerDisplayName,
    relation:
      current?.providerConfigId && choice.model.providerConfigId === current.providerConfigId
        ? "same-provider"
        : "cross-provider",
    selected: choice.modelId === currentId
  }));
}
