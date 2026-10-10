import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { Button } from "@moss/ui";

import {
  getProactiveMonitoringSettings,
  patchProactiveMonitoringSettings
} from "../api/client-proactive.js";
import { listConnectorAccounts } from "../api/client.js";
import { getConnectorFeatureGrants } from "../api/connectors-client.js";
import { queryKeys } from "../api/query-keys.js";
import { QuietHoursEditor } from "./settings-quiet-hours-editor.js";
import type { PaneProps } from "./settings-types.js";
import { readError } from "./settings-types.js";
import { Group, Note, PaneHead, Row, Switch } from "./settings-ui.js";

export function AlertsPane({ onSelectSection }: PaneProps) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.proactiveMonitoring.settings,
    queryFn: getProactiveMonitoringSettings,
    retry: false
  });
  const accountsQuery = useQuery({
    queryKey: queryKeys.connectors.accounts,
    queryFn: listConnectorAccounts,
    retry: false
  });
  const save = useMutation({
    mutationFn: (automaticEmailAlerts: boolean) =>
      patchProactiveMonitoringSettings({ automaticEmailAlerts }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.proactiveMonitoring.settings, data)
  });
  const enabled = settingsQuery.data?.settings.automaticEmailAlerts ?? false;
  const emailAccounts =
    accountsQuery.data?.accounts.filter((account) =>
      account.scopes.some((scope) => scope.includes("gmail") || scope.includes("mail"))
    ) ?? [];
  const grantQueries = useQueries({
    queries: emailAccounts
      .filter((account) => account.status === "active")
      .map((account) => ({
        queryKey: queryKeys.connectors.featureGrants(account.id),
        queryFn: () => getConnectorFeatureGrants(account.id),
        retry: false
      }))
  });
  const accessError = accountsQuery.error ?? grantQueries.find((query) => query.error)?.error;
  const error = settingsQuery.error ?? save.error ?? accessError;
  const emailAvailable = grantQueries.some((query) => query.data?.email === true);
  const emailGrantDisabled = grantQueries.some(
    (query) => query.isSuccess && query.data?.email === false
  );
  const emailConnectionRevoked = emailAccounts.some((account) => account.status === "revoked");
  const emailAccessUnavailable =
    accountsQuery.isSuccess && !emailAvailable && !grantQueries.some((query) => query.isLoading);
  const retryError = () => {
    if (save.error && typeof save.variables === "boolean") return save.mutate(save.variables);
    if (accessError) {
      void accountsQuery.refetch();
      grantQueries.forEach((query) => void query.refetch());
      return;
    }
    void settingsQuery.refetch();
  };

  return (
    <>
      <PaneHead
        title="Alerts & quiet hours"
        desc="Choose which automatic updates Moss may check, and when interruptions wait."
      />
      <div className="alerts-pane__grid">
        <div>
          <Group
            title="Automatic email alerts"
            desc="Useful updates from connected email you did not ask Moss to watch."
          >
            <Row
              name="Automatic email alerts"
              desc="Turning this off never changes email access, requested work, or other sources."
              control={
                <Switch
                  ariaLabel="Automatic email alerts"
                  checked={enabled}
                  disabled={settingsQuery.isLoading || save.isPending}
                  onChange={(next) => save.mutate(next)}
                />
              }
            />
            {settingsQuery.isLoading ? <p role="status">Loading alert choice…</p> : null}
            {error ? (
              <Note icon={<Mail size={13} aria-hidden="true" />}>
                {readError(error)}{" "}
                <Button variant="link" size="sm" onClick={retryError}>
                  Try again
                </Button>
              </Note>
            ) : null}
            {emailAccessUnavailable ? (
              <Note icon={<Mail size={13} aria-hidden="true" />}>
                {emailGrantDisabled
                  ? "Email access is turned off for a connected account. Your alert choice is saved."
                  : emailConnectionRevoked
                    ? "An email connection was revoked. Your alert choice is saved."
                    : "No email can be checked until a connected account is active and permitted. Your alert choice is saved."}{" "}
                <Button variant="link" size="sm" onClick={() => onSelectSection?.("connections")}>
                  {emailGrantDisabled ? "Manage email access" : "Open connections"}
                </Button>
              </Note>
            ) : null}
          </Group>
          <Group title="Delivery" desc="These controls stay separate from automatic email alerts.">
            <Row
              name="Notifications and email digest"
              desc="Manage device delivery, module mutes, and scheduled email digests in Notifications."
              control={
                <Button variant="link" size="sm" onClick={() => onSelectSection?.("modules")}>
                  Manage
                </Button>
              }
            />
          </Group>
        </div>
        <div className="alerts-pane__quiet">
          <QuietHoursEditor />
        </div>
      </div>
    </>
  );
}
