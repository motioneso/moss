import { Card, SectionHead, Badge, Note } from "@moss/ui";
import { type VisualSnapshotV1 } from "@moss/shared";
import {
  readTaskSummarySnapshot,
  summaryScopeLabels,
  taskSummaryCoverage,
  taskSummaryItemText
} from "./contract.js";
import "./card.css";

export function TaskSummaryCard({ snapshot }: { snapshot: VisualSnapshotV1 }) {
  const v = readTaskSummarySnapshot(snapshot);
  if (!v) throw new Error("Task summary unavailable");
  return (
    <Card>
      <div className="tasks-summary">
        <SectionHead
          title="Tasks"
          titleAs="h3"
          meta={<Badge>{v.truncated ? "Partial coverage" : "Read-only snapshot"}</Badge>}
        />
        <p>
          {summaryScopeLabels[v.scope]} · {v.localDate} · {v.timeZone}
        </p>
        {v.items.length ? (
          <ul className="tasks-summary__rows" aria-label="Task summary">
            {v.items.map((item) => (
              <li key={item.id} data-task-id={item.id}>
                <strong>{item.title}</strong>
                <span>{taskSummaryItemText(item, v.timeZone)}</span>
                <span>Task {item.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">No matching persisted tasks in this scope.</p>
        )}
        <Note variant="practical">
          <p>
            Tasks · Source retrieved <time dateTime={v.retrievedAt}>{v.retrievedAt}</time>
          </p>
          <p>{taskSummaryCoverage(v)}</p>
        </Note>
      </div>
    </Card>
  );
}
export default { "tasks.summary": TaskSummaryCard };
