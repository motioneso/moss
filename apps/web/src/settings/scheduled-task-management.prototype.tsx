/** THROWAWAY #3101. One complete Settings management flow, fictional browser-memory state.
 * Hallmark · inherited Park Press system · pre-emit critique: P4 H4 E4 S5 R5 V3
 * Question: can people understand, change and stop Moss's responsibilities here?
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrandMark,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  FormLabel,
  IconButton,
  Note,
  SectionHead,
  Select,
  Thread
} from "@moss/ui";
import { Menu, Moon, Sun, X } from "lucide-react";
import type { TranscriptRecord } from "@moss/shared";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "../styles/settings.css";
import "./scheduled-task-management.prototype.css";

type Status = "Active" | "Paused" | "Completed" | "Expired" | "Failed";
type Task = {
  id: string;
  title: string;
  kind: string;
  instruction: string;
  timing: string;
  stop: string;
  destination: string;
  actions: string;
  status: Status;
  outcome: string;
  next: string;
  history: string[];
};
const samples: Task[] = [
  {
    id: "proposal",
    title: "Send the proposal",
    kind: "Reminder",
    instruction: "Remind me to send Maya the proposal.",
    timing: "Thursday 8 October, 9:00 AM PDT",
    stop: "After the reminder is delivered",
    destination: "Main chat",
    actions: "Post a reminder in chat",
    status: "Active",
    outcome: "Saved today at 2:00 PM. Hasn't run yet.",
    next: "Tomorrow at 9:00 AM PDT",
    history: ["Today, 2:00 PM · Saved from main chat."]
  },
  {
    id: "news",
    title: "Keep an eye on AI news",
    kind: "Recurring check",
    instruction: "Check AI news and tell me only when something significant changes.",
    timing: "Every hour",
    stop: "Until I stop it",
    destination: "AI reading",
    actions: "Read AI news; report significant changes",
    status: "Active",
    outcome: "2:00 PM · Checked successfully. Nothing significant to report.",
    next: "Today at 3:00 PM PDT",
    history: [
      "Today, 2:00 PM · Successful quiet check. No message sent.",
      "Today, 1:00 PM · Shared one useful update in AI reading."
    ]
  },
  {
    id: "maya",
    title: "Watch for Maya's reply",
    kind: "Watch",
    instruction: "Tell me when Maya replies about the proposal, then stop.",
    timing: "Every 15 minutes",
    stop: "When Maya replies, or today at 5:00 PM PDT",
    destination: "Main chat",
    actions: "Read inbox replies from Maya about the proposal; report the reply",
    status: "Paused",
    outcome: "1:45 PM · No reply yet. Paused at 1:50 PM.",
    next: "Paused · no future checks",
    history: [
      "Today, 1:50 PM · Paused by you.",
      "Today, 1:45 PM · Checked successfully. No matching reply."
    ]
  },
  {
    id: "cleanup",
    title: "A lighter inbox",
    kind: "Recurring task",
    instruction: "Tidy emails from Field Notes and report what changed.",
    timing: "Every Friday at 4:00 PM PDT",
    stop: "Until I stop it",
    destination: "Main chat",
    actions:
      "Read Field Notes emails; archive newsletters over 7 days old; permanently delete promotional emails over 30 days old; report changes",
    status: "Failed",
    outcome: "Friday, 4:00 PM · Couldn't access email. No changes made.",
    next: "Waiting for you to reconnect email",
    history: [
      "Friday, 4:00 PM · Email access revoked. No changes made; task needs attention.",
      "Previous Friday, 4:00 PM · Archived 3 newsletters and deleted 2 promotional emails."
    ]
  },
  {
    id: "delivery",
    title: "Check the parcel arrived",
    kind: "Watch",
    instruction: "Check for delivery and stop once the parcel is confirmed delivered.",
    timing: "Every hour",
    stop: "When delivery is confirmed",
    destination: "Home projects",
    actions: "Read carrier tracking; report confirmed delivery",
    status: "Completed",
    outcome: "Yesterday, 11:10 AM · Carrier confirmed delivery. Watch stopped.",
    next: "Finished · no future checks",
    history: [
      "Yesterday, 11:10 AM · Carrier tracking confirmed delivery. Watch completed.",
      "Yesterday, 11:10 AM · Posted the result in Home projects."
    ]
  },
  {
    id: "sale",
    title: "Watch for the weekend sale",
    kind: "Watch",
    instruction: "Tell me if the lamp goes on sale before Sunday evening.",
    timing: "Every two hours",
    stop: "Sunday 4 October at 6:00 PM PDT",
    destination: "Main chat",
    actions: "Read the lamp's price; report a sale",
    status: "Expired",
    outcome: "Sunday, 6:00 PM · Deadline reached without a sale.",
    next: "Expired · no future checks",
    history: ["Sunday, 6:00 PM · Deadline reached. Watch stopped without a match."]
  }
];
const destinations = ["Main chat", "AI reading", "Home projects"];
const params = new URLSearchParams(location.search);

function Prototype() {
  const [tasks, setTasks] = useState(() => structuredClone(samples));
  const [selectedId, setSelectedId] = useState<string | null>(params.get("task"));
  const selected = tasks.find((t) => t.id === selectedId);
  const [draft, setDraft] = useState<Task | null>(null);
  const [approval, setApproval] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState("All");
  const [screen, setScreen] = useState(params.get("state") ?? "ready");
  const [notice, setNotice] = useState("");
  const [dark, setDark] = useState(false);
  const [theme, setTheme] = useState("default");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [topic, setTopic] = useState("Main chat");
  const [sideChats, setSideChats] = useState(destinations.slice(1));
  const [text, setText] = useState("");
  const [records, setRecords] = useState<TranscriptRecord[]>([
    {
      kind: "reply",
      text: "You can change or stop any of these tasks here or in chat. Try ‘pause AI news’, ‘resume AI news’, or ‘delete AI news’."
    }
  ]);
  const [chatDelete, setChatDelete] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  }, [dark, theme]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set("task", selectedId);
    else url.searchParams.delete("task");
    history.replaceState(null, "", url);
    console.info("Management preview state", { tasks, selectedId, approval, deleting, screen });
  }, [tasks, selectedId, approval, deleting, screen]);
  useEffect(() => {
    if (!chatMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatMenu(false);
        menuButton.current?.focus();
      }
      if (event.key !== "Tab") return;
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const first = buttons[0],
        last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [chatMenu]);
  function update(task: Task, message: string) {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    setNotice(message);
  }
  function pause(task: Task) {
    const status = task.status === "Paused" ? "Active" : "Paused";
    update(
      {
        ...task,
        status,
        next: status === "Paused" ? "Paused · no future checks" : task.timing,
        history: [
          `Today, 2:00 PM · ${status === "Paused" ? "Paused" : "Resumed"} by you.`,
          ...task.history
        ]
      },
      `${task.title} ${status === "Paused" ? "paused" : "resumed"}.`
    );
  }
  function remove(task: Task) {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setNotice(`${task.title} deleted. Future work has stopped; completed actions are unchanged.`);
    setSelectedId(null);
    setDeleting(false);
    setDraft(null);
  }
  function save() {
    if (!draft || !selected) return;
    if (draft.actions.trim() !== selected.actions.trim() && !approval) {
      setApproval(true);
      return;
    }
    update(
      {
        ...draft,
        next: draft.status === "Active" ? draft.timing : draft.next,
        history: [
          `Today, 2:00 PM · ${approval ? "New actions approved; edits saved. No run started." : "Edits saved. Allowed actions unchanged."}`,
          ...selected.history
        ]
      },
      "Changes saved. The task hasn't been run again."
    );
    setDraft(null);
    setApproval(false);
  }
  function send() {
    const request = text.trim();
    if (!request) return;
    setText("");
    let reply =
      "This preview simulates ‘pause AI news’, ‘resume AI news’, and ‘delete AI news’. Use Settings for other edits.";
    const task = tasks.find((t) => t.id === "news");
    if (chatDelete) {
      if (/^(yes|yes please|delete it)[.!]?$/i.test(request) && task) {
        remove(task);
        reply =
          "I've deleted the AI news check. Future checks have stopped; previous messages remain.";
      } else reply = "I've kept the AI news check.";
      setChatDelete(false);
    } else if (task && /^(pause|resume) AI news[.!]?$/i.test(request)) {
      const status = /^pause/i.test(request) ? "Paused" : "Active";
      update(
        {
          ...task,
          status,
          next: status === "Paused" ? "Paused · no future checks" : task.timing,
          history: [
            `Today, 2:00 PM · ${status === "Paused" ? "Paused" : "Resumed"} from chat.`,
            ...task.history
          ]
        },
        "Updated from chat."
      );
      reply =
        status === "Paused"
          ? "I've paused the AI news check. I won't check again until you resume it."
          : "I've resumed the AI news check. I'll check every hour and only tell you when something significant changes.";
    } else if (task && /^delete AI news[.!]?$/i.test(request)) {
      setChatDelete(true);
      reply = "Delete the AI news check? That stops future checks and keeps previous messages.";
    } else if (!task && /AI news/i.test(request))
      reply = "That AI news check has been deleted. Its earlier messages remain in chat.";
    setRecords((prev) => [
      ...prev,
      { kind: "user", text: request },
      { kind: "reply", text: reply }
    ]);
  }
  const visible = tasks.filter((t) => filter === "All" || t.status === filter);
  return (
    <div className="manage-preview">
      <div className="manage-review">
        <Eyebrow>Design preview · #3101 · fictional data</Eyebrow>
        <div className="manage-actions">
          <Select
            aria-label="Preview state"
            value={screen}
            onChange={(e) => setScreen(e.target.value)}
          >
            {["ready", "empty", "loading", "error"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="default">Forest</option>
            <option value="teal">Teal</option>
          </Select>
          <IconButton
            aria-label={dark ? "Use light mode" : "Use dark mode"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun /> : <Moon />}
          </IconButton>
          <Button
            variant="secondary"
            onClick={() => {
              setTasks(structuredClone(samples));
              setSelectedId(null);
              setDraft(null);
              setApproval(false);
              setDeleting(false);
              setNotice("");
              setScreen("ready");
              setFilter("All");
              setChatDelete(false);
            }}
          >
            Reset sample
          </Button>
        </div>
      </div>
      <div className="manage-shell">
        <aside className="manage-appnav">
          <div className="brand-lockup">
            <BrandMark size={28} />
            <strong className="brand-wordmark">Moss</strong>
          </div>
          <div className="module-nav">
            {["Today", "Calendar", "Tasks", "Notes", "Email", "Settings"].map((label) => (
              <div key={label} className={`module-link ${label === "Settings" ? "active" : ""}`}>
                {label}
              </div>
            ))}
          </div>
        </aside>
        <main className="set2">
          <div className="set2__mast">
            <h1 className="set2__masttitle">Settings</h1>
            <Button variant="secondary" onClick={() => setChatOpen(!chatOpen)}>
              {chatOpen ? "Close chat" : "Open chat"}
            </Button>
          </div>
          <div className="manage-settings-grid">
            <nav className="manage-categories" aria-label="Settings context">
              <Eyebrow>Moss</Eyebrow>
              {["Assistant", "Priorities", "Memory", "Scheduled tasks"].map((label) => (
                <div
                  key={label}
                  className={`set2__navitem ${label === "Scheduled tasks" ? "is-active" : ""}`}
                  aria-current={label === "Scheduled tasks" ? "page" : undefined}
                >
                  {label}
                </div>
              ))}
            </nav>
            <section className="manage-pane" aria-label="Scheduled tasks">
              <SectionHead title="Scheduled tasks" />
              <p className="manage-lede">What Moss is keeping an eye on for you.</p>
              <p className="manage-notice" role="status">
                {notice}
              </p>
              {!selected && (
                <>
                  <div className="manage-filter">
                    <Field>
                      <FormLabel htmlFor="status-filter">Show</FormLabel>
                      <Select
                        id="status-filter"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        {["All", "Active", "Paused", "Completed", "Expired", "Failed"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </Select>
                    </Field>
                    <Button variant="link" onClick={() => setChatOpen(true)}>
                      Ask Moss to set something up
                    </Button>
                  </div>
                  {screen === "loading" ? (
                    <p role="status">Loading your scheduled tasks…</p>
                  ) : screen === "error" ? (
                    <EmptyState
                      title="Couldn't load your tasks"
                      description="Your saved schedules haven't changed."
                    >
                      <Button onClick={() => setScreen("ready")}>Try again</Button>
                    </EmptyState>
                  ) : screen === "empty" || visible.length === 0 ? (
                    <EmptyState
                      title={
                        filter === "All"
                          ? "Nothing scheduled yet"
                          : `No ${filter.toLowerCase()} tasks`
                      }
                      description="Ask Moss in chat to remind you, check for updates, or watch for something."
                    >
                      <Button onClick={() => setChatOpen(true)}>Open chat</Button>
                    </EmptyState>
                  ) : (
                    <div className="manage-list">
                      {visible.map((task) => (
                        <article className="set-row" key={task.id}>
                          <div className="set-row__main">
                            <div className="manage-rowhead">
                              <Button
                                variant="link"
                                onClick={() => {
                                  setSelectedId(task.id);
                                  setDraft(null);
                                  setDeleting(false);
                                }}
                              >
                                {task.title}
                              </Button>
                              <span
                                className={`manage-status manage-status--${task.status.toLowerCase()}`}
                              >
                                {task.status}
                              </span>
                            </div>
                            <p>{task.instruction}</p>
                            <p className="manage-meta">
                              {task.kind} · {task.timing} · {task.destination}
                            </p>
                            <p className="manage-outcome">{task.outcome}</p>
                          </div>
                          {(task.status === "Active" || task.status === "Paused") && (
                            <Button variant="secondary" size="sm" onClick={() => pause(task)}>
                              {task.status === "Paused" ? "Resume" : "Pause"}
                              <span className="manage-sr"> {task.title}</span>
                            </Button>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
              {selected && (
                <>
                  <Button
                    variant="link"
                    onClick={() => {
                      setSelectedId(null);
                      setDraft(null);
                      setApproval(false);
                      setDeleting(false);
                    }}
                  >
                    Back to all tasks
                  </Button>
                  <div className="manage-detail-head">
                    <h2>{selected.title}</h2>
                    <span
                      className={`manage-status manage-status--${selected.status.toLowerCase()}`}
                    >
                      {selected.status}
                    </span>
                  </div>
                  {!draft && !deleting && (
                    <>
                      <p>{selected.instruction}</p>
                      <dl className="manage-facts">
                        <dt>Timing</dt>
                        <dd>{selected.timing}</dd>
                        <dt>Stops</dt>
                        <dd>{selected.stop}</dd>
                        <dt>Results go to</dt>
                        <dd>{selected.destination}</dd>
                        <dt>Next</dt>
                        <dd>{selected.next}</dd>
                        <dt>Allowed actions</dt>
                        <dd>{selected.actions}</dd>
                      </dl>
                      {selected.status === "Failed" && (
                        <Note variant="practical">
                          Reconnect email in Connections, then resume this task. Saving edits won't
                          retry it or repeat previous changes.
                        </Note>
                      )}
                      <div className="manage-actions">
                        <Button onClick={() => setDraft({ ...selected })}>Edit task</Button>
                        {(selected.status === "Active" || selected.status === "Paused") && (
                          <Button variant="secondary" onClick={() => pause(selected)}>
                            {selected.status === "Paused" ? "Resume" : "Pause"}
                          </Button>
                        )}
                        <Button variant="danger" onClick={() => setDeleting(true)}>
                          Delete task
                        </Button>
                      </div>
                      <section className="manage-history">
                        <SectionHead title="Recent activity" />
                        <ul>
                          {selected.history.map((entry, i) => (
                            <li key={i}>{entry}</li>
                          ))}
                        </ul>
                      </section>
                    </>
                  )}
                  {draft && (
                    <form
                      className="manage-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        save();
                      }}
                    >
                      {approval ? (
                        <>
                          <SectionHead title="Approve changed actions" />
                          <p>
                            These are the actions Moss will be allowed to perform without asking
                            again. The task keeps its current actions until you approve.
                          </p>
                          <h3>Currently allowed</h3>
                          <p>{selected.actions}</p>
                          <h3>New allowed actions</h3>
                          <p>{draft.actions}</p>
                          <Note variant="practical">
                            Approving saves this edit. It won't run the task again or restore a
                            finished task.
                          </Note>
                          <div className="manage-actions">
                            <Button type="submit">Approve and save</Button>
                            <Button variant="secondary" onClick={() => setApproval(false)}>
                              Back to edit
                            </Button>
                            <Button
                              variant="quiet"
                              onClick={() => {
                                setDraft(null);
                                setApproval(false);
                              }}
                            >
                              Discard changes
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <Field>
                            <FormLabel htmlFor="instruction">Instruction</FormLabel>
                            <textarea
                              id="instruction"
                              className="jds-textarea"
                              required
                              value={draft.instruction}
                              onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
                            />
                          </Field>
                          <Field>
                            <FormLabel htmlFor="timing">Timing</FormLabel>
                            <input
                              id="timing"
                              className="jds-input"
                              required
                              value={draft.timing}
                              onChange={(e) => setDraft({ ...draft, timing: e.target.value })}
                            />
                          </Field>
                          <Field>
                            <FormLabel htmlFor="stop">Stop condition or deadline</FormLabel>
                            <input
                              id="stop"
                              className="jds-input"
                              required
                              value={draft.stop}
                              onChange={(e) => setDraft({ ...draft, stop: e.target.value })}
                            />
                          </Field>
                          <Field>
                            <FormLabel htmlFor="destination">Results go to</FormLabel>
                            <Select
                              id="destination"
                              value={draft.destination}
                              onChange={(e) => setDraft({ ...draft, destination: e.target.value })}
                            >
                              {destinations.map((d) => (
                                <option key={d}>{d}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field>
                            <FormLabel htmlFor="actions">Allowed actions</FormLabel>
                            <textarea
                              id="actions"
                              className="jds-textarea"
                              required
                              value={draft.actions}
                              onChange={(e) => setDraft({ ...draft, actions: e.target.value })}
                            />
                          </Field>
                          <p className="manage-meta">
                            Changing allowed actions needs your approval. Timing and destination
                            changes don't. Instructions stay within the allowed actions.
                          </p>
                          <div className="manage-actions">
                            <Button type="submit">
                              {draft.actions.trim() !== selected.actions.trim()
                                ? "Review changed actions"
                                : "Save changes"}
                            </Button>
                            <Button variant="secondary" onClick={() => setDraft(null)}>
                              Cancel
                            </Button>
                          </div>
                        </>
                      )}
                    </form>
                  )}
                  {deleting && (
                    <div className="manage-form">
                      <SectionHead title="Delete this task?" />
                      <p>
                        Moss will stop future work for “{selected.title}”. Previous messages and
                        completed actions remain. Deleting this schedule won't undo any archive or
                        deletion.
                      </p>
                      <div className="manage-actions">
                        <Button variant="danger" onClick={() => remove(selected)}>
                          Delete schedule
                        </Button>
                        <Button variant="secondary" onClick={() => setDeleting(false)}>
                          Keep task
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </main>
        {chatOpen && (
          <aside className="manage-chat" aria-label="Moss chat">
            <header>
              <IconButton
                ref={menuButton}
                aria-label="Conversation menu"
                aria-expanded={chatMenu}
                onClick={() => setChatMenu(!chatMenu)}
              >
                <Menu />
              </IconButton>
              <h2>{topic}</h2>
              <IconButton
                aria-label="Close Moss chat"
                onClick={() => {
                  setChatOpen(false);
                  setChatMenu(false);
                }}
              >
                <X />
              </IconButton>
            </header>
            {chatMenu && (
              <>
                <button
                  className="manage-scrim"
                  aria-label="Close conversation menu"
                  onClick={() => {
                    setChatMenu(false);
                    menuButton.current?.focus();
                  }}
                />
                <div
                  className="manage-chatmenu"
                  ref={menuRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Conversations"
                >
                  <Button
                    onClick={() => {
                      setSideChats((prev) => [...prev, "New side chat"]);
                      setTopic("New side chat");
                      setRecords([]);
                      setChatMenu(false);
                      requestAnimationFrame(() => composer.current?.focus());
                    }}
                  >
                    New side chat
                  </Button>
                  {["Main chat", ...sideChats].map((name, i) => (
                    <Button
                      key={i}
                      variant="quiet"
                      onClick={() => {
                        setTopic(name);
                        setChatMenu(false);
                        menuButton.current?.focus();
                      }}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              </>
            )}
            <div className="manage-chatcontent" inert={chatMenu}>
              <div className="manage-transcript">
                <Thread records={records} />
              </div>
              <form
                className="manage-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (topic === "New side chat" && text.trim()) {
                    setTopic(text.trim().slice(0, 30));
                    setSideChats((prev) => [...prev.slice(0, -1), text.trim().slice(0, 30)]);
                  }
                  send();
                }}
              >
                <textarea
                  ref={composer}
                  className="jds-textarea"
                  aria-label="Message Moss"
                  placeholder="Message Moss…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button type="submit" disabled={!text.trim()}>
                  Send
                </Button>
              </form>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Prototype />);
