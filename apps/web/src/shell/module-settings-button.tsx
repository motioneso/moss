import { Settings } from "lucide-react";
import { Link } from "react-router";
import { moduleSettingsHref } from "../settings/module-settings-deep-link.js";

export function ModuleSettingsButton(props: {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly className?: string;
}) {
  return (
    <Link
      to={moduleSettingsHref(props.moduleId)}
      className={`topbar-settings-button jds-iconbtn jds-iconbtn--sm ${props.className ?? ""}`.trim()}
      aria-label={`${props.moduleName} settings`}
      title={`${props.moduleName} settings`}
    >
      <Settings size={15} aria-hidden="true" />
    </Link>
  );
}
