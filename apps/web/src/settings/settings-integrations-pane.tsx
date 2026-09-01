import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";

import type {
  CredentialPlacementKind,
  IntegrationDetail,
  IntegrationKind,
  IntegrationSummary
} from "@moss/shared";
import { Button, Segmented, Select } from "@moss/ui";

import {
  ApiError,
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  refreshIntegration,
  updateIntegration
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Badge, Field, Group, Note, PaneHead, Row, Switch } from "./settings-ui";

export function SettingsIntegrationsPane() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("integration"); // null | "new" | id
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const listQuery = useQuery({
    queryKey: queryKeys.integrations.list,
    queryFn: listIntegrations,
    retry: false
  });

  const openIntegration = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("integration", id);
    setSearchParams(next);
  };
  const closeToList = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("integration");
    setSearchParams(next, { replace: true });
  };

  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      updateIntegration(input.id, { enabled: input.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.integrations.list }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  if (view === "new") return <AddIntegrationView onDone={openIntegration} onCancel={closeToList} />;
  if (view) return <IntegrationDetailView id={view} onBack={closeToList} />;

  const integrations = listQuery.data?.integrations ?? [];

  return (
    <>
      <PaneHead title="Integrations" />
      <Group
        title="Connections"
        action={
          <Button variant="secondary" size="sm" onClick={() => openIntegration("new")}>
            Add connection
          </Button>
        }
      >
        {integrations.length === 0 ? (
          <Row name="No connections yet." />
        ) : (
          integrations.map((integration) => (
            <IntegrationRow
              key={integration.id}
              integration={integration}
              onToggle={(enabled) => toggleMutation.mutate({ id: integration.id, enabled })}
              onConfigure={() => openIntegration(integration.id)}
            />
          ))
        )}
      </Group>
    </>
  );
}

function IntegrationRow(props: {
  readonly integration: IntegrationSummary;
  readonly onToggle: (enabled: boolean) => void;
  readonly onConfigure: () => void;
}) {
  const { integration } = props;
  const status = !integration.enabled ? "Off" : integration.lastError ? "Error" : "Connected";
  const statusTone = status === "Connected" ? "forest" : status === "Error" ? "red" : "neutral";
  let host = integration.url;
  try {
    host = new URL(integration.url).host || integration.url;
  } catch {
    // keep raw url when it doesn't parse
  }

  return (
    <Row
      name={
        <span className="intg__name">
          {integration.name}
          <Badge tone={integration.kind === "mcp" ? "steel" : "amber"}>
            {integration.kind === "mcp" ? "MCP" : "API"}
          </Badge>
        </span>
      }
      desc={
        <span className="intg__status">
          {host}
          <Badge tone={statusTone}>{status}</Badge>
          {`${integration.enabledToolCount} tools on`}
        </span>
      }
      control={
        <span className="intg__controls">
          <Switch
            ariaLabel={`Enable ${integration.name}`}
            checked={integration.enabled}
            onChange={props.onToggle}
          />
          <Button variant="quiet" size="sm" onClick={props.onConfigure}>
            Configure
          </Button>
        </span>
      }
    />
  );
}

function withMember(list: readonly string[], value: string, member: boolean): string[] {
  const set = new Set(list);
  if (member) set.add(value);
  else set.delete(value);
  return [...set];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function IntegrationDetailView(props: { readonly id: string; readonly onBack: () => void }) {
  const { id, onBack } = props;
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();

  const detailQuery = useQuery({
    queryKey: queryKeys.integrations.detail(id),
    queryFn: () => getIntegration(id),
    retry: false
  });

  const invalidateDetail = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.integrations.detail(id) });
  const invalidateList = () => queryClient.invalidateQueries({ queryKey: queryKeys.integrations.list });

  const refreshMutation = useMutation({
    mutationFn: () => refreshIntegration(id),
    onSuccess: () => {
      invalidateDetail();
      invalidateList();
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const removeMutation = useMutation({
    mutationFn: () => deleteIntegration(id),
    onSuccess: () => {
      invalidateList();
      onBack();
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const curationMutation = useMutation({
    mutationFn: (body: {
      enabledGroups?: readonly string[];
      enabledTools?: readonly string[];
      mutedTools?: readonly string[];
    }) => updateIntegration(id, body),
    onSuccess: () => invalidateDetail(),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const onRemove = () => {
    confirm({
      title: "Remove connection?",
      description: "Its tools disappear from chat.",
      confirmLabel: "Remove",
      onConfirm: () => removeMutation.mutate()
    });
  };

  const backLink = (
    <button type="button" className="gflow__back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />
      Back to integrations
    </button>
  );

  if (detailQuery.isError) {
    const notFound = detailQuery.error instanceof ApiError && detailQuery.error.status === 404;
    return (
      <>
        <PaneHead title="Integrations" />
        <div className="gflow">
          {backLink}
          <Note>{notFound ? "Connection not found." : readError(detailQuery.error)}</Note>
        </div>
      </>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <>
        <PaneHead title="Integrations" />
        {backLink}
      </>
    );
  }

  const status = !detail.enabled ? "Off" : detail.lastError ? "Error" : "Connected";
  const statusTone = status === "Connected" ? "forest" : status === "Error" ? "red" : "neutral";

  const toggleMute = (toolName: string, unmuted: boolean) => {
    curationMutation.mutate({ mutedTools: withMember(detail.mutedTools, toolName, !unmuted) });
  };

  const toggleGroup = (groupName: string, enabled: boolean) => {
    curationMutation.mutate({ enabledGroups: withMember(detail.enabledGroups, groupName, enabled) });
  };

  const toggleExplicitTool = (toolName: string, enabled: boolean) => {
    if (enabled) {
      curationMutation.mutate({
        enabledTools: withMember(detail.enabledTools, toolName, true),
        mutedTools: withMember(detail.mutedTools, toolName, false)
      });
    } else {
      curationMutation.mutate({ enabledTools: withMember(detail.enabledTools, toolName, false) });
    }
  };

  return (
    <>
      <PaneHead title="Integrations" />
      <div className="gflow">
        {backLink}
        <Group
          title={
            <span className="intg__name">
              {detail.name}
              <Badge tone={detail.kind === "mcp" ? "steel" : "amber"}>
                {detail.kind === "mcp" ? "MCP" : "API"}
              </Badge>
            </span>
          }
          desc={hostOf(detail.url)}
          action={
            <span className="intg__controls">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
              >
                Refresh
              </Button>
              <Button variant="quiet" size="sm" onClick={onRemove}>
                Remove
              </Button>
            </span>
          }
        >
          <Row
            name="Status"
            desc={`${detail.enabledToolCount} tools on`}
            control={<Badge tone={statusTone}>{status}</Badge>}
          />
          {detail.lastError ? (
            <span className="intg__controls">
              <Note>{detail.lastError}</Note>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
              >
                Refresh
              </Button>
            </span>
          ) : null}
        </Group>
        {detail.groupOptIn ? (
          <IntegrationGroupedTools
            detail={detail}
            onToggleGroup={toggleGroup}
            onToggleMute={toggleMute}
            onToggleExplicitTool={toggleExplicitTool}
          />
        ) : (
          <Group title="Tools">
            {detail.tools.map((tool) => (
              <Row
                key={tool.name}
                name={tool.name}
                desc={tool.description}
                control={
                  <Switch
                    ariaLabel={`Enable ${tool.name}`}
                    checked={!detail.mutedTools.includes(tool.name)}
                    onChange={(checked) => toggleMute(tool.name, checked)}
                  />
                }
              />
            ))}
          </Group>
        )}
      </div>
    </>
  );
}

function IntegrationGroupedTools(props: {
  readonly detail: IntegrationDetail;
  readonly onToggleGroup: (groupName: string, enabled: boolean) => void;
  readonly onToggleMute: (toolName: string, unmuted: boolean) => void;
  readonly onToggleExplicitTool: (toolName: string, enabled: boolean) => void;
}) {
  const { detail } = props;
  const showOptInNote = detail.enabledGroups.length === 0;

  return (
    <>
      {showOptInNote ? <Note>Groups start off. Turn on the ones Moss should use.</Note> : null}
      {detail.groups.map((group) => {
        const groupEnabled = detail.enabledGroups.includes(group.name);
        return (
          <Group
            key={group.name}
            title={`${group.name} (${group.toolCount})`}
            action={
              <Switch
                ariaLabel={`Enable group ${group.name}`}
                checked={groupEnabled}
                onChange={(checked) => props.onToggleGroup(group.name, checked)}
              />
            }
          >
            {detail.tools
              .filter((tool) => tool.group === group.name)
              .map((tool) => {
                const muted = detail.mutedTools.includes(tool.name);
                const explicit = detail.enabledTools.includes(tool.name);
                const checked = groupEnabled ? !muted : explicit && !muted;
                return (
                  <Row
                    key={tool.name}
                    name={tool.name}
                    desc={tool.description}
                    control={
                      <Switch
                        ariaLabel={`Enable ${tool.name}`}
                        checked={checked}
                        onChange={(next) =>
                          groupEnabled
                            ? props.onToggleMute(tool.name, next)
                            : props.onToggleExplicitTool(tool.name, next)
                        }
                      />
                    }
                  />
                );
              })}
          </Group>
        );
      })}
    </>
  );
}

const PLACEMENT_OPTIONS: readonly { value: CredentialPlacementKind; label: string }[] = [
  { value: "bearer", label: "Bearer token" },
  { value: "header", label: "Header" },
  { value: "query", label: "Query parameter" }
];

function AddIntegrationView(props: {
  readonly onDone: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<IntegrationKind>("mcp");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [placement, setPlacement] = useState<CredentialPlacementKind>("header");
  const [placementName, setPlacementName] = useState("X-Api-Key");
  const [showSpec, setShowSpec] = useState(false);
  const [spec, setSpec] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createIntegration({
        name: name.trim(),
        kind,
        url: url.trim(),
        spec: kind === "openapi" && showSpec && spec.trim() ? spec : undefined,
        credential: credential.trim() || undefined,
        credentialPlacement:
          kind === "openapi"
            ? placement === "bearer"
              ? { kind: placement }
              : { kind: placement, name: placementName.trim() }
            : undefined
      }),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrations.list });
      props.onDone(detail.id);
    },
    onError: (error) => setFormError(readError(error))
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    createMutation.mutate();
  };

  const needsPlacementName = kind === "openapi" && placement !== "bearer";
  const canSubmit =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    (!showSpec || spec.trim().length > 0);

  return (
    <>
      <PaneHead title="Integrations" />
      <Group title="Add connection">
        <form className="intg__form" onSubmit={submit}>
          <div className="fld">
            <div className="fld__row">
              <Segmented<IntegrationKind>
                value={kind}
                options={[
                  { value: "mcp", label: "MCP server" },
                  { value: "openapi", label: "API" }
                ]}
                ariaLabel="Kind"
                onChange={setKind}
              />
            </div>
          </div>
          <Field label="Name">
            <input
              className="jds-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Name"
            />
          </Field>
          <Field label="URL">
            <input
              className="jds-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="URL"
            />
          </Field>
          <Field label="Credential">
            <input
              className="jds-input"
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              aria-label="Credential"
            />
          </Field>
          {kind === "openapi" ? (
            <Field label="Send as">
              <Select
                value={placement}
                aria-label="Send as"
                onChange={(e) => setPlacement(e.target.value as CredentialPlacementKind)}
              >
                {PLACEMENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {needsPlacementName ? (
            <Field label={placement === "header" ? "Header name" : "Parameter name"}>
              <input
                className="jds-input"
                value={placementName}
                onChange={(e) => setPlacementName(e.target.value)}
                aria-label={placement === "header" ? "Header name" : "Parameter name"}
              />
            </Field>
          ) : null}
          {kind === "openapi" && !showSpec ? (
            <button type="button" className="intg__spec-link" onClick={() => setShowSpec(true)}>
              Paste the spec
            </button>
          ) : null}
          {kind === "openapi" && showSpec ? (
            <Field label="Spec">
              <textarea
                className="jds-textarea"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                aria-label="Spec"
              />
            </Field>
          ) : null}
          {formError ? <Note>{formError}</Note> : null}
          <Note>Credentials are encrypted and never shown again.</Note>
          <div className="intg__acts">
            <Button type="submit" size="sm" disabled={!canSubmit || createMutation.isPending}>
              Connect
            </Button>
            <Button variant="quiet" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </Group>
    </>
  );
}
