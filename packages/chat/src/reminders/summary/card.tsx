import { Card, SectionHead, Badge, Note } from "@moss/ui";
import { type VisualSnapshotV1 } from "@moss/shared";
import {
  readReminderSummarySnapshot,
  reminderScopeLabels,
  reminderSummaryCoverage,
  reminderSummaryItemText
} from "./contract.js";
import "./card.css";

export function ReminderSummaryCard({ snapshot }: { snapshot: VisualSnapshotV1 }) {
  const v = readReminderSummarySnapshot(snapshot);
  if (!v) throw new Error("Reminder summary unavailable");
  return (
    <Card>
      <div className="reminders-summary">
        <SectionHead
          title="Reminders"
          titleAs="h3"
          meta={<Badge>{v.truncated ? "Partial coverage" : "Read-only snapshot"}</Badge>}
        />
        <p>
          {reminderScopeLabels[v.scope]} · {v.localDate} · {v.timeZone}
        </p>
        {v.items.length ? (
          <ul className="reminders-summary__rows" aria-label="Reminder summary">
            {v.items.map((item) => (
              <li key={item.id} data-reminder-id={item.id}>
                <strong>{item.text}</strong>
                <span>{reminderSummaryItemText(item, v.timeZone)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">No matching saved reminders in this scope.</p>
        )}
        <Note variant="practical">
          <p>
            Reminders · Source retrieved <time dateTime={v.retrievedAt}>{v.retrievedAt}</time>
          </p>
          <p>{reminderSummaryCoverage(v)}</p>
        </Note>
      </div>
    </Card>
  );
}
export default { "reminders.summary": ReminderSummaryCard };
