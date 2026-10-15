import { Check } from "lucide-react";
import { Button, RowButton, RowIndex, RowIndexItem, SectionHead } from "@moss/ui";
import type { ApprovedActionScopeDto } from "@moss/shared";
import { useEffect, useRef } from "react";

export function ApprovedActionScopes({
  scopes,
  onSelect
}: {
  readonly scopes: readonly ApprovedActionScopeDto[];
  readonly onSelect: (id: string) => void;
}) {
  if (!scopes.length) return null;
  return (
    <section aria-label="Approved changes - not active">
      <SectionHead title="Approved changes - not active" titleAs="h3" />
      <RowIndex density="compact">
        {scopes.map((agreement) => (
          <RowIndexItem
            key={agreement.id}
            title={
              <RowButton
                className="scheduled-task-row"
                data-task-id={agreement.id}
                onClick={() => onSelect(agreement.id)}
              >
                <Check size={21} strokeWidth={1.6} aria-hidden="true" />
                <span>Mark {agreement.scope.taskTitle} done</span>
              </RowButton>
            }
          />
        ))}
      </RowIndex>
    </section>
  );
}

export function ApprovedActionScopeDetail({
  agreement,
  onBack
}: {
  readonly agreement: ApprovedActionScopeDto;
  readonly onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [agreement.id]);
  const { scope } = agreement;
  return (
    <div className="scheduled-task-detail">
      <Button variant="link" onClick={onBack}>
        Back to all tasks
      </Button>
      <h3 className="scheduled-task-detail__title" ref={heading} tabIndex={-1}>
        Mark {scope.taskTitle} done
      </h3>
      <p>Not active. Scheduled changes aren't available yet, so no change will run.</p>
      <section aria-label="Agreed action scope">
        <SectionHead
          title="Agreed action scope"
          titleAs="h4"
          titleClassName="scheduled-task-detail__section-title"
        />
        <p>Mark this task done once. No other changes are approved.</p>
        <dl>
          <dt>Task</dt>
          <dd>
            {scope.taskTitle} ({scope.taskId})
          </dd>
          <dt>Operation</dt>
          <dd>{scope.operation}</dd>
          <dt>New status</dt>
          <dd>{scope.status}</dd>
          <dt>Agreed time</dt>
          <dd>
            {scope.dueAt} ({scope.timeZone})
          </dd>
          <dt>Destination</dt>
          <dd>Main conversation ({scope.destinationThreadId})</dd>
          <dt>Agreement version</dt>
          <dd>{agreement.version}</dd>
          <dt>Agreed on</dt>
          <dd>{agreement.approvedAt}</dd>
        </dl>
        <p>Changing this saved action scope is unavailable. This agreement cannot be resumed.</p>
      </section>
    </div>
  );
}
