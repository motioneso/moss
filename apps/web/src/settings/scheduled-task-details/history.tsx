import { useState } from "react";
import { Button, Dialog, SectionHead } from "@moss/ui";
import type { ScheduledTaskMessageDto } from "@moss/shared";
import { MarkdownMessage } from "../../chat/markdown-message";
import { formatDateTime } from "../../locale/locale-format";
import { useChatControls } from "../../shell/chat-controls-context";
import type { TaskDetailProps } from "./types";
export function TaskHistory({ task, locale }: TaskDetailProps) {
  const [message, setMessage] = useState<ScheduledTaskMessageDto | null>(null);
  const { openChatThread } = useChatControls();
  return (
    <section className="scheduled-task-history" aria-label="Run history">
      <SectionHead title="Run history" titleAs="h3" />
      {task.runs.length === 0 ? (
        <p role="status">
          {task.state === "active" || task.state === "paused"
            ? `Saved ${formatDateTime(task.createdAt, locale)}. Hasn't run yet.`
            : "No recorded runs."}
        </p>
      ) : (
        task.runs.map((run) => (
          <details key={`${run.outcome}-${run.at}`}>
            <summary>
              <time dateTime={run.at}>{formatDateTime(run.at, locale)}</time> - {run.summary}
            </summary>
            <div className="scheduled-task-run">
              <p>{run.summary}.</p>
              {run.message && (
                <Button variant="link" onClick={() => setMessage(run.message)}>
                  View message
                </Button>
              )}
            </div>
          </details>
        ))
      )}
      {message && (
        <Dialog
          title={task.title}
          closeLabel="Close message"
          onClose={() => setMessage(null)}
          footer={
            <Button
              variant="link"
              onClick={() => {
                setMessage(null);
                openChatThread(message.threadId);
              }}
            >
              Open chat
            </Button>
          }
        >
          <MarkdownMessage text={message.body} messageId={message.id} />
        </Dialog>
      )}
    </section>
  );
}
