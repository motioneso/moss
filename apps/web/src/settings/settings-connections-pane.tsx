import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";

import { listConnectorAccounts, listIntegrations } from "../api/client";
import { getNotesSource } from "../api/notes-client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { SettingsIntegrationsPane } from "./settings-integrations-pane";
import { ConnectedPane, SourcesPane } from "./settings-personal-data-panes";
import { PaneHead } from "./settings-ui";

/*
 * One pane for everything Moss reaches outside itself: email and other accounts, the notes
 * folder, and outside services. Each part keeps its own full-pane flows (connect an account,
 * choose a folder, configure a service). While one is open the other parts stay mounted but
 * hidden, so nothing loses its state.
 */
export function ConnectionsPane() {
  const assistantName = useAssistantName();
  const [searchParams] = useSearchParams();
  const [accountFlow, setAccountFlow] = useState(false);
  const [folderFlow, setFolderFlow] = useState(false);
  const onAccountFlow = useCallback((open: boolean) => setAccountFlow(open), []);
  const onFolderFlow = useCallback((open: boolean) => setFolderFlow(open), []);
  const serviceFlow = searchParams.get("integration") !== null;
  const anyFlow = accountFlow || folderFlow || serviceFlow;

  // Same queries the three parts use, so these counts share their cache and never disagree.
  const accountsQuery = useQuery({
    queryKey: queryKeys.connectors.accounts,
    queryFn: listConnectorAccounts,
    retry: false
  });
  const notesQuery = useQuery({
    queryKey: queryKeys.settings.notesSource,
    queryFn: getNotesSource,
    retry: false
  });
  const servicesQuery = useQuery({
    queryKey: queryKeys.integrations.list,
    queryFn: listIntegrations,
    retry: false
  });
  const accountCount = accountsQuery.data?.accounts.length;
  const serviceCount = servicesQuery.data?.integrations.length;
  const folderLinked = notesQuery.data ? notesQuery.data.path !== null : undefined;

  return (
    <>
      {anyFlow ? null : (
        <>
          <PaneHead
            title="Connections"
            desc={`Everything ${assistantName} can reach outside itself, and how each one is doing.`}
          />
          <dl className="conn__counts" aria-label="Connections at a glance">
            <div className="conn__count">
              <dd>{accountCount ?? "-"}</dd>
              <dt>{accountCount === 1 ? "Account" : "Accounts"}</dt>
            </div>
            <div className="conn__count">
              <dd>{folderLinked === undefined ? "-" : folderLinked ? "Linked" : "None"}</dd>
              <dt>Notes folder</dt>
            </div>
            <div className="conn__count">
              <dd>{serviceCount ?? "-"}</dd>
              <dt>{serviceCount === 1 ? "Service" : "Services"}</dt>
            </div>
          </dl>
        </>
      )}
      <div hidden={folderFlow || serviceFlow}>
        <ConnectedPane embedded onFlowChange={onAccountFlow} />
      </div>
      <div hidden={accountFlow || serviceFlow}>
        <SourcesPane embedded onFlowChange={onFolderFlow} />
      </div>
      <div hidden={accountFlow || folderFlow}>
        <SettingsIntegrationsPane embedded />
      </div>
    </>
  );
}
