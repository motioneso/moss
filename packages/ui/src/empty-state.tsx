import { type ReactNode } from "react";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /* Buttons or links, centred under the text with the standard gap between controls. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

export function EmptyState({ icon, title, description, actions, children }: EmptyStateProps) {
  return (
    <div className="jds-empty">
      {icon ? <span className="jds-empty__mark">{icon}</span> : null}
      <div className="jds-empty__title">{title}</div>
      {description ? <div className="jds-empty__sub">{description}</div> : null}
      {actions ? <div className="jds-empty__actions">{actions}</div> : null}
      {children}
    </div>
  );
}
