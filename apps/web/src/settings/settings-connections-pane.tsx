import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";

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

  return (
    <>
      {anyFlow ? null : (
        <PaneHead
          title="Connections"
          desc={`Everything ${assistantName} can reach outside itself, and how each one is doing.`}
        />
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
