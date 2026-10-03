import { QUADRANTS, type TaskDto, type TaskListDto, type TaskQuadrant } from "@moss/shared";
import { SectionHead } from "@moss/ui";

import { listColorMap, TaskRow } from "./task-list-view";
import { groupTasksByQuadrant } from "./task-view-model";

/** Marker colour per quadrant. Do First carries the accent; the rest stay quiet. */
const QUAD_COLOR: Record<TaskQuadrant, string> = {
  do: "var(--accent-fg)",
  schedule: "var(--steel)",
  delegate: "var(--amber)",
  eliminate: "var(--ink-4)"
};

export function TaskMatrixView(props: {
  readonly tasks: readonly TaskDto[];
  readonly lists: readonly TaskListDto[];
  readonly isUpdating: boolean;
  readonly onToggleDone: (task: TaskDto) => void;
  readonly onOpen: (task: TaskDto) => void;
  readonly onAccept?: (task: TaskDto) => void;
  readonly onDismiss?: (task: TaskDto) => void;
}) {
  const listMeta = listColorMap(props.lists);
  const tasksByQuadrant = groupTasksByQuadrant(props.tasks);

  return (
    <div className="tasks-matrix">
      {QUADRANTS.map((quadrant) => {
        const tasks = tasksByQuadrant[quadrant.key];
        const headingId = `tasks-quad-${quadrant.key}`;
        return (
          <section
            className={`tasks-quad tasks-quad--${quadrant.key}`}
            key={quadrant.key}
            aria-labelledby={headingId}
          >
            <SectionHead
              id={headingId}
              title={quadrant.title}
              marker={
                <span
                  className="tk-panel__dot"
                  style={{ "--tk-swatch": QUAD_COLOR[quadrant.key] } as React.CSSProperties}
                />
              }
              meta={`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}
            />
            <p className="tasks-quad__subtitle">{quadrant.subtitle}</p>
            <div className="tasks-quad__rows">
              {tasks.length === 0 ? (
                <p className="tasks-quad__empty">Nothing here.</p>
              ) : (
                tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    list={listMeta.get(task.listId)}
                    isUpdating={props.isUpdating}
                    compact
                    onToggleDone={props.onToggleDone}
                    onOpen={props.onOpen}
                    onAccept={props.onAccept}
                    onDismiss={props.onDismiss}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
