import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@moss/ui";
import { LoaderCircle, Plus, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import { createTask } from "../api/client";
import { queryKeys } from "../api/query-keys";

/** Pinned quick-add bar. "Add task" captures the title directly; "Details" opens the
    full Details modal (the prototype's tk-add behaviour). */
export function TaskCapture(props: {
  readonly defaultListId?: string;
  readonly onDetails: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const submitting = useRef(false);
  const [title, setTitle] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (submitted: string) =>
      createTask({ title: submitted, listId: props.defaultListId || undefined }),
    onSuccess: async (_task, submitted) => {
      // Keep anything typed while the request was in flight.
      setTitle((current) => (current.trim() === submitted ? "" : current));
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
    },
    onError: (error) => setFormError(error.message),
    onSettled: () => {
      submitting.current = false;
    }
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = title.trim();
    if (!submitted || submitting.current) return;
    // Admit once before the mutation's pending state reaches the next render.
    submitting.current = true;
    setFormError(null);
    createMutation.mutate(submitted);
  };

  return (
    <form className="task-capture" onSubmit={handleSubmit} aria-label="Capture a task">
      <div className="tk-add">
        <span className="tk-add__plus">
          <Plus size={18} aria-hidden="true" />
        </span>
        <input
          aria-label="Task title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Add a task — type and press Enter…"
          type="text"
          value={title}
        />
        <div className="tk-add__actions">
          <Button
            icon={<SlidersHorizontal size={14} aria-hidden="true" />}
            size="sm"
            variant="secondary"
            onClick={() => props.onDetails(title)}
          >
            Details
          </Button>
          <Button
            disabled={createMutation.isPending || !title.trim()}
            icon={
              createMutation.isPending ? (
                <LoaderCircle className="spin" size={14} aria-hidden="true" />
              ) : null
            }
            size="sm"
            type="submit"
          >
            Add task
          </Button>
        </div>
      </div>
      {formError ? (
        <p className="jds-hint jds-hint--error" role="alert">
          {`Could not add the task. ${formError}`}
        </p>
      ) : null}
    </form>
  );
}
