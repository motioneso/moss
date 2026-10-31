import { type ReactNode } from "react";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /* Buttons or links, centred under the text with the standard gap between controls. Children land in the same slot, after the actions. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

/* True when the node would render something, mirroring what React skips. */
function hasContent(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === "boolean" || node === "") {
    return false;
  }
  if (Array.isArray(node)) return node.some(hasContent);
  return true;
}

export function EmptyState({ icon, title, description, actions, children }: EmptyStateProps) {
  return (
    <div className="jds-empty">
      {icon ? <span className="jds-empty__mark">{icon}</span> : null}
      <div className="jds-empty__title">{title}</div>
      {description ? <div className="jds-empty__sub">{description}</div> : null}
      {hasContent(actions) || hasContent(children) ? (
        <div className="jds-empty__actions">
          {actions}
          {children}
        </div>
      ) : null}
    </div>
  );
}
