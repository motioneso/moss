import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  PRIORITY_LEVELS,
  type TaskApiStatus,
  type TaskEffort,
  type TaskDto,
  type TaskListDto
} from "@moss/shared";
import { Button, Dialog, EmptyState, Field, FormLabel, Segmented, Select } from "@moss/ui";

import {
  addTaskActivity,
  assignTaskTag,
  breakdownTask,
  createTask,
  createTaskTag,
  getTask,
  listSubtasks,
  listTaskActivity,
  listTaskTags,
  unassignTaskTag,
  updateTask
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useUserLocale } from "../locale/locale-format";
import {
  buildTaskFields,
  blankTaskDetailsForm,
  cleanSubtasks,
  formFromTask,
  normalizeTagName,
  type Repeat,
  type TaskDetailsFormState
} from "./task-details-model";
import {
  AssignedPersonField,
  TaskActivityPanel,
  TaskStatusControl,
  TaskSubtasksField,
  TaskTagsField
} from "./task-details-sections";
// The dialog is shared: it opens from Today as well as the Tasks page. Import the
// stylesheets it depends on here — `.tk-statusctl` (tasks.css) and the `.tk-tagmenu`
// base (kit-tasks.css) — so the status control and its dropdown are styled no matter
// which page opened it. Previously these loaded only via tasks-page.tsx, so opening a
// task straight from Today rendered the status split-button unstyled. Order mirrors
// tasks-page.tsx (kit-tasks base first, tasks.css overrides second).
import "../styles/kit-tasks.css";
import "../styles/kit-tasks-modal.css";
import "./tasks.css";

const EFFORTS: readonly { readonly value: TaskEffort; readonly label: string }[] = [
  { value: "quick", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" }
];

const REPEATS: readonly { readonly value: Repeat; readonly label: string }[] = [
  { value: "never", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" }
];

export function TaskDetailsDialog(props: {
  readonly open: boolean;
  readonly taskId: string | null;
  readonly defaultListId?: string;
  readonly defaultTitle?: string;
  readonly currentUserLabel: string;
  readonly lists: readonly TaskListDto[];
  readonly onClose: () => void;
}) {
  const isNew = props.taskId === null;
  const headingId = useId();

  const requireTaskId = () => {
    if (!props.taskId) throw new Error("Task id required for this operation");
    return props.taskId;
  };
  const queryClient = useQueryClient();
  // #877 finding 3: formFromTask needs the persisted-locale timezone (not an
  // ambient default) so the due-date/reminder inputs it seeds bucket the same
  // calendar day as the list-view label.
  const locale = useUserLocale();
  const [form, setForm] = useState<TaskDetailsFormState>(() =>
    blankTaskDetailsForm(props.defaultListId, props.defaultTitle)
  );
  // New-task local collections (attached after the task is created).
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newSubs, setNewSubs] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [subDraft, setSubDraft] = useState("");
  const [comment, setComment] = useState("");
  // Progress of a new-task save, so a retry after a partial failure resumes instead of
  // creating the parent again or re-adding the parts that already landed.
  const createdRef = useRef<{
    id: string;
    listId: string;
    subtasksDone: boolean;
    tagsDone: Set<string>;
  } | null>(null);

  const enabled = props.open && !isNew && props.taskId !== null;
  const taskQuery = useQuery({
    enabled,
    queryKey: props.taskId ? queryKeys.tasks.detail(props.taskId) : ["tasks", "detail", "draft"],
    queryFn: () => getTask(requireTaskId())
  });
  const subtasksQuery = useQuery({
    enabled,
    queryKey: props.taskId
      ? queryKeys.tasks.subtasks(props.taskId)
      : ["tasks", "subtasks", "draft"],
    queryFn: () => listSubtasks(requireTaskId())
  });
  const activityQuery = useQuery({
    enabled,
    queryKey: props.taskId
      ? queryKeys.tasks.activity(props.taskId)
      : ["tasks", "activity", "draft"],
    queryFn: () => listTaskActivity(requireTaskId())
  });
  const task = taskQuery.data?.task;

  // An existing task's tags live in its own list, unknown until the task loads.
  const tagsListId = isNew ? form.listId : (task?.listId ?? "");
  const listTagsQuery = useQuery({
    enabled: props.open && Boolean(tagsListId),
    queryKey: queryKeys.tasks.tags(tagsListId),
    queryFn: () => listTaskTags(tagsListId)
  });

  // Seed the form when the dialog opens and when an existing task first loads. Later refreshes
  // of the same task (a tag change, a background refetch) must not discard unsaved edits.
  const seededRef = useRef<{
    readonly key: string;
    readonly task: TaskDto | undefined;
    readonly timeZone: string;
  } | null>(null);
  useEffect(() => {
    if (!props.open) {
      seededRef.current = null;
      return;
    }
    const key = isNew ? "new" : `${props.taskId}:${task ? "loaded" : "pending"}`;
    const seeded = seededRef.current;
    if (seeded?.key === key) {
      // Newer server data or a changed locale arrived: re-seed if nothing was edited, so a
      // cached copy shown first cannot be saved back over fresher values.
      if (!isNew && task && (seeded.task !== task || seeded.timeZone !== locale.timezone)) {
        const before = seeded.task ? formFromTask(seeded.task, seeded.timeZone) : null;
        setForm((f) =>
          before && JSON.stringify(f) === JSON.stringify(before)
            ? formFromTask(task, locale.timezone)
            : f
        );
        seededRef.current = { key, task, timeZone: locale.timezone };
      }
      return;
    }
    if (isNew) {
      setForm(blankTaskDetailsForm(props.defaultListId, props.defaultTitle));
      setNewTags([]);
      setNewSubs([]);
      createdRef.current = null;
    } else if (task) {
      setForm(formFromTask(task, locale.timezone));
    } else {
      // Pending load: nothing to seed yet, and the key flips once the task arrives.
      seededRef.current = { key, task: undefined, timeZone: locale.timezone };
      return;
    }
    seededRef.current = { key, task, timeZone: locale.timezone };
    setTagDraft("");
    setSubDraft("");
    setComment("");
  }, [
    props.open,
    isNew,
    props.taskId,
    task,
    props.defaultListId,
    props.defaultTitle,
    locale.timezone
  ]);

  const invalidateLists = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list }),
      props.taskId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(props.taskId) })
        : Promise.resolve()
    ]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const fields = buildTaskFields(form, props.defaultListId);
      if (isNew) {
        if (!createdRef.current) {
          const created = await createTask(fields);
          createdRef.current = {
            id: created.task.id,
            listId: created.task.listId,
            subtasksDone: false,
            tagsDone: new Set()
          };
        }
        const progress = createdRef.current;
        const subs = cleanSubtasks(newSubs);
        const addSubtasks =
          subs.length > 0 && !progress.subtasksDone
            ? breakdownTask(progress.id, { steps: subs }).then(() => {
                progress.subtasksDone = true;
              })
            : Promise.resolve();
        const addTags = newTags
          .filter((name) => !progress.tagsDone.has(name))
          .map(async (name) => {
            const { tag } = await createTaskTag(progress.listId, { name });
            await assignTaskTag(progress.id, { tagId: tag.id });
            progress.tagsDone.add(name);
          });
        const results = await Promise.allSettled([addSubtasks, ...addTags]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw (failed as PromiseRejectedResult).reason;
        return;
      }
      await updateTask(requireTaskId(), fields);
    },
    onSuccess: async () => {
      await invalidateLists();
      props.onClose();
    }
  });

  const toggleSubMutation = useMutation({
    mutationFn: (vars: { readonly id: string; readonly status: TaskApiStatus }) =>
      updateTask(vars.id, { status: vars.status }),
    onSuccess: async () => {
      if (props.taskId)
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(props.taskId) });
    }
  });

  const addSubMutation = useMutation({
    mutationFn: (text: string) => breakdownTask(requireTaskId(), { steps: [text] }),
    onSuccess: async () => {
      setSubDraft("");
      if (props.taskId)
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(props.taskId) });
    }
  });

  const assignTagMutation = useMutation({
    mutationFn: async (name: string) => {
      const existing = (listTagsQuery.data?.tags ?? []).find(
        (t) => t.name.toLowerCase() === name.toLowerCase()
      );
      const tagId = existing ? existing.id : (await createTaskTag(tagsListId, { name })).tag.id;
      return assignTaskTag(requireTaskId(), { tagId });
    },
    onSuccess: async () => {
      setTagDraft("");
      await Promise.all([
        invalidateLists(),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.tags(tagsListId) })
      ]);
    }
  });

  const unassignTagMutation = useMutation({
    mutationFn: (tagId: string) => unassignTaskTag(requireTaskId(), tagId),
    onSuccess: invalidateLists
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      addTaskActivity(requireTaskId(), { activityType: "comment", body }),
    onSuccess: async () => {
      setComment("");
      if (props.taskId)
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(props.taskId) });
    }
  });

  if (!props.open) return null;

  const subs = subtasksQuery.data?.tasks ?? [];
  // Comment stream only — hide system entries like "Broken into N steps".
  const activity = (activityQuery.data?.activity ?? []).filter(
    (entry) => entry.activityType === "comment"
  );
  const tags = task?.tags ?? [];
  const assignedNames = new Set(tags.map((t) => t.name.toLowerCase()));
  const tagSuggestions = (listTagsQuery.data?.tags ?? [])
    .filter((t) =>
      isNew ? !newTags.includes(t.name.toLowerCase()) : !assignedNames.has(t.name.toLowerCase())
    )
    .slice(0, 8);

  const commitTagDraft = () => {
    const name = normalizeTagName(tagDraft);
    if (!name) return;
    if (isNew) {
      setNewTags((t) => (t.includes(name) ? t : [...t, name]));
      setTagDraft("");
    } else if (tagsListId) {
      assignTagMutation.mutate(name);
    }
  };

  const addTagName = (rawName: string) => {
    const name = normalizeTagName(rawName);
    if (!name) return;
    if (isNew) setNewTags((t) => (t.includes(name) ? t : [...t, name]));
    else if (tagsListId) assignTagMutation.mutate(name);
  };

  const addExistingSubtask = () => {
    const text = subDraft.trim();
    if (text) addSubMutation.mutate(text);
  };

  return (
    <Dialog
      className="tk-modal"
      aria-labelledby={headingId}
      onClose={props.onClose}
      title={
        <div className="tk-modal__head">
          <div className="tk-modal__headmain">
            <div className="tk-modal__eyebrow" id={headingId}>
              {isNew ? "New task" : "Task details"}
            </div>
            <input
              className="tk-modal__titlein"
              value={form.title}
              autoFocus
              disabled={!isNew && !task}
              placeholder="What needs doing?"
              aria-label="Task title"
              onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))}
            />
          </div>
          <button className="tk-modal__x" onClick={props.onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      }
      footer={
        <>
          {!isNew && task ? (
            <TaskStatusControl
              status={form.status}
              onChange={(status) => setForm((f) => ({ ...f, status }))}
            />
          ) : null}
          {saveMutation.isError ? (
            <p className="tk-modal__save-error jds-hint jds-hint--error" role="alert">
              Could not save. Your changes are still here; try again.
            </p>
          ) : null}
          <div className="tk-modal__save-actions">
            <Button variant="quiet" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={saveMutation.isPending || (!isNew && !task)}
              onClick={() => saveMutation.mutate()}
            >
              {isNew ? "Add task" : "Save changes"}
            </Button>
          </div>
        </>
      }
    >
      {!isNew && !task ? (
        taskQuery.isError ? (
          <div role="alert">
            <EmptyState
              title="Could not load this task"
              description="Try again to load its saved details."
            >
              <Button variant="secondary" size="sm" onClick={() => void taskQuery.refetch()}>
                Retry task
              </Button>
            </EmptyState>
          </div>
        ) : (
          <p className="jds-hint" role="status">
            Loading task details…
          </p>
        )
      ) : (
        <>
          {taskQuery.isError ? (
            <div className="tasks-notice" role="alert">
              <p className="jds-hint jds-hint--error">
                Could not refresh this task. Your current details and edits are still here.
              </p>
              <Button variant="secondary" size="sm" onClick={() => void taskQuery.refetch()}>
                Retry task
              </Button>
            </div>
          ) : null}
          <div className="tk-form">
            {/* Comment stream first — surface activity without scrolling. */}
            {!isNew ? (
              <div className="tk-field--full">
                <Field>
                  <FormLabel>Activity</FormLabel>
                  <TaskActivityPanel
                    entries={activity}
                    currentUserLabel={props.currentUserLabel}
                    draft={comment}
                    pending={commentMutation.isPending}
                    loading={activityQuery.isPending}
                    loadError={activityQuery.isError}
                    saveError={commentMutation.isError}
                    onRetry={() => void activityQuery.refetch()}
                    onDraft={setComment}
                    onPost={() => {
                      const body = comment.trim();
                      if (body) commentMutation.mutate(body);
                    }}
                  />
                </Field>
              </div>
            ) : null}

            <div className="tk-field--full">
              <Field>
                <FormLabel htmlFor="task-notes-input">Notes</FormLabel>
                <textarea
                  id="task-notes-input"
                  className="tk-textarea"
                  value={form.description}
                  placeholder="Context, links, anything worth remembering…"
                  onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
                />
              </Field>
            </div>

            <div className="tk-field--full">
              <Field>
                <FormLabel>Assigned to</FormLabel>
                <AssignedPersonField currentUserLabel={props.currentUserLabel} />
              </Field>
            </div>

            <Field>
              <FormLabel htmlFor="task-list-select">List</FormLabel>
              <Select
                id="task-list-select"
                value={form.listId}
                onChange={(event) => setForm((f) => ({ ...f, listId: event.target.value }))}
              >
                {props.lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FormLabel htmlFor="task-priority-select">Priority</FormLabel>
              <Select
                id="task-priority-select"
                value={form.priority}
                onChange={(event) => setForm((f) => ({ ...f, priority: event.target.value }))}
              >
                <option value="">No priority</option>
                {PRIORITY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field>
              <FormLabel htmlFor="task-due-input">Due date</FormLabel>
              <input
                id="task-due-input"
                type="date"
                className="jds-input"
                value={form.dueAt}
                onChange={(event) => setForm((f) => ({ ...f, dueAt: event.target.value }))}
              />
            </Field>
            <Field>
              <FormLabel htmlFor="task-reminder-input">Reminder</FormLabel>
              <input
                id="task-reminder-input"
                type="date"
                className="jds-input"
                value={form.doAt}
                onChange={(event) => setForm((f) => ({ ...f, doAt: event.target.value }))}
              />
            </Field>

            <div className="tk-field--full">
              <Field>
                <FormLabel>Effort</FormLabel>
                <Segmented
                  value={form.effort}
                  options={EFFORTS}
                  ariaLabel="Effort"
                  onChange={(value) =>
                    setForm((f) => ({ ...f, effort: f.effort === value ? "" : value }))
                  }
                />
              </Field>
            </div>

            <Field>
              <FormLabel htmlFor="task-repeat-select">Repeats</FormLabel>
              <Select
                id="task-repeat-select"
                value={form.repeat}
                onChange={(event) =>
                  setForm((f) => ({ ...f, repeat: event.target.value as Repeat }))
                }
              >
                {REPEATS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="tk-field--full">
              <Field>
                <FormLabel>Tags</FormLabel>
                <TaskTagsField
                  isNew={isNew}
                  newTags={newTags}
                  tags={tags}
                  tagSuggestions={tagSuggestions}
                  draft={tagDraft}
                  onDraft={setTagDraft}
                  onCommitDraft={commitTagDraft}
                  onAddSuggestion={addTagName}
                  onRemoveNewTag={(name) => setNewTags((t) => t.filter((x) => x !== name))}
                  onUnassignTag={(tagId) => unassignTagMutation.mutate(tagId)}
                />
                {listTagsQuery.isError ? (
                  <div className="tasks-notice" role="alert">
                    <p className="jds-hint jds-hint--error">
                      Could not load tag suggestions. Assigned tags are still shown.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void listTagsQuery.refetch()}
                    >
                      Retry tags
                    </Button>
                  </div>
                ) : null}
                {assignTagMutation.isError || unassignTagMutation.isError ? (
                  <p className="jds-hint jds-hint--error" role="alert">
                    Could not update tags. Try that change again.
                  </p>
                ) : null}
              </Field>
            </div>

            <div className="tk-field--full">
              <Field>
                <FormLabel>Subtasks</FormLabel>
                {!isNew && subtasksQuery.isPending ? (
                  <p className="jds-hint" role="status">
                    Loading subtasks…
                  </p>
                ) : null}
                {!isNew && subtasksQuery.isError ? (
                  <div className="tasks-notice" role="alert">
                    <p className="jds-hint jds-hint--error">
                      Could not load subtasks. Any previously loaded subtasks are still shown.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void subtasksQuery.refetch()}
                    >
                      Retry subtasks
                    </Button>
                  </div>
                ) : null}
                <TaskSubtasksField
                  isNew={isNew}
                  newSubs={newSubs}
                  subs={subs}
                  draft={subDraft}
                  onNewSubChange={(index, value) =>
                    setNewSubs((s) => s.map((item, i) => (i === index ? value : item)))
                  }
                  onNewSubRemove={(index) => setNewSubs((s) => s.filter((_, i) => i !== index))}
                  onNewSubAdd={() => setNewSubs((s) => [...s, ""])}
                  onToggleExisting={(id, status) => toggleSubMutation.mutate({ id, status })}
                  onDraft={setSubDraft}
                  onAddExisting={addExistingSubtask}
                />
                {addSubMutation.isError || toggleSubMutation.isError ? (
                  <p className="jds-hint jds-hint--error" role="alert">
                    Could not update the subtask. Your text is still here; try again.
                  </p>
                ) : null}
              </Field>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
