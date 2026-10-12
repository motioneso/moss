import "../styles/settings-scheduled-tasks.css";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@moss/ui";
import { listScheduledTasks } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useChatControls } from "../shell/chat-controls-context";
import { PaneHead } from "./settings-ui";
import { ScheduledTaskList } from "./scheduled-task-list";
import { ScheduledTaskDetail } from "./scheduled-task-detail";
export function ScheduledTasksPane() {
  const query = useQuery({
    queryKey: queryKeys.chat.scheduledTasks,
    queryFn: listScheduledTasks,
    refetchInterval: 5000
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { openChat } = useChatControls();
  const selected = query.data?.tasks.find((task) => task.id === selectedId);
  return (
    <>
      <PaneHead title="Scheduled tasks" desc="What Moss is keeping an eye on for you." />
      {query.isPending ? (
        <p role="status">Loading your scheduled tasks...</p>
      ) : !query.data ? (
        <EmptyState
          title="Couldn't load your tasks"
          description="Your saved schedules haven't changed."
        >
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </EmptyState>
      ) : (
        <>
          <div ref={list} tabIndex={-1} hidden={Boolean(selected)}>
            {query.data.tasks.length === 0 ? (
              <EmptyState
                title="Nothing scheduled yet"
                description="Ask Moss in Main chat to set a reminder."
              >
                <Button onClick={openChat}>Open chat</Button>
              </EmptyState>
            ) : (
              <ScheduledTaskList tasks={query.data.tasks} onSelect={setSelectedId} />
            )}
          </div>
          {selected && (
            <ScheduledTaskDetail
              key={selected.id}
              task={selected}
              onBack={() => {
                setSelectedId(null);
                requestAnimationFrame(() =>
                  (
                    list.current?.querySelector<HTMLButtonElement>(
                      `[data-task-id="${selected.id}"]`
                    ) ?? list.current
                  )?.focus()
                );
              }}
            />
          )}
        </>
      )}
    </>
  );
}
