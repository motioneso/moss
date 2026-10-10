// #3184: what the host Settings page shows for a module that declares its own settings page.
// It renders a link to that page and nothing else, so the module's switches and credential
// slots appear in exactly one place.
import { ArrowUpRight, SlidersHorizontal } from "lucide-react";

import { ModuleSub } from "./settings-module-subviews";
import { Group, Row } from "./settings-ui";

export function ModuleOwnPageLink(props: {
  readonly moduleName: string;
  readonly settingsPath: string;
  readonly onBack: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <ModuleSub
      icon={<SlidersHorizontal size={21} aria-hidden="true" />}
      name={props.moduleName}
      sub="This module has its own settings page"
      onBack={props.onBack}
    >
      <Group title="Settings">
        <Row
          name={`${props.moduleName} settings`}
          control={
            <button
              type="button"
              className="modrow__link"
              aria-label={`Open ${props.moduleName} settings`}
              onClick={() => props.onNavigate(props.settingsPath)}
            >
              Open <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          }
        />
      </Group>
    </ModuleSub>
  );
}
