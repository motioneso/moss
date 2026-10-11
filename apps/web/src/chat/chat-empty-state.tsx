import { useQuery } from "@tanstack/react-query";
import { BrandMark } from "@moss/ui";
import { listCalendarEvents, listTasks } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useUserLocale } from "../locale/locale-format";
import { buildChatSeeds } from "./seeds";

export function ChatEmptyState(props: {
  readonly onSend: (text: string) => void;
  readonly isSending: boolean;
  readonly lockedModelUnavailable: boolean;
}) {
  const tasksQuery = useQuery({ queryKey: queryKeys.tasks.list, queryFn: () => listTasks() });
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendar.list,
    queryFn: () => listCalendarEvents()
  });
  const locale = useUserLocale();

  const seeds = buildChatSeeds(
    tasksQuery.data?.tasks ?? [],
    eventsQuery.data?.events ?? [],
    locale
  );

  return (
    <div className="chatd-empty">
      <span className="chatd-empty__mark">
        <BrandMark size={22} />
      </span>
      <div className="chatd-empty__title">What can I help with?</div>
      <div className="chatd-empty__sub">
        Ask about your day, your tasks, or anything you&apos;ve told me.
      </div>
      <div className="chatd-sugg">
        {seeds.map((seed) => (
          <button
            className="chatd-sugg__btn"
            disabled={props.isSending || props.lockedModelUnavailable}
            key={seed}
            type="button"
            onClick={() => props.onSend(seed)}
          >
            {seed}
          </button>
        ))}
      </div>
    </div>
  );
}
