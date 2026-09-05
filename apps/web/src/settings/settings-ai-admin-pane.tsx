import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  KeyRound,
  MinusCircle,
  Plus,
  GitCommitHorizontal,
  LogIn,
  Terminal,
  Trash2,
  Unlink,
  X
} from "lucide-react";
import { useState } from "react";

import { Button, IconButton } from "@moss/ui";
import {
  createAiProvider,
  getChatModelOverrideSettings,
  listAiModels,
  listAiProviders,
  listAiServiceBindings,
  lookupAiCapabilityRoute,
  putAdminChatModelOverrideEnabled,
  putAiServiceBinding,
  revokeAiProvider,
  setInstanceDefaultProvider,
  testAiProvider,
  updateAiModel,
  deleteAiModel,
  updateAiProvider
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Badge, Field, Group, Note, PaneHead, Row, Segmented, Select, Switch } from "./settings-ui";
import { MODEL_TIERS, TIERS } from "./settings-ai-edit-model-form";
import { ProviderModels } from "./settings-ai-provider-models";
import { TerminalModal } from "./terminal-modal";
import {
  ProviderLoginDialog,
  supportsAutomatedProviderLogin,
  type AutomatedLoginProvider
} from "./settings-provider-login-dialog";
import { ChatLockGroup } from "./settings-ai-chat-lock-group";
import { YoloAdminGroup } from "./settings-yolo-admin-group";
import { WebSearchKeyGroup } from "./settings-web-search-key-group";
import { VoiceConfigGroup } from "./settings-voice-config-group";
import {
  WORKSHOP_PLAN_SERVICE_KEY,
  isModuleServiceKey,
  type AiAuthMethod,
  type AiConfiguredModelDto,
  type AiModelCapability,
  type AiModelTier,
  type AiProviderConfigDto,
  type AiProviderExecutionMode,
  type AiProviderKind,
  type AiServiceBinding,
  type AiServiceKey
} from "@moss/shared";

const PROVIDER_CATALOG: readonly {
  readonly label: string;
  readonly kind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
}[] = [
  { label: "Anthropic", kind: "anthropic", authMethod: "cli" },
  { label: "OpenAI", kind: "openai-compatible", authMethod: "cli" },
  { label: "Google", kind: "google", authMethod: "cli" },
  { label: "Mistral", kind: "openai-compatible", authMethod: "api_key" },
  { label: "Local (Ollama)", kind: "ollama", authMethod: "api_key" },
  { label: "OpenAI-compatible", kind: "openai-compatible", authMethod: "api_key" },
  { label: "Custom", kind: "custom", authMethod: "api_key" }
];

// Chat and the strict email-extraction background service share the existing binding control. Voice
// stays on its dedicated endpoint; other worker capabilities remain automatic.
const SERVICE_ROWS: readonly {
  k: AiServiceKey;
  capability: AiModelCapability;
  name: string;
  desc: string;
  requireExplicitBinding?: boolean;
  requiredTier?: AiModelTier;
}[] = [
  {
    k: "chat",
    capability: "chat",
    name: "Chat & briefing",
    desc: "Everyday conversation and the daily reading voice."
  },
  {
    k: WORKSHOP_PLAN_SERVICE_KEY,
    capability: "json",
    name: "Workshop planning",
    desc: "Creates and revises Workshop plans. Requires a reasoning model; Chat lock takes precedence.",
    requiredTier: "reasoning"
  },
  {
    k: "module.connectors.email-extract",
    capability: "json",
    name: "Email extraction",
    desc: "Turns connected email into summaries and suggested actions.",
    requireExplicitBinding: true
  }
];

/* ----------------------------------------------------------- Provider card */

function ProviderCard(props: {
  readonly provider: AiProviderConfigDto;
  readonly models: readonly AiConfiguredModelDto[];
  readonly editing: boolean;
  readonly onEdit: (id: string | null) => void;
  readonly onAuth: (id: string, method: AiAuthMethod) => void;
  readonly onLogin: () => void;
  readonly onExecutionMode: (id: string, executionMode: AiProviderExecutionMode) => void;
  readonly onCredential: (id: string, input: { baseUrl: string; apiKey: string }) => void;
  readonly onModelOverride: (model: AiConfiguredModelDto, allowed: boolean) => void;
  readonly onModelStatusChange: (
    model: AiConfiguredModelDto,
    status: "active" | "disabled"
  ) => void;
  readonly onModelDelete: (model: AiConfiguredModelDto) => void;
  // #870/H1 Slice 1: instance-default flag + setter. The default provider is the one that resolves
  // the model for every mode-bound service; exactly one provider carries it instance-wide.
  readonly isInstanceDefault: boolean;
  readonly onSetInstanceDefault: () => void;
  readonly onRemove: () => void;
}) {
  const { provider } = props;
  const { toast } = useFeedback();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  // #1059 — a CLI-auth provider has no API key to credential-test; its Test action opens
  // a live owner-gated terminal onto the CLI instead of calling testMutation.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const canAutomateLogin = supportsAutomatedProviderLogin(provider);
  const testMutation = useMutation({
    mutationFn: () => testAiProvider(provider.id),
    onSuccess: ({ result }) =>
      toast(result.message, {
        tone: result.ok ? "ready" : "drift",
        icon: <Activity size={17} />
      }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  return (
    <div className="prov">
      <div className="prov__head">
        <span className="prov__mark">{provider.displayName[0]?.toUpperCase()}</span>
        <div className="prov__id">
          <div className="prov__name">
            {provider.displayName}
            <Badge tone="forest" dot>
              Connected
            </Badge>
            {/* #870/H1: one provider is the instance default that feeds mode-bound services. */}
            {props.isInstanceDefault ? (
              <Badge tone="amber" dot>
                Default
              </Badge>
            ) : (
              <Button variant="quiet" size="sm" onClick={props.onSetInstanceDefault}>
                Set as default
              </Button>
            )}
          </div>
          <div className="prov__auth">
            {provider.authMethod === "cli" ? (
              <Terminal size={12} aria-hidden="true" />
            ) : (
              <KeyRound size={12} aria-hidden="true" />
            )}
            {provider.authMethod === "cli"
              ? provider.cliAvailable
                ? `${provider.displayName} CLI`
                : `${provider.displayName} CLI unavailable`
              : provider.hasCredential
                ? "API key stored"
                : "API key needed"}
          </div>
        </div>
        <div className="prov__acts">
          {canAutomateLogin ? (
            <Button variant="quiet" size="sm" onClick={props.onLogin} icon={<LogIn size={14} />}>
              Log in
            </Button>
          ) : null}
          <Button
            variant="quiet"
            size="sm"
            disabled={provider.authMethod === "cli" ? false : testMutation.isPending}
            onClick={() =>
              provider.authMethod === "cli" ? setTerminalOpen(true) : testMutation.mutate()
            }
            icon={provider.authMethod === "cli" ? <Terminal size={14} /> : <Activity size={14} />}
          >
            {provider.authMethod === "cli"
              ? "Terminal"
              : testMutation.isPending
                ? "Testing"
                : "Test"}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => props.onEdit(props.editing ? null : provider.id)}
          >
            {props.editing ? "Done" : "Edit"}
          </Button>
          <IconButton
            size="sm"
            aria-label={`Remove ${provider.displayName}`}
            onClick={props.onRemove}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      {props.editing ? (
        <div className="prov__edit">
          <Field
            label="Authentication"
            hint="CLI uses an existing subscription — no key to manage. API key bills usage directly to the provider."
          >
            <Segmented<AiAuthMethod>
              value={provider.authMethod}
              options={[
                { value: "cli", label: "CLI subscription" },
                { value: "api_key", label: "API key" }
              ]}
              ariaLabel="Authentication method"
              onChange={(v) => props.onAuth(provider.id, v)}
            />
          </Field>
          <Field label="Execution mode">
            <Segmented<AiProviderExecutionMode>
              value={provider.executionMode}
              options={[
                { value: "interactive", label: "Interactive" },
                { value: "non_interactive", label: "Non-interactive" }
              ]}
              ariaLabel="Execution mode"
              onChange={(v) => props.onExecutionMode(provider.id, v)}
            />
          </Field>
          {provider.authMethod === "cli" ? (
            <div className="provcfg__cli">
              <span className="provcfg__cli-ic">
                <Terminal size={16} aria-hidden="true" />
              </span>
              <div className="provcfg__cli-main">
                <div className="provcfg__cli-t">Signed in via the {provider.displayName} CLI</div>
                <div className="provcfg__cli-d">
                  Routes through your authenticated subscription. No key stored.
                </div>
              </div>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => (canAutomateLogin ? props.onLogin() : setTerminalOpen(true))}
              >
                {canAutomateLogin ? "Re-authenticate" : "Use terminal to sign in"}
              </Button>
            </div>
          ) : (
            <>
              <Field label="Base URL" hint="Leave blank to use the provider's default endpoint.">
                <input
                  className="jds-input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.anthropic.com"
                  aria-label="Base URL"
                />
              </Field>
              <Field label="API key" hint="Stored encrypted. Never shown in briefings or logs.">
                <input
                  className="jds-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.hasCredential ? "•••••••• (stored)" : "sk-…"}
                  aria-label="API key"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!apiKey.trim() && !baseUrl.trim()}
                  onClick={() => {
                    props.onCredential(provider.id, {
                      baseUrl: baseUrl.trim(),
                      apiKey: apiKey.trim()
                    });
                    setApiKey("");
                  }}
                >
                  Save
                </Button>
              </Field>
            </>
          )}
        </div>
      ) : null}

      <ProviderModels
        provider={provider}
        models={props.models}
        onModelOverride={props.onModelOverride}
        onModelStatusChange={props.onModelStatusChange}
        onModelDelete={props.onModelDelete}
      />

      {/* #1059 — rendered outside .prov__edit so opening the terminal never depends on the
          card's edit-mode toggle; ProviderCard already destructures `provider` at the top. */}
      {terminalOpen ? (
        <TerminalModal provider={provider} onClose={() => setTerminalOpen(false)} />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- Service bindings */

// A binding is either a mode or a specific capable model. Strict background services start with an
// explicit unconfigured value instead of inheriting chat's default-provider route.
function ServiceRow(props: {
  readonly service: (typeof SERVICE_ROWS)[number];
  readonly binding: AiServiceBinding | undefined;
  readonly models: readonly AiConfiguredModelDto[];
  readonly providers: readonly AiProviderConfigDto[];
}) {
  const { toast } = useFeedback();
  const queryClient = useQueryClient();
  const routeQuery = useQuery({
    queryKey: queryKeys.ai.capability(props.service.capability),
    queryFn: () => lookupAiCapabilityRoute(props.service.capability),
    enabled: !props.service.requireExplicitBinding && !props.service.requiredTier,
    retry: false
  });

  const mutation = useMutation({
    mutationFn: (binding: AiServiceBinding) => putAiServiceBinding(props.service.k, { binding }),
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.serviceBindings }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.ai.capability(props.service.capability)
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
      ]);
      toast("Service updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  // Active models that can actually serve this service (a "model" binding must be capability-valid).
  const capableModels = props.models.filter((model) => {
    const provider = props.providers.find((candidate) => candidate.id === model.providerConfigId);
    const providerReady =
      provider?.status === "active" &&
      (provider.authMethod === "cli" ? provider.cliAvailable : provider.hasCredential);
    return (
      model.status === "active" &&
      model.providerStatus === "active" &&
      providerReady &&
      model.capabilities.includes(props.service.capability) &&
      (!props.service.requiredTier ||
        (model.tier === props.service.requiredTier &&
          model.providerModelId !== "default" &&
          provider.authMethod !== "cli"))
    );
  });

  // The <select> value encodes the binding kind: `mode:<tier>` or `model:<id>`.
  const binding = props.binding;
  const currentValue =
    binding?.kind === "model"
      ? `model:${binding.modelId}`
      : binding?.kind === "mode"
        ? `mode:${binding.tier}`
        : props.service.requireExplicitBinding
          ? ""
          : `mode:${props.service.requiredTier ?? "interactive"}`;

  const onChange = (raw: string) => {
    if (raw.startsWith("model:")) {
      mutation.mutate({ kind: "model", modelId: raw.slice("model:".length) });
    } else {
      mutation.mutate({ kind: "mode", tier: raw.slice("mode:".length) as AiModelTier });
    }
  };

  const route = routeQuery.data?.route;
  const boundModel =
    binding?.kind === "model"
      ? (capableModels.find((model) => model.id === binding.modelId) ?? null)
      : null;
  const needsConfig = props.service.requireExplicitBinding
    ? !binding || (binding.kind === "model" ? !boundModel : capableModels.length === 0)
    : route?.reason === "needs-config";
  const resolvedModel = props.service.requireExplicitBinding ? boundModel : (route?.model ?? null);
  const configuredMode =
    props.service.requireExplicitBinding && binding?.kind === "mode" && !needsConfig;

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">{props.service.name}</div>
        <div className="rt__desc">{props.service.desc}</div>
      </div>
      <div className="rt__pick">
        <Select
          value={currentValue}
          aria-label={`Binding for ${props.service.name}`}
          disabled={mutation.isPending}
          onChange={(event) => onChange(event.target.value)}
        >
          {props.service.requireExplicitBinding && !binding ? (
            <option value="" disabled>
              Choose a model or mode
            </option>
          ) : null}
          <optgroup
            label={
              isModuleServiceKey(props.service.k)
                ? "Mode (automatic routing)"
                : "Mode (uses the default provider)"
            }
          >
            {MODEL_TIERS.filter(
              (tier) =>
                !props.service.requiredTier ||
                tier === props.service.requiredTier ||
                currentValue === `mode:${tier}`
            ).map((tier) => (
              <option
                key={tier}
                value={`mode:${tier}`}
                disabled={Boolean(
                  props.service.requiredTier && tier !== props.service.requiredTier
                )}
              >
                {TIERS[tier].label}
              </option>
            ))}
          </optgroup>
          {binding?.kind === "model" && props.service.requiredTier && !boundModel ? (
            <option value={`model:${binding.modelId}`} disabled>
              Selected model needs configuration
            </option>
          ) : null}
          {capableModels.length ? (
            <optgroup label="Specific model">
              {capableModels.map((model) => (
                <option key={model.id} value={`model:${model.id}`}>
                  {model.displayName}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        {props.service.requiredTier ? (
          <span className="rt__none">Routing and connection checked when planning.</span>
        ) : needsConfig ? (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            Needs configuration
          </span>
        ) : resolvedModel ? (
          <div className="rt__resolved">
            {resolvedModel.providerModelId ?? resolvedModel.displayName}
          </div>
        ) : configuredMode ? (
          <div className="rt__resolved">Configured</div>
        ) : (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            No model resolved
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Web search */

/* ----------------------------------------------------------------- Pane */

export function AiProvidersPane() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const assistantName = useAssistantName();
  const [pick, setPick] = useState(false);
  const [credentialFor, setCredentialFor] = useState<(typeof PROVIDER_CATALOG)[number] | null>(
    null
  );
  const [pickBaseUrl, setPickBaseUrl] = useState("");
  const [pickApiKey, setPickApiKey] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [loginProvider, setLoginProvider] = useState<AutomatedLoginProvider | null>(null);
  const providersQuery = useQuery({
    queryKey: queryKeys.ai.providers,
    queryFn: listAiProviders,
    retry: false
  });
  const modelsQuery = useQuery({
    queryKey: queryKeys.ai.models,
    queryFn: listAiModels,
    retry: false
  });
  const serviceBindingsQuery = useQuery({
    queryKey: queryKeys.ai.serviceBindings,
    queryFn: listAiServiceBindings,
    retry: false
  });
  const overrideQuery = useQuery({
    queryKey: queryKeys.ai.chatModelOverride,
    queryFn: getChatModelOverrideSettings,
    retry: false
  });
  const providers = (providersQuery.data?.providers ?? []).filter((p) => p.status !== "revoked");
  const models = modelsQuery.data?.models ?? [];
  const connected = providers.map((p) => p.displayName);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.ai.providers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ai.models }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ai.chatModelOverride }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ai.serviceBindings }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ai.capabilities })
    ]);

  const createMutation = useMutation({
    mutationFn: (input: {
      option: (typeof PROVIDER_CATALOG)[number];
      baseUrl: string;
      apiKey: string;
    }) =>
      createAiProvider({
        providerKind: input.option.kind,
        displayName: input.option.label,
        authMethod: input.option.authMethod,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey ? { credentialPayload: { apiKey: input.apiKey } } : {})
      }),
    onSuccess: (_data, input) => {
      setPick(false);
      setCredentialFor(null);
      setPickBaseUrl("");
      setPickApiKey("");
      void invalidate();
      toast(`Added ${input.option.label}`, { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift", icon: <X size={17} /> })
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeAiProvider(id),
    onSuccess: () => {
      setEditId(null);
      void invalidate();
      toast("Provider removed", { tone: "drift", icon: <Unlink size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      patch: Parameters<typeof updateAiProvider>[1];
      message?: string;
    }) => updateAiProvider(input.id, input.patch),
    onSuccess: (_data, input) => {
      void invalidate();
      if (input.message) toast(input.message, { icon: <KeyRound size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const overrideToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => putAdminChatModelOverrideEnabled({ enabled }),
    onSuccess: () => {
      void invalidate();
      toast("Chat override setting updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const modelOverrideMutation = useMutation({
    mutationFn: (input: { model: AiConfiguredModelDto; allowed: boolean }) =>
      updateAiModel(input.model.id, { allowUserOverride: input.allowed }),
    onSuccess: (_data, input) => {
      void invalidate();
      toast(`${input.model.displayName} override access updated`, {
        icon: <GitCommitHorizontal size={17} />
      });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const modelStatusMutation = useMutation({
    mutationFn: (input: { model: AiConfiguredModelDto; status: "active" | "disabled" }) =>
      updateAiModel(input.model.id, { status: input.status }),
    onSuccess: (_data, input) => {
      void invalidate();
      const label = input.status === "disabled" ? "Model disabled" : "Model enabled";
      toast(label, { icon: <MinusCircle size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  // #2208 follow-up: Remove on a model row deletes it for good (after the confirm below).
  const modelDeleteMutation = useMutation({
    mutationFn: (model: AiConfiguredModelDto) => deleteAiModel(model.id),
    onSuccess: () => {
      void invalidate();
      toast("Model removed", { icon: <Trash2 size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  // #870/H1 Slice 1: the instance-default provider supplies the model for every mode-bound service
  // (Chat/Voice on a tier). Exactly one provider holds the flag instance-wide — the backend clears
  // any prior default in the same statement (partial unique index enforces the singleton), so the
  // UI just fires the set and re-reads.
  const instanceDefaultMutation = useMutation({
    mutationFn: (providerId: string) => setInstanceDefaultProvider(providerId),
    onSuccess: () => {
      void invalidate();
      toast("Default provider updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  return (
    <>
      <PaneHead
        title="Assistant & AI"
        desc={`The AI providers this instance runs on, and which model handles each kind of work. Everyone's ${assistantName} draws from what you set up here.`}
      />
      <Group
        title="User chat override"
        desc="Let each person choose which allowed chat-capable model answers their own conversations."
      >
        <Row
          name="Allow user override"
          desc="When off, Personal → Assistant & AI shows the instance default as read-only."
          control={
            <Switch
              ariaLabel="Allow users to override their chat model"
              checked={overrideQuery.data?.settings.overrideEnabled ?? false}
              disabled={overrideQuery.isLoading || overrideToggleMutation.isPending}
              onChange={(enabled) => overrideToggleMutation.mutate(enabled)}
            />
          }
        />
      </Group>
      <Group
        title="Providers"
        desc={`Add provider accounts for the whole instance. ${assistantName} reads each one's models automatically the moment it connects.`}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPick((x) => !x)}
            icon={<Plus size={15} />}
          >
            Add provider
          </Button>
        }
      >
        {providers.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty__ic">
              <GitCommitHorizontal size={20} aria-hidden="true" />
            </div>
            <div className="ai-empty__main">
              <div className="ai-empty__t">No providers yet</div>
              <div className="ai-empty__d">
                {assistantName} can't chat until at least one provider is added. Connect one to
                bring its models online for everyone on this instance.
              </div>
            </div>
          </div>
        ) : (
          <div className="prov-list">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                models={models.filter((m) => m.providerConfigId === provider.id)}
                editing={editId === provider.id}
                onEdit={setEditId}
                onAuth={(id, method) =>
                  updateMutation.mutate({ id, patch: { authMethod: method } })
                }
                onLogin={() => {
                  if (supportsAutomatedProviderLogin(provider)) setLoginProvider(provider);
                }}
                onExecutionMode={(id, executionMode) =>
                  updateMutation.mutate({ id, patch: { executionMode } })
                }
                onCredential={(id, { baseUrl, apiKey }) =>
                  updateMutation.mutate({
                    id,
                    patch: {
                      baseUrl: baseUrl || null,
                      ...(apiKey ? { credentialPayload: { apiKey } } : {})
                    },
                    message: `Credentials updated for ${provider.displayName}`
                  })
                }
                onModelOverride={(model, allowed) =>
                  modelOverrideMutation.mutate({ model, allowed })
                }
                onModelStatusChange={(model, status) =>
                  modelStatusMutation.mutate({ model, status })
                }
                onModelDelete={(model) =>
                  confirm({
                    title: `Remove ${model.providerModelId}?`,
                    description:
                      "The model is deleted from this provider. Any work bound to it falls back to another model.",
                    confirmLabel: "Remove",
                    danger: true,
                    onConfirm: () => modelDeleteMutation.mutate(model)
                  })
                }
                isInstanceDefault={provider.isInstanceDefault}
                onSetInstanceDefault={() => instanceDefaultMutation.mutate(provider.id)}
                onRemove={() =>
                  confirm({
                    title: `Remove ${provider.displayName}?`,
                    description: `${assistantName} stops using its models. Any work routed to them falls back to another added model.`,
                    confirmLabel: "Remove",
                    danger: true,
                    onConfirm: () => revokeMutation.mutate(provider.id)
                  })
                }
              />
            ))}
          </div>
        )}
        {pick ? (
          <div className="provpick">
            <div className="provpick__hd">
              {credentialFor ? `${credentialFor.label} credentials` : "Add a provider"}
            </div>
            {credentialFor ? (
              <>
                <Field label="Base URL" hint="Leave blank to use the provider's default endpoint.">
                  <input
                    className="jds-input"
                    value={pickBaseUrl}
                    onChange={(e) => setPickBaseUrl(e.target.value)}
                    placeholder="https://api.anthropic.com"
                    aria-label="Base URL"
                  />
                </Field>
                <Field label="API key" hint="Stored encrypted. Never shown in briefings or logs.">
                  <input
                    className="jds-input"
                    type="password"
                    value={pickApiKey}
                    onChange={(e) => setPickApiKey(e.target.value)}
                    placeholder="sk-…"
                    aria-label="API key"
                  />
                </Field>
                <div className="provpick__cred-acts">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!pickApiKey.trim()}
                    onClick={() =>
                      createMutation.mutate({
                        option: credentialFor,
                        baseUrl: pickBaseUrl.trim(),
                        apiKey: pickApiKey.trim()
                      })
                    }
                  >
                    Add
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => {
                      setCredentialFor(null);
                      setPickBaseUrl("");
                      setPickApiKey("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="provpick__grid">
                  {PROVIDER_CATALOG.map((option) => {
                    const has = connected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        className="provpick__item"
                        disabled={has}
                        onClick={() =>
                          option.authMethod === "cli"
                            ? createMutation.mutate({ option, baseUrl: "", apiKey: "" })
                            : setCredentialFor(option)
                        }
                      >
                        <span className="provpick__dot" />
                        {option.label}
                        {has ? <span className="provpick__on">Added</span> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="provpick__foot">
                  {assistantName} reads the available models from the provider automatically when it
                  connects.
                </div>
              </>
            )}
          </div>
        ) : null}
      </Group>

      {loginProvider ? (
        <ProviderLoginDialog
          provider={loginProvider}
          onClose={() => setLoginProvider(null)}
          onSuccess={() => {
            setLoginProvider(null);
            void invalidate();
            toast(`${loginProvider.displayName} connected`, {
              icon: <GitCommitHorizontal size={17} />
            });
          }}
        />
      ) : null}

      {providers.length ? (
        <Group
          title="Services"
          desc="Bind each listed service to a mode or a specific capable model. Unlisted AI work is routed automatically."
        >
          {SERVICE_ROWS.map((service) => (
            <ServiceRow
              key={service.k}
              service={service}
              binding={serviceBindingsQuery.data?.bindings[service.k]}
              models={models}
              providers={providers}
            />
          ))}
        </Group>
      ) : null}
      {/* #874: Voice (STT) is its own dedicated admin section, independent of the chat providers. */}
      <VoiceConfigGroup />
      <ChatLockGroup />
      <WebSearchKeyGroup />
      <YoloAdminGroup />
      <Note icon={<GitCommitHorizontal size={13} />}>
        Each person can override which model powers their own chat under{" "}
        <b>Personal → Assistant &amp; AI</b>. Background services follow the bindings above.
      </Note>
    </>
  );
}
