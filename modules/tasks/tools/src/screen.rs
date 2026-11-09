//! Public screen markup, rendered with the shared Leptos kit. Account data is
//! loaded only after the opaque frame establishes its parent bridge.
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonType, ButtonVariant, EmptyState, Field, FormLabel, Masthead};

fn action(id: &'static str, label: &'static str) -> impl IntoView {
    view! {<span data-action=id><Button variant=ButtonVariant::Secondary>{label}</Button></span>}
}

pub fn render() -> String {
    let html = view! {
        <Masthead title="Tasks" field=true eyebrow="Your work, at a glance"
            lede="Choose what matters. Take the next step."/>
        <main id="tasks-app" class="tasks-package">
            <p id="notice" role="status" aria-live="polite">"Loading your tasks…"</p>
            <div id="page-error" hidden role="alert">
                <EmptyState title="Tasks could not load" description="Check your connection and try again."/>
                {action("reload", "Try again")}
            </div>
                <div id="discard-draft" hidden role="alert">
                    <p>"You have unsaved changes. Keep editing or discard them?"</p>
                    <span id="keep-editing">{action("keep-editing", "Keep editing")}</span>
                    {action("discard-changes", "Discard changes")}
                </div>
            <section id="overview" aria-label="Your tasks" hidden>
                <div class="tasks-controls">
                    <Field><FormLabel control_id="list-filter">"List"</FormLabel>
                        <select id="list-filter" class="jds-input"><option value="">"All lists"</option></select>
                    </Field>
                    <Field><FormLabel control_id="status-filter">"Status"</FormLabel>
                        <select id="status-filter" class="jds-input">
                            <option value="todo">"To do"</option><option value="all">"All"</option>
                            <option value="done">"Done"</option>
                            <option value="suggested">"Suggested"</option><option value="archived">"Archived"</option>
                        </select>
                    </Field>
                    <Field><FormLabel control_id="tag-filter">"Tags"</FormLabel>
                        <select id="tag-filter" class="jds-input"><option value="">"Add tag filter"</option></select>
                    </Field>
                    <Field><FormLabel control_id="search">"Search"</FormLabel>
                        <input id="search" class="jds-input" type="search" maxlength="300" placeholder="Search tasks"/>
                    </Field>
                    <span id="interpret-search"><Button variant=ButtonVariant::Secondary>"Interpret search"</Button></span>
                    <Field><FormLabel control_id="view">"View"</FormLabel>
                        <select id="view" class="jds-input"><option value="priority">"List"</option><option value="matrix">"Grid"</option></select>
                    </Field>
                    {action("new", "New task")}
                    {action("manage-lists", "Manage lists")}
                    {action("clear-filters", "Clear filters")}
                </div>
                <details id="list-options">
                    <summary>"Choose lists"</summary>
                    <p class="jds-caption">"Include lists, show only selected lists, or hide lists. Counts follow status and tags, before search."</p>
                    <div id="list-selection" class="tasks-fields"></div>
                </details>
                <div id="active-tags" class="tasks-actions" role="group" aria-label="Active tag filters"></div>
                <p id="search-warning" role="status" hidden></p>
                <div id="search-intent" class="tasks-actions" role="group" aria-label="Interpreted search filters"></div>
                <p class="jds-caption">"Interpret a phrase into filters, or search by title and description. Interpreted dates use UTC."</p>
                <p class="jds-caption">"Manual tag picks match any selected tag. Interpreted tag filters require every named tag."</p>
                <div id="empty" hidden>
                    <EmptyState title="No tasks here" description="Try another filter or add a task."/>
                    {action("clear-filters", "Clear filters")}
                </div>
                <form id="quick-task-form" class="tasks-fields" aria-label="Capture a task">
                    <div class="tasks-inline">
                        <Field><FormLabel control_id="quick-title">"Task title"</FormLabel>
                            <input id="quick-title" class="jds-input" maxlength="500" placeholder="Add a task — type and press Enter…"/>
                        </Field>
                        <span id="quick-details"><Button variant=ButtonVariant::Secondary>"Details"</Button></span>
                        <Button kind=ButtonType::Submit>"Add task"</Button>
                    </div>
                    <p id="quick-error" hidden role="alert"></p>
                </form>
                <div id="task-results" aria-live="polite"></div>
            </section>
            <section id="editor" hidden aria-labelledby="editor-heading">
                <h2 id="editor-heading">"Task details"</h2>
                <form id="task-form" class="tasks-fields">
                    <Field><FormLabel control_id="title">"Title"</FormLabel>
                        <input id="title" name="title" class="jds-input" maxlength="500" required/>
                    </Field>
                    <Field><FormLabel control_id="description">"Description"</FormLabel>
                        <textarea id="description" name="description" class="jds-input" rows="4"></textarea>
                    </Field>
                    <div class="tasks-columns">
                        <Field><FormLabel control_id="task-list">"List"</FormLabel><select id="task-list" name="listId" class="jds-input" required></select></Field>
                        <Field><FormLabel control_id="task-status">"Status"</FormLabel>
                            <select id="task-status" name="status" class="jds-input">
                                <option value="todo">"To do"</option>
                                <option value="done">"Done"</option><option value="suggested" disabled>"Suggested"</option><option value="archived">"Archived"</option>
                            </select>
                        </Field>
                        <Field><FormLabel control_id="priority">"Priority"</FormLabel>
                            <select id="priority" name="priority" class="jds-input"><option value="">"None"</option>
                                <option value="1">"Someday"</option><option value="2">"Low"</option><option value="3">"Medium"</option><option value="4">"High"</option><option value="5">"Critical"</option>
                            </select>
                        </Field>
                        <Field><FormLabel control_id="effort">"Effort"</FormLabel>
                            <select id="effort" name="effort" class="jds-input"><option value="">"None"</option><option value="quick">"Small"</option><option value="medium">"Medium"</option><option value="large">"Large"</option></select>
                        </Field>
                    </div>
                    <p class="jds-caption">"Dates are shown in UTC. Unchanged dates keep their saved time."</p>
                    <div class="tasks-columns">
                        <Field><FormLabel control_id="due-at">"Due date"</FormLabel><input id="due-at" name="dueAt" type="date" class="jds-input"/></Field>
                        <Field><FormLabel control_id="do-at">"Do date"</FormLabel><input id="do-at" name="doAt" type="date" class="jds-input"/></Field>
                        <Field><FormLabel control_id="repeat">"Repeat"</FormLabel><select id="repeat" name="repeat" class="jds-input"><option value="never">"Never"</option><option value="daily">"Daily"</option><option value="weekly">"Weekly"</option><option value="monthly">"Monthly"</option></select></Field>
                    </div>
                    <section id="new-task-extras" hidden aria-label="Prepare tags and subtasks">
                        <h3>"Tags"</h3>
                        <div id="new-tags" class="tasks-actions"></div>
                        <div class="tasks-inline">
                            <Field><FormLabel control_id="new-tag-name">"New task tag"</FormLabel>
                                <input id="new-tag-name" class="jds-input" maxlength="100" placeholder="Type a tag and press Enter"/>
                            </Field>
                            <span id="add-new-tag"><Button variant=ButtonVariant::Secondary>"Add tag"</Button></span>
                        </div>
                        <div id="new-tag-suggestions" class="tasks-actions" role="group" aria-label="Suggested list tags"></div>
                        <div id="new-tags-error" hidden role="status">
                            <p>"List tags could not load. You can still type tags, or try again."</p>
                            {action("retry-new-tags", "Retry list tags")}
                        </div>
                        <h3>"Subtasks"</h3>
                        <div id="new-subtasks" class="tasks-fields"></div>
                        <span id="add-new-subtask"><Button variant=ButtonVariant::Secondary>"Add subtask"</Button></span>
                        <p id="capture-progress" hidden role="status">"The task was saved. Retry Save task to finish adding its tags and subtasks. The list, tags and subtasks are kept while you retry."</p>
                    </section>
                    <p id="edit-error" hidden role="alert"></p>
                    <div class="tasks-actions">
                        <Button kind=ButtonType::Submit>"Save task"</Button>
                        {action("close-editor", "Back to tasks")}
                        {action("chat", "Ask Moss about this task")}
                    </div>
                </form>
                <div id="task-extras" hidden class="tasks-fields">
                    <section aria-labelledby="subtasks-heading"><h3 id="subtasks-heading">"Subtasks"</h3>
                        <div id="subtasks"></div>
                        <form id="subtask-form" class="tasks-inline">
                            <Field><FormLabel control_id="subtask-title">"New subtask"</FormLabel><input id="subtask-title" class="jds-input" required maxlength="500"/></Field>
                            <Button kind=ButtonType::Submit variant=ButtonVariant::Secondary>"Add subtask"</Button>
                        </form>
                    </section>
                    <section aria-labelledby="tags-heading"><h3 id="tags-heading">"Tags"</h3><div id="task-tags" class="tasks-actions"></div>
                        <form id="tag-form" class="tasks-inline">
                            <Field><FormLabel control_id="tag-name">"New tag"</FormLabel><input id="tag-name" class="jds-input" required maxlength="100"/></Field>
                            <Button kind=ButtonType::Submit variant=ButtonVariant::Secondary>"Create and assign tag"</Button>
                        </form>
                    </section>
                    <section aria-labelledby="activity-heading"><h3 id="activity-heading">"Activity"</h3>
                        <p id="activity-loading" hidden role="status">"Loading activity…"</p>
                        <div id="activity-error" hidden role="alert">
                            <p>"Could not load activity. Any previously loaded comments are still shown."</p>
                            {action("retry-activity", "Retry activity")}
                        </div>
                        <div id="activity-empty" hidden><EmptyState title="No activity yet. Log progress as you go."/></div>
                        <ol id="activity"></ol>
                        <form id="activity-form" class="tasks-fields">
                            <Field><FormLabel control_id="comment">"Comment"</FormLabel><textarea id="comment" class="jds-input" required rows="3"></textarea></Field>
                            <div><Button kind=ButtonType::Submit variant=ButtonVariant::Secondary>"Add comment"</Button></div>
                            <p id="comment-error" hidden role="alert">"Could not post your comment. Your text is still here; try again."</p>
                            <p class="jds-caption">"Enter to post · Shift+Enter for a new line"</p>
                        </form>
                    </section>
                </div>
            </section>
            <section id="lists-editor" hidden aria-labelledby="lists-heading"><h2 id="lists-heading">"Your lists"</h2>
                <p class="jds-caption">"Your last list is kept. Move tasks to another list before deleting a list that has tasks. Tags from the deleted list are removed; tasks are kept."</p>
                <section id="delete-list-confirmation" hidden aria-labelledby="delete-list-title">
                    <h3 id="delete-list-title">"Delete list?"</h3>
                    <Field><FormLabel control_id="delete-list-destination">"Move tasks to"</FormLabel>
                        <select id="delete-list-destination" class="jds-input"></select>
                    </Field>
                    <p id="delete-list-error" role="alert" hidden></p>
                    <div class="tasks-actions">
                        {action("confirm-delete-list", "Delete list and keep tasks")}
                        <span id="keep-list">{action("keep-list", "Keep list")}</span>
                    </div>
                </section>
                <div id="list-names" class="tasks-fields"></div>
                <form id="list-form" class="tasks-inline">
                    <Field><FormLabel control_id="list-name">"New list"</FormLabel><input id="list-name" class="jds-input" required maxlength="100"/></Field>
                    <Button kind=ButtonType::Submit>"Create list"</Button>
                </form>
                {action("close-lists", "Back to tasks")}
            </section>
            <section id="tags-editor" hidden aria-labelledby="list-tags-heading">
                <h2 id="list-tags-heading">"List tags"</h2>
                <p>"Tags belong to this list. Open a task to assign or remove its tags."</p>
                <p id="tags-error" hidden role="alert"></p>
                <div id="tags-empty" hidden><EmptyState title="No tags yet" description="Create a tag to organise tasks in this list."/></div>
                <div id="tag-names" class="tasks-fields"></div>
                <form id="manage-tag-form" class="tasks-inline">
                    <Field><FormLabel control_id="manage-tag-name">"New list tag"</FormLabel><input id="manage-tag-name" class="jds-input" required maxlength="100"/></Field>
                    <Button kind=ButtonType::Submit>"Create tag"</Button>
                </form>
                {action("close-tags", "Back to lists")}
            </section>
        </main>
    }.to_html();
    format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Tasks · Moss</title><link rel=\"stylesheet\" href=\"/module-shared/park-press.css\"><link rel=\"stylesheet\" href=\"./tasks.css\"><script type=\"module\" src=\"./app.mjs\"></script></head><body>{html}</body></html>")
}
