import { Bell } from "lucide-react";
import { DisclosureToggle, RowButton, RowIndex, RowIndexItem, SectionHead } from "@moss/ui";
import { useId, useState } from "react";
import type { ScheduledTaskDto } from "@moss/shared";
import { isPastTask } from "./scheduled-task-details/types";

function TaskRows({
  tasks,
  onSelect
}: {
  readonly tasks: readonly ScheduledTaskDto[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <RowIndex density="compact">
      {tasks.map((task) => (
        <RowIndexItem
          key={task.id}
          title={
            <RowButton
              className="scheduled-task-row"
              data-task-id={task.id}
              onClick={() => onSelect(task.id)}
            >
              <Bell size={21} strokeWidth={1.6} aria-hidden="true" />
              <span>{task.title}</span>
            </RowButton>
          }
        />
      ))}
    </RowIndex>
  );
}
export function ScheduledTaskList({
  tasks,
  onSelect
}: {
  readonly tasks: readonly ScheduledTaskDto[];
  readonly onSelect: (id: string) => void;
}) {
  const [pastOpen, setPastOpen] = useState(false);
  const pastId = useId();
  const active = tasks.filter((task) => !isPastTask(task));
  const past = tasks.filter(isPastTask).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="scheduled-task-groups">
      {(["Reminders", "Daily", "Weekly", "More often"] as const).map((group) => {
        const grouped = active.filter((task) => task.group === group);
        return grouped.length > 0 ? (
          <section key={group} aria-label={group}>
            <SectionHead title={group} titleAs="h3" />
            <TaskRows tasks={grouped} onSelect={onSelect} />
          </section>
        ) : null;
      })}
      {past.length > 0 && (
        <section aria-label="Past tasks">
          <DisclosureToggle
            expanded={pastOpen}
            controls={pastId}
            onClick={() => setPastOpen(!pastOpen)}
          >
            Past tasks
          </DisclosureToggle>
          <div id={pastId} hidden={!pastOpen}>
            <TaskRows tasks={past} onSelect={onSelect} />
          </div>
        </section>
      )}
    </div>
  );
}
