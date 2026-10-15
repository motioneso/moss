import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { useId } from "react";
import { listGoals } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";

export function GoalsSection() {
  const titleId = useId();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.goals.list,
    queryFn: listGoals
  });

  if (isLoading || !data || data.length === 0) {
    return null;
  }

  const activeGoals = data.filter((g) => g.status === "active");
  if (activeGoals.length === 0) return null;

  return (
    <section className="jds-brief" aria-labelledby={titleId}>
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Focus</span>
      </div>
      <h2 className="jds-brief__title" id={titleId}>
        Long-term goals
      </h2>
      <div className="loose">
        {activeGoals.map((goal) => (
          <div className="jds-task" key={goal.id}>
            <span className="jds-task__check">
              <Target size={15} aria-hidden="true" />
            </span>
            <div className="jds-task__main">
              <div className="jds-task__title">{goal.title}</div>
              <div className="jds-task__meta">
                {goal.priority ? (
                  <span className="jds-drift">
                    <span className="jds-drift__dot" />P{goal.priority}
                  </span>
                ) : null}
                <span className="jds-task__source">{goal.desiredOutcome}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
