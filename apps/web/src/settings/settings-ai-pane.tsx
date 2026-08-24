import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, PencilLine, GitCommitHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getChatModelOverrideSettings,
  getYoloSettings,
  getPersonaSettings,
  previewPersona,
  putChatModelOverride,
  putYoloSelf,
  putPersonaSettings
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { useFeedback } from "./settings-feedback";
import {
  applyGuidedPersonaText,
  createPersonaDraft,
  discardPersonaDraft,
  personaDraftIsDirty,
  personaSample,
  type DirectnessDial,
  type HumorDial,
  type PersonaDials,
  type PersonaDraft,
  type PersonaSnapshot,
  type RecoveryDial,
  type ToneDial
} from "./settings-persona-preview";
import { type PaneProps } from "./settings-types";
import { Choice, Field, Group, Note, PaneHead, Row, Segmented, Select, Switch } from "./settings-ui";
import { Button } from "@moss/ui";

type PersonaState = PersonaDraft;

const DEFAULT_DESCRIPTION =
  "Be direct and a little dry: skip the pep talks. Hold me to commitments I've actually made, but ease off when I've had a rough day. Lead with what matters and keep it short.";
const DEFAULT_PERSONA_DIALS = {
  tone: "Warm",
  directness: "Balanced",
  humor: "Dry",
  recovery: "Encouraging"
} satisfies Pick<PersonaState, "tone" | "directness" | "humor" | "recovery">;

function initialPersona(): PersonaState {
  return createPersonaDraft(
    { assistantName: "Moss", personaText: DEFAULT_DESCRIPTION },
    DEFAULT_PERSONA_DIALS
  );
}

function Persona({ who }: { readonly who: string }) {
  const { toast } = useFeedback();
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const [p, setP] = useState<PersonaState>(initialPersona);
  const [saved, setSaved] = useState<PersonaSnapshot>(p);
  const [mode, setMode] = useState<"authored" | "guided">("authored");
  const [rev, setRev] = useState(0);
  const receivedInitialSnapshot = useRef(false);
  const set = <K extends keyof PersonaState>(k: K, v: PersonaState[K]) =>
    setP((s) => ({ ...s, [k]: v }));
  // Guided mode has no free-text editing happening alongside it, so a dial change can just
  // write the seeded text straight through instead of asking the user to confirm and apply it.
  const setDial = <K extends keyof PersonaDials>(k: K, v: PersonaDials[K]) =>
    setP((s) => {
      const next = { ...s, [k]: v };
      return applyGuidedPersonaText(next, next);
    });
  const personaQuery = useQuery({
    queryKey: queryKeys.settings.persona,
    queryFn: getPersonaSettings,
    retry: false
  });
  useEffect(() => {
    if (!personaQuery.data) return;
    if (receivedInitialSnapshot.current) return;
    const next = createPersonaDraft(personaQuery.data.persona, DEFAULT_PERSONA_DIALS);
    setP(next);
    setSaved(personaQuery.data.persona);
    receivedInitialSnapshot.current = true;
    setRev((r) => r + 1);
  }, [personaQuery.data]);
  const dirty = personaDraftIsDirty(p, saved);
  const sample = useMemo(() => personaSample(p, who), [p, who]);

  const saveMutation = useMutation({
    mutationFn: () =>
      putPersonaSettings({
        persona: {
          assistantName: p.assistantName,
          personaText: p.personaText
        }
      }),
    onSuccess: (result) => {
      const next: PersonaState = {
        assistantName: result.persona.assistantName,
        personaText: result.persona.personaText,
        tone: p.tone,
        directness: p.directness,
        humor: p.humor,
        recovery: p.recovery
      };
      setP(next);
      setSaved(result.persona);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.persona });
      toast("Persona saved. Your next briefing and replies will use this voice.", {
        icon: <GitCommitHorizontal size={17} />
      });
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : "Could not save persona");
    }
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewPersona({
        persona: {
          assistantName: p.assistantName,
          personaText: p.personaText
        }
      }),
    onError: (error) => {
      toast(error instanceof Error ? error.message : "Could not preview persona");
    }
  });

  const discard = () => {
    setP(discardPersonaDraft(saved, p));
    setRev((r) => r + 1);
  };
  const previewReply = previewMutation.data?.reply;

  return (
    <Group
      title="Persona"
      desc={`How ${assistantName} sounds and carries itself: write it yourself, or set it with the dials below. The preview shows the effect.`}
    >
      <Field
        label="Assistant name"
        hint="What you call your assistant. Used in chat and the briefing."
      >
        <input
          className="jds-input"
          value={p.assistantName}
          onChange={(e) => set("assistantName", e.target.value)}
          aria-label="Assistant name"
        />
      </Field>
      <Field label="How to set your persona" hint="Switching methods keeps your current draft.">
        <Segmented
          ariaLabel="How to set your persona"
          value={mode}
          options={[
            { value: "authored", label: "Write it yourself" },
            { value: "guided", label: "Use guided dials" }
          ]}
          onChange={setMode}
        />
      </Field>
      {mode === "authored" ? (
        <Field
          className="fld--no-border"
          label="In your own words"
          hint={`How should ${assistantName} interact with you? Its style, what to lean into, what to avoid.`}
        >
          <textarea
            className="jds-textarea"
            rows={3}
            value={p.personaText}
            onChange={(e) => set("personaText", e.target.value)}
            aria-label="Persona"
            placeholder="e.g. Be direct and a little dry. Skip the pep talks. Push me on commitments, but ease off on a rough day."
          />
        </Field>
      ) : (
        <>
          <Choice
            key={`tone${rev}`}
            className="fld--no-border"
            label="Tone"
            value={p.tone}
            options={["Warm", "Neutral", "Crisp"]}
            onChange={(v) => setDial("tone", v as ToneDial)}
          />
          <Choice
            key={`dir${rev}`}
            label="Directness"
            value={p.directness}
            options={["Gentle", "Balanced", "Direct"]}
            onChange={(v) => setDial("directness", v as DirectnessDial)}
          />
          <Choice
            key={`hum${rev}`}
            label="Humor"
            value={p.humor}
            options={["None", "Dry", "Playful"]}
            onChange={(v) => setDial("humor", v as HumorDial)}
          />
          <Choice
            key={`rec${rev}`}
            label="Recovery & accountability"
            hint={`How ${assistantName} responds when you fall behind. Never shaming: that's a promise of the product.`}
            value={p.recovery}
            options={["Encouraging", "Matter-of-fact", "Firm"]}
            onChange={(v) => setDial("recovery", v as RecoveryDial)}
          />
        </>
      )}

      <div className="ppv">
        <div className="ppv__hd">
          <GitCommitHorizontal size={13} aria-hidden="true" />
          How {p.assistantName || "Moss"} would sound
        </div>
        <div className="ppv__bubble ppv__bubble--main">
          <div className="ppv__cap">{previewReply ? "Response preview" : "Morning briefing"}</div>
          <p className="ppv__say">{previewReply ?? sample.greeting}</p>
        </div>
        {previewReply ? null : (
          <div className="ppv__bubble">
            <div className="ppv__cap">When you fall behind</div>
            <p className="ppv__say">{sample.recovery}</p>
          </div>
        )}
      </div>

      <div className={`psona-save${dirty ? " is-dirty" : ""}`}>
        <span className="psona-save__state">
          {dirty ? (
            <PencilLine size={14} aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
          {/* Named from the saved snapshot, not from useAssistantName(): this line acknowledges a
              save, so it must render from the record the save returned. The global hook is a
              separate query whose invalidation resolves a render after `dirty` clears, so reading it
              here shows the PREVIOUS name for a moment — the one case where the text is guaranteed
              to be read. `saved` comes straight off the mutation result. */}
          {dirty ? "Unsaved changes" : `Saved. This is ${saved.assistantName}'s current voice.`}
        </span>
        <span className="psona-save__acts">
          <Button
            variant="quiet"
            size="sm"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || personaQuery.isLoading}
          >
            {previewMutation.isPending ? "Previewing" : "Preview response"}
          </Button>
          {dirty ? (
            <Button variant="quiet" size="sm" onClick={discard}>
              Discard
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "Saving" : "Save persona"}
          </Button>
        </span>
      </div>
    </Group>
  );
}

function ChatModel() {
  const { toast } = useFeedback();
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const settingsQuery = useQuery({
    queryKey: queryKeys.ai.chatModelOverride,
    queryFn: getChatModelOverrideSettings,
    retry: false
  });
  const settings = settingsQuery.data?.settings;
  const mutation = useMutation({
    mutationFn: (modelId: string | null) => putChatModelOverride({ modelId }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.ai.chatModelOverride, result);
      const model = result.settings.effectiveOverrideModelId
        ? result.settings.selectedModel
        : result.settings.defaultModel;
      toast(`Chat now uses ${model?.displayName ?? "the instance default"}`, {
        icon: <GitCommitHorizontal size={17} />
      });
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : "Could not update chat model");
    }
  });
  const defaultModel = settings?.defaultModel ?? null;
  const selectableOverrideModels = settings?.selectableOverrideModels ?? [];
  const selectableIds = useMemo(
    () => new Set(selectableOverrideModels.map((m) => m.id)),
    [selectableOverrideModels]
  );
  const currentOverride =
    settings?.currentOverrideModelId && selectableIds.has(settings.currentOverrideModelId)
      ? settings.currentOverrideModelId
      : null;
  const value = currentOverride ?? "default";

  return (
    <Group
      title="Chat model"
      desc={`The assistant that answers when you chat with ${assistantName}. Admins manage providers and routing.`}
    >
      {defaultModel ? (
        <>
          {settings?.overrideEnabled ? (
            <Field
              label="Powering your chat"
              hint="Defaults to the instance routing your admin set. Override it to a specific model for your own conversations."
            >
              <Select
                value={value}
                disabled={mutation.isPending || settingsQuery.isLoading}
                onChange={(e) =>
                  mutation.mutate(e.target.value === "default" ? null : e.target.value)
                }
                aria-label="Chat model"
              >
                <option value="default">
                  Automatic (admin default) · {defaultModel.providerModelId}
                </option>
                {selectableOverrideModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.providerDisplayName} · {m.providerModelId}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Row
              name="Powering your chat"
              desc={`${defaultModel.providerDisplayName} · ${defaultModel.providerModelId} — Managed by admin.`}
            />
          )}
          <Note>
            Providers, credentials and which model handles each kind of work live in{" "}
            <b>Admin → Assistant &amp; AI</b>.
          </Note>
        </>
      ) : (
        <div className="ai-empty">
          <div className="ai-empty__ic">
            <GitCommitHorizontal size={20} aria-hidden="true" />
          </div>
          <div className="ai-empty__main">
            <div className="ai-empty__t">No assistant configured yet</div>
            <div className="ai-empty__d">
              An admin needs to add an AI provider before {assistantName} can chat. Ask whoever set
              up this instance. If that's you, add one under <b>Admin → Assistant &amp; AI</b>.
            </div>
          </div>
        </div>
      )}
    </Group>
  );
}

function YoloMode() {
  const { toast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const query = useQuery({
    queryKey: queryKeys.settings.yolo,
    queryFn: getYoloSettings,
    retry: false
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => putYoloSelf({ enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.yolo, data);
      toast(data.self.enabled ? "YOLO mode enabled" : "YOLO mode disabled");
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Could not update YOLO mode")
  });
  const state = query.data;
  if (!state?.self.allowed) return null;
  const enable = () =>
    confirm({
      title: "Enable YOLO mode?",
      description: `${assistantName} will perform actions, including permanent deletions, without asking. You accept responsibility.`,
      confirmLabel: "Enable YOLO",
      danger: true,
      onConfirm: () => mutation.mutate(true)
    });
  return (
    <Group
      title="YOLO mode"
      desc="Your personal approval preference for interactive chat. The instance owner controls whether it can take effect."
    >
      <Row
        name="Auto-approve actions"
        desc={
          state.instanceEnabled && state.self.enabled
            ? "Effective state: enabled for interactive chat. Background work still uses its own policy."
            : state.instanceEnabled
              ? "Effective state: inactive because your preference is off."
              : "Effective state: inactive because the instance owner has disabled YOLO. Your preference remains saved."
        }
        control={
          <Switch
            ariaLabel="Auto-approve actions"
            checked={state.self.enabled}
            disabled={mutation.isPending}
            onChange={(value) => (value ? enable() : mutation.mutate(false))}
          />
        }
      />
    </Group>
  );
}

export function AssistantPane({ me }: PaneProps) {
  const who = (me.user.name ?? "").split(/\s+/)[0] || "there";
  const assistantName = useAssistantName();
  return (
    <>
      <PaneHead
        title="Assistant & AI"
        desc={`Tune how ${assistantName} sounds, and choose which assistant powers your chat.`}
      />
      <Persona who={who} />
      <ChatModel />
      <YoloMode />
    </>
  );
}
