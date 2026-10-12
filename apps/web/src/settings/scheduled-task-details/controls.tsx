import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog } from "@moss/ui";
import { pauseScheduledTask, resumeScheduledTask, deleteScheduledTask } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import type { TaskDetailProps } from "./types";

export function TaskControls({ task, onDeleted }: TaskDetailProps) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: async (action: "pause" | "resume" | "delete") => {
      if (action === "pause") await pauseScheduledTask(task.id);
      else if (action === "resume") await resumeScheduledTask(task.id);
      else await deleteScheduledTask(task.id);
      return action;
    },
    onSuccess: async (action) => {
      await client.invalidateQueries({ queryKey: queryKeys.chat.scheduledTasks });
      if (action === "delete") {
        setConfirming(false);
        onDeleted?.();
      }
    }
  });
  const close = () => {
    if (!mutation.isPending) setConfirming(false);
  };
  return (
    <section className="scheduled-task-controls" aria-label="Task controls">
      <div className="scheduled-task-controls__actions">
        {(task.state === "active" || task.state === "paused") && (
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(task.state === "paused" ? "resume" : "pause")}
          >
            {task.state === "paused" ? "Resume" : "Pause"}
          </Button>
        )}
        <Button
          ref={remove}
          variant="quiet"
          disabled={mutation.isPending}
          onClick={() => {
            mutation.reset();
            setConfirming(true);
          }}
        >
          Delete task
        </Button>
      </div>
      {mutation.isPending && <p role="status">Saving your change...</p>}
      {mutation.isError && !confirming && (
        <p role="alert">Couldn't save that change. Refresh the details and try again.</p>
      )}
      {confirming && (
        <Dialog
          title="Delete task?"
          description="Earlier messages and completed actions will stay."
          onClose={close}
          initialFocusRef={keep}
          returnFocusRef={remove}
          dismissOnEscape={!mutation.isPending}
          dismissOnBackdrop={!mutation.isPending}
          footer={
            <>
              <Button ref={keep} disabled={mutation.isPending} onClick={close}>
                Keep task
              </Button>
              <Button
                variant="danger"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate("delete")}
              >
                Delete task
              </Button>
            </>
          }
        >
          <p>{task.instruction}</p>
          {mutation.isError && <p role="alert">Couldn't delete this task. Try again.</p>}
        </Dialog>
      )}
    </section>
  );
}
