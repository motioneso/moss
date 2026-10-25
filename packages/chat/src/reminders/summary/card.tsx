import { Card, SectionHead, Badge, Note } from "@moss/ui";
import { type VisualSnapshotV1 } from "@moss/shared";
import {
  readReminderSummarySnapshot,
  reminderRepeatText,
  reminderScopeLabels,
  reminderSummaryCoverage
} from "./contract.js";
import type { ReminderSummaryItem } from "./types.js";
import "./card.css";

function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function ReminderRow({ item, timeZone }: { item: ReminderSummaryItem; timeZone: string }) {
  const state = item.state.charAt(0).toUpperCase() + item.state.slice(1);
  const destination = item.destinationTitle ?? "Main chat";
  return (
    <li data-reminder-id={item.id}>
      <strong>{item.text}</strong>
      <span>
        {state === "Queued" ? "Scheduled" : state} for {formatWhen(item.dueAt, timeZone)}
      </span>
      <span>
        {reminderRepeatText(item.repeat)} · {destination}
      </span>
      {item.deadlineAt ? <span>Deadline {formatWhen(item.deadlineAt, timeZone)}</span> : null}
      {item.deliveredAt ? (
        <span>
          Delivered {formatWhen(item.deliveredAt, timeZone)}
          {item.late ? " (late)" : " (on time)"}
        </span>
      ) : null}
    </li>
  );
}

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
              <ReminderRow key={item.id} item={item} timeZone={v.timeZone} />
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
