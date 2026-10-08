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
  IconButton,
  Note,
  SectionHead,
  RowButton,
  Select,
  Thread
} from "@moss/ui";
import { Bell, Mail, Menu, Moon, Newspaper, Package, Sun, Tag, X } from "lucide-react";
import type { TranscriptRecord } from "@moss/shared";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "../styles/settings.css";
import "./scheduled-task-management.prototype.css";

type Status = "Active" | "Paused" | "Completed" | "Expired" | "Failed";
type Run = { summary: string; result: string; message?: string };
type Task = {
  id: string;
  title: string;
  kind: string;
  instruction: string;
  timing: string;
  stop: string;
  destination: string;
  actions?: string;
  status: Status;
  outcome: string;
  next: string;
  runs: Run[];
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
    status: "Active",
    outcome: "Saved today at 2:00 PM. Hasn't run yet.",
    next: "Tomorrow at 9:00 AM PDT",
    runs: []
  },
  {
    id: "news",
    title: "Latest AI News",
    kind: "Recurring check",
    instruction: "Check AI news and tell me only when something significant changes.",
    timing: "Every day at 8:00 AM PDT",
    stop: "Until I stop it",
    destination: "AI reading",
    status: "Active",
    outcome: "Today, 8:00 AM · Checked successfully. Nothing significant to report.",
    next: "Tomorrow at 8:00 AM PDT",
    runs: [
      {
        summary: "Today, 8:00 AM · Checked successfully; nothing to report",
        result: "No significant changes. No message sent."
      },
      {
        summary: "Yesterday, 8:00 AM · Update shared",
        result: "One significant update was found and posted in AI reading.",
        message:
          "A new AI model release appeared in your news feeds this morning. I've gathered the announcement for your reading."
      },
      {
        summary: "Tuesday, 8:00 AM · Checked successfully; nothing to report",
        result: "No significant changes. No message sent."
      }
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
    status: "Paused",
    outcome: "1:45 PM · No reply yet. Paused at 1:50 PM.",
    next: "Paused · no future checks",
    runs: [
      {
        summary: "Today, 1:45 PM · Checked successfully; no reply",
        result: "No matching reply was found. No message was sent."
      }
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
    runs: [
      {
        summary: "Friday, 4:00 PM · Failed; no changes made",
        result:
          "Email access had been revoked. The run stopped before reading or changing any emails."
      },
      {
        summary: "Previous Friday, 4:00 PM · Completed",
        result:
          "Archived 3 newsletters older than 7 days. Permanently deleted 2 promotional emails older than 30 days.",
        message:
          "I archived 3 older Field Notes newsletters and permanently deleted 2 promotional emails, within the actions you approved."
      }
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
    status: "Completed",
    outcome: "Yesterday, 11:10 AM · Carrier confirmed delivery. Watch stopped.",
    next: "Finished · no future checks",
    runs: [
      {
        summary: "Yesterday, 11:10 AM · Delivery confirmed; watch completed",
        result:
          "Recorded carrier status: Delivered, yesterday at 11:10 AM. That confirmed the goal and stopped the watch.",
        message:
          "The carrier confirmed your parcel was delivered at 11:10 AM. I've stopped the delivery watch."
      }
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
    status: "Expired",
    outcome: "Sunday, 6:00 PM · Deadline reached without a sale.",
    next: "Expired · no future checks",
    runs: [
      {
        summary: "Sunday, 6:00 PM · Watch expired",
        result:
          "The deadline passed without a matching sale. No sale alert was sent, and future checks stopped."
      }
    ]
  }
];
const destinations = ["Main chat", "AI reading", "Home projects"];
const groups = ["Reminders", "Daily", "Weekly", "More often", "Watches", "Past tasks"];
const taskIcons = {
  proposal: Bell,
  news: Newspaper,
  maya: Mail,
  cleanup: Mail,
  delivery: Package,
  sale: Tag
};
function taskGroup(task: Task) {
  if (task.status === "Completed" || task.status === "Expired") return "Past tasks";
  if (task.kind === "Reminder") return "Reminders";
  if (task.kind === "Watch") return "Watches";
  // ponytail: fictional timing labels; production groups use structured schedule fields.
  if (/week|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(task.timing))
    return "Weekly";
  return /\bday\b|daily/i.test(task.timing) ? "Daily" : "More often";
}
const params = new URLSearchParams(location.search);

function Prototype() {
  const [tasks, setTasks] = useState(() => structuredClone(samples));
  const [selectedId, setSelectedId] = useState<string | null>(params.get("task"));
  const selected = tasks.find((t) => t.id === selectedId);
  const [deleting, setDeleting] = useState(false);
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
      text: "You can pause or stop tasks here. Tell me in chat whenever you’d like to change one."
    }
  ]);
  const [chatDelete, setChatDelete] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const paneHeading = useRef<HTMLHeadingElement>(null);
  const keepTaskButton = useRef<HTMLButtonElement>(null);
  const lastTask = useRef<string | null>(selectedId);
  const chatReturn = useRef<HTMLElement | null>(null);
  const chatPanel = useRef<HTMLElement>(null);
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (selectedId) {
      lastTask.current = selectedId;
      (deleting ? keepTaskButton.current : detailHeading.current)?.focus();
    } else if (lastTask.current) {
      const row = document.querySelector<HTMLElement>(
        `[data-task-id="${CSS.escape(lastTask.current)}"]`
      );
      (row ?? paneHeading.current)?.focus();
    }
  }, [selectedId, deleting]);
  useEffect(() => {
    if (!chatOpen) return;
    composer.current?.focus();
    return () => {
      requestAnimationFrame(() => chatReturn.current?.focus());
    };
  }, [chatOpen]);
  useEffect(() => {
    if (!chatOpen || chatMenu) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setChatOpen(false);
        return;
      }
      if (!phone || event.key !== "Tab") return;
      const controls = [
        ...(chatPanel.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), textarea, a[href]"
        ) ?? [])
      ];
      const first = controls[0],
        last = controls.at(-1);
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
  }, [chatOpen, phone, chatMenu]);
  function openChat() {
    chatReturn.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setChatOpen(true);
  }
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  }, [dark, theme]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set("task", selectedId);
    else url.searchParams.delete("task");
    history.replaceState(null, "", url);
    console.info("Management preview state", { tasks, selectedId, deleting, screen });
  }, [tasks, selectedId, deleting, screen]);
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
        next: status === "Paused" ? "Paused · no future checks" : task.timing
      },
      `${task.title} ${status === "Paused" ? "paused" : "resumed"}.`
    );
  }
  function remove(task: Task) {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setNotice(`${task.title} deleted. Future work has stopped; completed actions are unchanged.`);
    setSelectedId(null);
    setDeleting(false);
  }
  function send() {
    const request = text.trim();
    if (!request) return;
    setText("");
    let reply =
      "Try ‘make AI news weekly’, ‘pause AI news’, ‘resume AI news’, or ‘delete AI news’ in this preview.";
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
          next: status === "Paused" ? "Paused · no future checks" : task.timing
        },
        "Updated from chat."
      );
      reply =
        status === "Paused"
          ? "I've paused the AI news check. I won't check again until you resume it."
          : `I've resumed the AI news check. I'll check ${task.timing.toLowerCase()} and only tell you when something significant changes.`;
    } else if (task && /^(make AI news|change AI news to) (weekly|daily)[.!]?$/i.test(request)) {
      const weekly = /weekly/i.test(request);
      const timing = weekly ? "Every Friday at 8:00 AM PDT" : "Every day at 8:00 AM PDT";
      update(
        { ...task, timing, next: task.status === "Active" ? timing : task.next },
        "Schedule changed in chat."
      );
      reply = weekly
        ? "I'll check AI news every Friday at 8 AM PDT instead. The same actions and destination still apply."
        : "I'll check AI news every day at 8 AM PDT instead. The same actions and destination still apply.";
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

  return (
    <div className="manage-preview">
      <div className="manage-review" inert={chatOpen && phone}>
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
              setDeleting(false);
              setNotice("");
              setScreen("ready");
              setChatDelete(false);
            }}
          >
            Reset sample
          </Button>
        </div>
      </div>
      <div className="manage-shell">
        <aside className="manage-appnav" inert={chatOpen && phone}>
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
        <main className="set2" inert={chatOpen && phone}>
          <div className="set2__mast">
            <h1 className="set2__masttitle">Settings</h1>
            <Button
              variant="secondary"
              onClick={() => (chatOpen ? setChatOpen(false) : openChat())}
            >
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
              <h2 className="manage-pane-title" ref={paneHeading} tabIndex={-1}>
                Scheduled tasks
              </h2>
              <p className="manage-lede">What Moss is keeping an eye on for you.</p>
              <p className="manage-notice" role="status">
                {notice}
              </p>
              {!selected && (
                <>
                  <div className="manage-filter">
                    <Button variant="link" onClick={openChat}>
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
                  ) : screen === "empty" || tasks.length === 0 ? (
                    <EmptyState
                      title="Nothing scheduled yet"
                      description="Ask Moss in chat to remind you, check for updates, or watch for something."
                    >
                      <Button onClick={openChat}>Open chat</Button>
                    </EmptyState>
                  ) : (
                    <div className="manage-groups">
                      {groups.map((group) => {
                        const entries = tasks.filter((task) => taskGroup(task) === group);
                        if (!entries.length) return null;
                        const rows = entries.map((task) => {
                          const Icon = taskIcons[task.id as keyof typeof taskIcons] ?? Bell;
                          return (
                            <RowButton
                              key={task.id}
                              data-task-id={task.id}
                              className="manage-task-row"
                              onClick={() => {
                                setNotice("");
                                setSelectedId(task.id);
                                setDeleting(false);
                              }}
                            >
                              <Icon size={21} strokeWidth={1.6} aria-hidden="true" />
                              <span>{task.title}</span>
                            </RowButton>
                          );
                        });
                        return group === "Past tasks" ? (
                          <details className="manage-group manage-past" key={group}>
                            <summary>{group}</summary>
                            <div className="manage-list">{rows}</div>
                          </details>
                        ) : (
                          <section className="manage-group" key={group} aria-label={group}>
                            <SectionHead title={group} titleAs="h3" />
                            <div className="manage-list">{rows}</div>
                          </section>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
              {selected && (
                <>
                  <Button
                    variant="link"
                    onClick={() => {
                      setNotice("");
                      setSelectedId(null);
                      setDeleting(false);
                    }}
                  >
                    Back to all tasks
                  </Button>
                  <div className="manage-detail-head">
                    <h2 ref={detailHeading} tabIndex={-1}>
                      {selected.title}
                    </h2>
                    <span
                      className={`manage-status manage-status--${selected.status.toLowerCase()}`}
                    >
                      {selected.status}
                    </span>
                  </div>
                  {!deleting && (
                    <>
                      <p>{selected.instruction}</p>
                      {(selected.status === "Active" ||
                        selected.status === "Paused" ||
                        selected.status === "Failed") && (
                        <dl className="manage-facts">
                          <dt>Schedule</dt>
                          <dd>{selected.timing}</dd>
                          {selected.kind === "Watch" && (
                            <>
                              <dt>Stops</dt>
                              <dd>{selected.stop}</dd>
                            </>
                          )}
                          {selected.destination !== "Main chat" && (
                            <>
                              <dt>Results go to</dt>
                              <dd>{selected.destination}</dd>
                            </>
                          )}
                        </dl>
                      )}
                      {selected.status === "Failed" && (
                        <Note variant="practical">
                          Reconnect email in Connections, then ask Moss in chat to resume this task.
                        </Note>
                      )}
                      <div className="manage-actions">
                        {(selected.status === "Active" || selected.status === "Paused") && (
                          <Button variant="secondary" onClick={() => pause(selected)}>
                            {selected.status === "Paused" ? "Resume" : "Pause"}
                          </Button>
                        )}
                        <Button variant="danger" onClick={() => setDeleting(true)}>
                          Delete task
                        </Button>
                      </div>
                      {selected.actions && (
                        <details className="manage-scope">
                          <summary>What Moss may change</summary>
                          <p>{selected.actions}</p>
                        </details>
                      )}
                      <section className="manage-history">
                        <SectionHead title="Run history" />
                        {selected.runs.length ? (
                          <ul>
                            {selected.runs.map((run, i) => (
                              <li key={i}>
                                <details>
                                  <summary>{run.summary}</summary>
                                  <div className="manage-run-result">
                                    <p>{run.result}</p>
                                    {run.message && (
                                      <Button
                                        variant="link"
                                        onClick={() => {
                                          setTopic(selected.destination);
                                          setRecords([{ kind: "reply", text: run.message! }]);
                                          openChat();
                                        }}
                                      >
                                        View message
                                      </Button>
                                    )}
                                  </div>
                                </details>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="manage-meta">Hasn't run yet.</p>
                        )}
                      </section>
                    </>
                  )}
                  {deleting && (
                    <div className="manage-delete">
                      <SectionHead title="Delete this task?" />
                      <p>
                        Future runs will stop. Previous messages and completed actions remain.
                        {selected.actions && " This won't undo any email archive or deletion."}
                      </p>
                      <div className="manage-actions">
                        <Button variant="danger" onClick={() => remove(selected)}>
                          Delete task
                        </Button>
                        <Button
                          ref={keepTaskButton}
                          variant="secondary"
                          onClick={() => setDeleting(false)}
                        >
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
          <aside
            ref={chatPanel}
            className="manage-chat"
            aria-label="Moss chat"
            role={phone ? "dialog" : undefined}
            aria-modal={phone ? true : undefined}
          >
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
