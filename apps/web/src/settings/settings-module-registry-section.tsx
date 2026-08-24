// #964: registry-backed module distribution — install/update/remove from the admin
// Instance-modules pane. Functional pass only: reuses jds primitives; visual design
// is a later annotation round. All states come from the server-derived
// ModuleRegistryRowDto.state (spec §8) — no client-side state math beyond labels.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@moss/ui";
import type { ExternalModuleDto, ModuleRegistryRowDto } from "@moss/shared";

import {
  cancelModulePurge,
  downloadRegistryModule,
  getModuleRegistry,
  removeRegistryModule
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { ModuleCredentialsSection } from "./module-credentials-section.js";
import { useFeedback } from "./settings-feedback.js";
import { readError } from "./settings-types.js";
import { Note, Row, Switch } from "./settings-ui.js";

// #996/#860: props threaded down from InstanceModulesPane (Task 12) so an installed
// registry row can reuse the same setExternalModuleEnabled mutation the External-modules
// group already owns — no new API surface, just a second place to flip the same switch.
export interface ModuleRegistrySectionProps {
  readonly externalModules: readonly ExternalModuleDto[] | undefined;
  readonly onSetEnabled: (id: string, enabled: boolean) => void;
  readonly settingEnabledPending: boolean;
}

const STATE_LABELS: Record<ModuleRegistryRowDto["state"], string> = {
  "not-installed": "Not installed",
  "pending-restart": "Downloaded — restart to apply",
  "installed-enabled": "Installed",
  "installed-disabled": "Installed (disabled)",
  "update-available": "Update available",
  "update-pending-restart": "Update downloaded. Restart to apply.",
  "install-failed": "Install failed",
  "declared-not-present": "Declared in compose — will install on restart",
  incompatible: "Incompatible with this Moss version"
};

// #1187 decision 4: lead the pre-download confirm with a plain consequence sentence built
// from the DTO's structured fields (permissions are open-vocabulary and module-defined, so a
// permission-id -> phrase table would misrepresent unknown ids), then keep the raw permission
// ids as a supporting detail sentence — preserves full risk info, doesn't invent translations.
// `capabilities` is null when the row is local-only (not present in the registry index, e.g.
// `declared-not-present`) — those states never route through here since `canInstall` still
// allows a download attempt, so guard rather than assume presence.
export function describeCapabilityConsequences(row: ModuleRegistryRowDto): string {
  const caps = row.capabilities;
  if (!caps)
    return "No capability information is available yet. The download applies on the next restart.";
  const consequences: string[] = [];
  if (caps.fetchHosts.length) consequences.push("connect to the internet");
  if (caps.tools.some((tool) => tool.risk !== "read"))
    consequences.push("take actions that change data or send requests");
  if (caps.ownsTables.length) consequences.push("store its own data");
  const consequenceSentence = consequences.length
    ? `This module can ${consequences.join(", ")}.`
    : "This module makes no outside connections and stores no data.";
  const permissionDetail = caps.permissions.length
    ? `Requested permissions: ${caps.permissions.join(", ")}.`
    : "No specific permissions requested.";
  return `${consequenceSentence} ${permissionDetail} The download applies on the next restart.`;
}

// #1187 decision 2: one admin-actionable control per row instead of a Required badge or a
// non-actionable text row. `reason` carries the existing truthful disabled-reason/error text
// that used to render as a separate <p> for install-failed/incompatible states.
export interface LibraryAction {
  readonly kind: "install" | "switch" | "none";
  readonly label: string;
  readonly reason?: string;
}

export function libraryAction(row: ModuleRegistryRowDto): LibraryAction {
  if (row.purgePending) {
    return {
      kind: "none",
      label: "Purge pending",
      reason: "Data purge pending — takes effect on restart."
    };
  }
  switch (row.state) {
    case "not-installed":
    case "declared-not-present":
      return { kind: "install", label: "Download and install" };
    case "installed-disabled":
      // Switch only wired when the row is registry-index-backed (latestVersion set) —
      // matches the pre-existing gating on the enable/disable mutation below.
      return row.latestVersion != null
        ? { kind: "switch", label: "Enable" }
        : { kind: "none", label: STATE_LABELS["installed-disabled"] };
    case "installed-enabled":
      return row.latestVersion != null
        ? { kind: "switch", label: "Disable" }
        : { kind: "none", label: STATE_LABELS["installed-enabled"] };
    case "update-available":
      return { kind: "install", label: "Download update" };
    case "update-pending-restart":
      return { kind: "none", label: STATE_LABELS["update-pending-restart"] };
    case "pending-restart":
      return { kind: "none", label: STATE_LABELS["pending-restart"] };
    case "install-failed":
      return {
        kind: "install",
        label: "Retry download",
        reason: row.lastInstallError ?? undefined
      };
    case "incompatible":
      return {
        kind: "none",
        label: STATE_LABELS.incompatible,
        reason: row.requiresCore ? `Requires Moss ${row.requiresCore}.` : undefined
      };
  }
}

export function ModuleRegistrySection({
  externalModules,
  onSetEnabled,
  settingEnabledPending
}: ModuleRegistrySectionProps) {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();

  const registryQuery = useQuery({
    queryKey: queryKeys.settings.adminModuleRegistry,
    queryFn: () => getModuleRegistry(false),
    retry: false
  });

  const invalidate = () =>
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.adminModuleRegistry }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.adminExternalModules })
    ]);

  const downloadMutation = useMutation({
    mutationFn: (input: { id: string; version?: string }) =>
      downloadRegistryModule(input.id, input.version),
    onSuccess: (result) => {
      invalidate();
      toast(`${result.module.name} downloaded — restart Moss to apply`, { tone: "ready" });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const removeMutation = useMutation({
    mutationFn: (input: { id: string; purgeData: boolean }) =>
      removeRegistryModule(input.id, input.purgeData),
    onSuccess: (result, input) => {
      invalidate();
      toast(
        input.purgeData
          ? `${result.module.id} removed — data purge runs on next restart`
          : `${result.module.id} removed — its data is kept`,
        { tone: "ready" }
      );
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const cancelPurgeMutation = useMutation({
    mutationFn: (id: string) => cancelModulePurge(id),
    onSuccess: () => {
      invalidate();
      toast("Purge cancelled", { tone: "ready" });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const refreshMutation = useMutation({
    mutationFn: () => getModuleRegistry(true),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.settings.adminModuleRegistry, data),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const onInstall = (row: ModuleRegistryRowDto) => {
    confirm({
      title:
        row.state === "update-available"
          ? `Update ${row.name} to v${row.latestVersion}?`
          : `Install ${row.name}?`,
      description: describeCapabilityConsequences(row),
      confirmLabel: row.state === "update-available" ? "Download update" : "Download",
      onConfirm: () => downloadMutation.mutate({ id: row.id })
    });
  };

  const onRemove = (row: ModuleRegistryRowDto) => {
    confirm({
      title: `Remove ${row.name}?`,
      description:
        "The module stops on next restart and its files are deleted. Its data is kept " +
        "and comes back if you reinstall. To also destroy its data, use “Remove + purge”.",
      confirmLabel: "Remove, keep data",
      onConfirm: () => removeMutation.mutate({ id: row.id, purgeData: false })
    });
  };

  const onRemovePurge = (row: ModuleRegistryRowDto) => {
    confirm({
      title: `Remove ${row.name} and destroy its data?`,
      description:
        "This permanently deletes every table and record the module owns on the next " +
        "restart. There is no undo after the restart runs.",
      confirmLabel: "Remove + purge data",
      danger: true,
      requireText: row.id,
      onConfirm: () => removeMutation.mutate({ id: row.id, purgeData: true })
    });
  };

  const data = registryQuery.data;
  if (registryQuery.isPending) return <p className="jds-caption">Loading module registry…</p>;
  if (registryQuery.isError) return <p className="jds-caption">{readError(registryQuery.error)}</p>;
  if (!data || !data.enabled) return null;

  const canRemove = (row: ModuleRegistryRowDto) =>
    row.state !== "not-installed" && row.state !== "declared-not-present" && !row.purgePending;
  // #1187 decision 2: `libraryAction` governs the PRIMARY control only (button/switch/text).
  // This switch-visibility gate is an orthogonal, pre-existing (#996/#860) concern that can
  // appear alongside an install button (update-available) or alongside no button at all
  // (update-pending-restart) — unchanged from the pre-#1187 behavior.
  const showEnableSwitch = (row: ModuleRegistryRowDto) =>
    row.latestVersion != null &&
    (row.state === "installed-enabled" ||
      row.state === "installed-disabled" ||
      row.state === "update-available" ||
      row.state === "update-pending-restart");

  return (
    <>
      {data.registryUnavailable ? (
        <p className="jds-caption">
          The module registry is unreachable — showing installed modules only.
        </p>
      ) : null}
      {data.modules.some(
        (row) => row.state === "pending-restart" || row.state === "update-pending-restart"
      ) ? (
        <Note>
          Downloaded modules apply on the next restart. From your deployment directory:{" "}
          <code>{"docker compose restart jarv1s"}</code> to apply now, or restart the container the
          next time you deploy.
        </Note>
      ) : null}
      <Button
        variant="quiet"
        onClick={() => refreshMutation.mutate()}
        disabled={refreshMutation.isPending}
      >
        {refreshMutation.isPending ? "Refreshing…" : "Refresh from registry"}
      </Button>
      {data.modules.map((row) => {
        const action = libraryAction(row);
        return (
          <div key={row.id}>
            <Row
              name={row.name}
              desc={
                <>
                  {row.installedVersion || row.latestVersion ? (
                    <div>
                      {row.installedVersion ? `v${row.installedVersion}` : null}
                      {row.latestVersion && row.latestVersion !== row.installedVersion
                        ? ` (latest v${row.latestVersion})`
                        : null}
                    </div>
                  ) : null}
                  {row.description ? <div>{row.description}</div> : null}
                  {action.reason ? <div className="jds-caption">{action.reason}</div> : null}
                </>
              }
              control={
                <div className="regrow-controls">
                  {action.kind === "install" ? (
                    <Button onClick={() => onInstall(row)} disabled={downloadMutation.isPending}>
                      {action.label}
                    </Button>
                  ) : action.kind === "none" ? (
                    <span className="jds-caption">{action.label}</span>
                  ) : null}
                  {canRemove(row) ? (
                    <>
                      <Button variant="quiet" onClick={() => onRemove(row)}>
                        Remove
                      </Button>
                      <Button variant="quiet" onClick={() => onRemovePurge(row)}>
                        Remove + purge
                      </Button>
                    </>
                  ) : null}
                  {row.purgePending ? (
                    <Button
                      variant="quiet"
                      onClick={() => cancelPurgeMutation.mutate(row.id)}
                      disabled={cancelPurgeMutation.isPending}
                    >
                      Cancel purge
                    </Button>
                  ) : null}
                  {showEnableSwitch(row) ? (
                    <Switch
                      ariaLabel={`Enable ${row.name}`}
                      checked={
                        (externalModules?.find((module) => module.id === row.id)?.status ??
                          null) === "enabled"
                      }
                      disabled={settingEnabledPending}
                      onChange={(value) => onSetEnabled(row.id, value)}
                    />
                  ) : null}
                </div>
              }
            />
            {/* #918: instance-scope credential slots declared by this module's manifest, if
                any — renders nothing when the module has none. */}
            {showEnableSwitch(row) ? (
              <ModuleCredentialsSection moduleId={row.id} surface="admin" />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
