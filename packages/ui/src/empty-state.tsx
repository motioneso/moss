import { Children, type ReactNode } from "react";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}

export function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="jds-empty">
      {icon ? <span className="jds-empty__mark">{icon}</span> : null}
      <div className="jds-empty__title">{title}</div>
      {description ? <div className="jds-empty__sub">{description}</div> : null}
      {Children.toArray(children).length > 0 ? (
        <div className="jds-empty__actions">{children}</div>
      ) : null}
    </div>
  );
}
