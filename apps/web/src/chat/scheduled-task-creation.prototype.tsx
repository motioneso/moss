/** THROWAWAY #3100: three creation layouts in accepted chat; ?variant=A|B|C.
 * Fictional samples and memory-only state. Never imported by the production app.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCheck,
  FileText,
  House,
  Mail,
  Menu,
  Moon,
  Plus,
  Settings,
  Sun,
  X
} from "lucide-react";
import {
  Avatar,
  Badge,
  BrandMark,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  FormLabel,
  IconButton,
  Masthead,
  NavIndex,
  NavIndexItem,
  Note,
  SectionHead,
  Select,
  Thread
} from "@moss/ui";
import type { TranscriptRecord } from "@moss/shared";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "./main-side-chats.prototype.css";
import "./scheduled-task-creation.prototype.css";

type Variant = "A" | "B" | "C";
type Scenario = "reminder" | "watch" | "suggestion" | "cleanup";
type Status = "ready" | "proposed" | "approval" | "saved" | "declined";
type Task = {
  title: string;
  request: string;
  instruction: string;
  when: string;
  end?: string;
  actions: string[];
  changes?: boolean;
};
const examples: Record<Scenario, Task> = {
  reminder: {
    title: "Send the proposal",
    request: "Remind me tomorrow at 9 AM to send Maya the proposal.",
    instruction: "Remind me to send Maya the proposal.",
    when: "Tomorrow, Thu 8 Oct · 9:00 AM PDT",
    actions: ["Post a reminder"]
  },
  watch: {
    title: "Maya’s reply",
    request:
      "Check my inbox every 15 minutes for Maya's reply about the proposal for the next three hours. Tell me when it arrives, then stop.",
    instruction: "Watch for Maya’s reply about the proposal and tell me when it arrives.",
    when: "Every 15 minutes · starting now, 2:00 PM PDT",
    end: "Until Maya replies or 5:00 PM PDT today (3 hours)",
    actions: ["Read inbox messages from Maya about the proposal", "Report when her reply arrives"]
  },
  suggestion: {
    title: "Maya’s reply",
    request:
      "I'm waiting for Maya to reply about the proposal, but I need to get on with my afternoon.",
    instruction: "Watch for Maya’s reply about the proposal and tell me when it arrives.",
    when: "Every 15 minutes · starting now, 2:00 PM PDT",
    end: "Until Maya replies or 5:00 PM PDT today (3 hours)",
    actions: ["Read inbox messages from Maya about the proposal", "Report when her reply arrives"]
  },
  cleanup: {
    title: "A lighter inbox",
    request:
      "Every Friday at 4 PM, archive newsletters from Field Notes that are over a week old and permanently delete their promotional emails that are over 30 days old. Tell me what you changed.",
    instruction: "Tidy emails from Field Notes and report what changed.",
    when: "Every Friday · 4:00 PM PDT · first run Fri 9 Oct",
    actions: [
      "Read emails from Field Notes",
      "Archive Field Notes newsletters over 7 days old",
      "Permanently delete Field Notes promotional emails over 30 days old",
      "Report what changed"
    ],
    changes: true
  }
};
const layouts = [
  { key: "A", name: "Conversation", description: "A plain reply, with the decision in chat." },
  { key: "B", name: "Task sheet", description: "A structured summary inside the conversation." },
  { key: "C", name: "Focused review", description: "A dedicated task view inside the same chat." }
] as const;
const params = new URLSearchParams(location.search);
const initialVariant = layouts.find((v) => v.key === params.get("variant"))?.key ?? "A";
const initialScenario = Object.keys(examples).find((key) => key === params.get("example")) as
  | Scenario
  | undefined;

type FlowProps = {
  task: Task;
  status: Status;
  destination: string;
  accept: () => void;
  decline: () => void;
};
function Decision({ task, status, accept, decline }: FlowProps) {
  if (status !== "approval" && status !== "proposed") return null;
  return (
    <div className="create-actions">
      <Button onClick={accept}>
        {task.changes ? "Approve actions & save" : "Yes, watch for her reply"}
      </Button>
      <Button variant="quiet" onClick={decline}>
        {task.changes ? "Don’t save" : "No thanks"}
      </Button>
    </div>
  );
}
function PermissionNote({ task }: { task: Task }) {
  if (!task.changes) return null;
  return (
    <Note variant="practical" className="create-permission">
      <p>Saving approves these actions for this task. It will run without asking again.</p>
      <p>Other actions won’t run. Turning off access still stops it.</p>
    </Note>
  );
}
function VariantA(props: FlowProps) {
  const { task, status, destination } = props;
  return (
    <section className="create-conversational" aria-label="Task summary">
      <Eyebrow tone="accent">
        {status === "saved" ? "Saved" : task.changes ? "Approve once" : "Moss suggests"}
      </Eyebrow>
      <p>
        {status === "saved"
          ? "I’ve saved this:"
          : task.changes
            ? "Before I save this, approve the actions it will take:"
            : "Want me to watch for her reply for the next three hours?"}
      </p>
      <p>
        <strong>{task.instruction}</strong> {task.when}. {task.end && <>Watch ends: {task.end}.</>}{" "}
        Results go to <strong>{destination}</strong>.
      </p>
      {task.changes ? (
        <>
          <p>{status === "saved" ? "Approved actions:" : "This task will:"}</p>
          <ul>
            {task.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          What I’ll do: {task.actions.join("; ")}.{" "}
          {task.end && "I’ll only message when her reply arrives."}
        </p>
      )}
      {status !== "saved" && <PermissionNote task={task} />}
      {status === "saved" && task.changes && (
        <p>It will run without asking again, within these approved actions.</p>
      )}
      <Decision {...props} />
    </section>
  );
}
function VariantB(props: FlowProps) {
  const { task, status, destination } = props;
  return (
    <section className="create-sheet" aria-label="Task summary">
      <div className="create-sheet-head">
        <Eyebrow tone="accent">
          {task.changes ? "Scheduled task" : task.end ? "Inbox watch" : "Reminder"}
        </Eyebrow>
        <Badge tone={status === "saved" ? "forest" : "amber"}>
          {status === "saved" ? "Saved" : status === "approval" ? "Needs approval" : "Suggestion"}
        </Badge>
      </div>
      <h2>{task.title}</h2>
      <dl>
        <div>
          <dt>Instruction</dt>
          <dd>{task.instruction}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{task.when}</dd>
        </div>
        {task.end && (
          <div>
            <dt>Stops</dt>
            <dd>{task.end}</dd>
          </div>
        )}
        <div>
          <dt>Results in</dt>
          <dd>{destination}</dd>
        </div>
      </dl>
      <Eyebrow tone="muted">
        {task.changes
          ? status === "saved"
            ? "Approved actions"
            : "Actions to approve"
          : "What Moss will do"}
      </Eyebrow>
      <ul>
        {task.actions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ul>
      {task.end && <p>Quiet unless her reply arrives.</p>}
      <PermissionNote task={task} />
      <Decision {...props} />
    </section>
  );
}
function VariantC(props: FlowProps & { back: () => void }) {
  const { task, status, destination } = props;
  return (
    <section className="create-review" aria-label="Task summary">
      <Button variant="link" icon={<ArrowLeft size={16} />} onClick={props.back}>
        Back to chat
      </Button>
      <Eyebrow tone="accent">
        {status === "saved" ? "Saved task" : task.changes ? "One-time approval" : "Suggested watch"}
      </Eyebrow>
      <h2>{task.title}</h2>
      <p>{task.instruction}</p>
      <SectionHead number="01" title="Timing & destination" />
      <p>{task.when}</p>
      {task.end && <p>{task.end}</p>}
      <p>
        Results in <strong>{destination}</strong>.
      </p>
      <SectionHead
        number="02"
        title={
          task.changes
            ? status === "saved"
              ? "Approved actions"
              : "Actions to approve"
            : "What Moss will do"
        }
      />
      <ul>
        {task.actions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ul>
      {task.end && <p>Quiet unless her reply arrives.</p>}
      <PermissionNote task={task} />
      <Decision {...props} />
      {status === "saved" && <Button onClick={props.back}>Return to chat</Button>}
    </section>
  );
}

function Prototype() {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [scenario, setScenario] = useState<Scenario>(initialScenario ?? "reminder");
  const [status, setStatus] = useState<Status>("ready");
  const [view, setView] = useState(params.get("view") === "phone" ? "phone" : "docked");
  const [active, setActive] = useState("main");
  const [topics, setTopics] = useState([
    { id: "reading", title: "AI reading" },
    { id: "home", title: "Home projects" }
  ]);
  const [sideDestination, setSideDestination] = useState(false);
  const [destination, setDestination] = useState("Main chat");
  const [task, setTask] = useState(examples[scenario]);
  const [records, setRecords] = useState<Record<string, TranscriptRecord[]>>({
    main: [
      { kind: "reply", text: "Your proposal is ready. What would you like me to keep an eye on?" }
    ],
    reading: [],
    home: []
  });
  const [draft, setDraft] = useState(examples[scenario].request);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [taskChat, setTaskChat] = useState("main");
  const [dark, setDark] = useState(false);
  const [park, setPark] = useState("default");
  const menuButton = useRef<HTMLButtonElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const title =
    active === "main" ? "Main chat" : (topics.find((t) => t.id === active)?.title ?? "Side chat");
  const layout = layouts.find((item) => item.key === variant)!;
  const showTask = active === taskChat && ["proposed", "approval", "saved"].includes(status);
  const flow: FlowProps = {
    task,
    status,
    destination,
    accept: () => decide(true),
    decline: () => decide(false)
  };

  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.dataset.theme = park;
  }, [dark, park]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("variant", variant);
    url.searchParams.set("example", scenario);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    console.info("Creation preview state", {
      variant,
      scenario,
      status,
      saved: status === "saved",
      instruction: task.instruction,
      when: task.when,
      stops: task.end,
      destination,
      actions: task.actions
    });
  }, [variant, scenario, view, status, task, destination]);
  useEffect(() => {
    if (thread.current)
      thread.current.scrollTop = variant === "C" && reviewOpen ? 0 : thread.current.scrollHeight;
  }, [records, status, active, variant, reviewOpen]);
  useEffect(() => {
    if (menuOpen)
      document
        .getElementById("conversation-menu")
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
  }, [menuOpen]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" && menuOpen) {
        closeMenu();
        return;
      }
      if (
        !(event.target instanceof Element) ||
        event.target.closest("input, textarea, select, [contenteditable], #conversation-menu")
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycle(event.key === "ArrowRight" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }
  function cycle(direction: number) {
    const index = layouts.findIndex((item) => item.key === variant);
    chooseVariant(layouts[(index + direction + 3) % 3]!.key);
  }
  function chooseVariant(next: Variant) {
    setVariant(next);
    setReviewOpen(next === "C" && showTask);
    closeMenu();
  }
  function load(next: Scenario, side = sideDestination) {
    setScenario(next);
    setStatus("ready");
    setReviewOpen(false);
    setTask(examples[next]);
    setRecords({
      main: [
        { kind: "reply", text: "Your proposal is ready. What would you like me to keep an eye on?" }
      ],
      reading: [],
      home: []
    });
    setDraft(examples[next].request + (side ? " Put the results in AI reading." : ""));
    setActive(side ? "reading" : "main");
    setMenuOpen(false);
  }
  function append(items: TranscriptRecord[]) {
    setRecords((previous) => ({ ...previous, [active]: [...(previous[active] ?? []), ...items] }));
  }
  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (
      status === "ready" &&
      text ===
        examples[scenario].request + (sideDestination ? " Put the results in AI reading." : "")
    ) {
      const nextStatus =
        scenario === "suggestion" ? "proposed" : task.changes ? "approval" : "saved";
      setDestination(sideDestination ? "AI reading" : "Main chat");
      setTaskChat(active);
      setStatus(nextStatus);
      setReviewOpen(variant === "C");
      append([
        { kind: "user", text },
        {
          kind: "reply",
          text:
            nextStatus === "saved"
              ? "Saved. Here’s what I’ll do."
              : task.changes
                ? "I can do that. Let’s agree the actions once before I save it."
                : "I could watch your inbox for Maya’s reply for the next three hours."
        }
      ]);
    } else {
      if (active.startsWith("new-") && !records[active]?.length)
        setTopics((previous) =>
          previous.map((topic) =>
            topic.id === active
              ? { ...topic, title: text.split(/\s+/).slice(0, 5).join(" ") }
              : topic
          )
        );
      append([
        { kind: "user", text },
        {
          kind: "reply",
          text: "This preview only creates the sample requests. Use the example selector and Send to try a task."
        }
      ]);
    }
  }
  function decide(approved: boolean) {
    if (status !== "approval" && status !== "proposed") return;
    setStatus(approved ? "saved" : "declined");
    setReviewOpen(false);
    append([
      {
        kind: "user",
        text: approved
          ? task.changes
            ? "Yes, approve those actions and save it."
            : "Yes, watch for her reply."
          : task.changes
            ? "Don’t save it."
            : "No thanks."
      },
      {
        kind: "reply",
        text: approved ? "Saved. Here’s what I’ll do." : "No problem. I haven’t saved a task."
      }
    ]);
  }
  function selectChat(id: string) {
    setActive(id);
    setDraft("");
    setReviewOpen(false);
    closeMenu();
  }
  function newChat() {
    const id = `new-${topics.length}`;
    setTopics((previous) => [...previous, { id, title: "New side chat" }]);
    setRecords((previous) => ({ ...previous, [id]: [] }));
    selectChat(id);
    setTimeout(() => composer.current?.focus(), 0);
  }

  return (
    <div className="proto-preview create-preview">
      <div className="proto-toolbar">
        <div className="proto-preview-label">
          <Eyebrow tone="accent">Task creation design</Eyebrow>
          <span>Fictional examples · nothing is really saved</span>
        </div>
        <div className="proto-toolbar-actions">
          <Button
            variant={view === "docked" ? "accentSoft" : "quiet"}
            aria-pressed={view === "docked"}
            onClick={() => setView("docked")}
          >
            Alongside Today
          </Button>
          <Button
            variant={view === "phone" ? "accentSoft" : "quiet"}
            aria-pressed={view === "phone"}
            onClick={() => setView("phone")}
          >
            Phone
          </Button>
          <IconButton
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <Select
            aria-label="Preview theme"
            value={park}
            onChange={(event) => setPark(event.target.value)}
          >
            <option value="default">Forest</option>
            <option value="teal">Teal</option>
          </Select>
        </div>
      </div>
      <div className="create-demo-controls" aria-label="Fictional examples">
        <Field>
          <FormLabel htmlFor="example">Try a request</FormLabel>
          <Select
            id="example"
            value={scenario}
            onChange={(event) => load(event.target.value as Scenario)}
          >
            <option value="reminder">Reminder · saves directly</option>
            <option value="watch">Inbox watch · saves directly</option>
            <option value="suggestion">Moss suggestion · agree or decline</option>
            <option value="cleanup">Inbox cleanup · approve once</option>
          </Select>
        </Field>
        <Button variant="secondary" onClick={() => load(scenario)}>
          Start over
        </Button>
        <Button
          variant="quiet"
          aria-pressed={sideDestination}
          onClick={() => {
            setSideDestination(!sideDestination);
            load(scenario, !sideDestination);
          }}
        >
          {sideDestination ? "Example: results in AI reading" : "Example: results in main chat"}
        </Button>
        <span role="status">
          {status === "saved"
            ? "1 sample task saved"
            : status === "approval"
              ? "0 saved · waiting for action approval"
              : status === "proposed"
                ? "0 saved · waiting for agreement"
                : "0 sample tasks saved"}
        </span>
      </div>
      <div
        className="proto-stage"
        data-view={view}
        data-variant="A"
        data-creation-variant={variant}
      >
        <aside className="sidebar proto-app-nav">
          <div className="brand-lockup">
            <BrandMark size={28} />
            <strong className="brand-wordmark">Moss</strong>
          </div>
          <div className="module-nav" aria-label="App context">
            {[
              { label: "Today", icon: House },
              { label: "Calendar", icon: CalendarDays },
              { label: "Tasks", icon: CheckCheck },
              { label: "Notes", icon: FileText },
              { label: "Email", icon: Mail }
            ].map(({ label, icon: Icon }) => (
              <div key={label} className={`module-link ${label === "Today" ? "active" : ""}`}>
                <Icon />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="proto-account">
            <Avatar name="Alex" size="sm" />
            <div>
              <strong>Alex</strong>
              <span>Your workspace</span>
            </div>
            <Settings size={17} />
          </div>
        </aside>
        <div className="proto-workspace">
          <div className="proto-app-topbar">
            <span>Today</span>
            <span>
              Wednesday, 7 October · 2:00 PM
              <Avatar name="Alex" size="sm" />
            </span>
          </div>
          <div className="proto-content">
            <section className="proto-today" aria-label="Sample Today page">
              <Masthead
                tone="field"
                eyebrow="Wednesday · Your day, at a glance"
                title="A little room to focus."
                lede="One proposal to finish, then a little space for everything else."
              />
              <div className="proto-today-body">
                <SectionHead number="01" title="Your day" meta="Three things ahead" />
                {[
                  ["14:00", "Finish the proposal", "Your draft is ready for a final read"],
                  ["15:30", "A little breathing room", "Take a walk before your next call"],
                  ["16:00", "Wrap up", "Make tomorrow a little easier"]
                ].map(([time, item, note]) => (
                  <div className="proto-agenda" key={time}>
                    <span>{time}</span>
                    <div>
                      <strong>{item}</strong>
                      <p>{note}</p>
                    </div>
                  </div>
                ))}
                <SectionHead number="02" title="Worth a look" />
                <p className="proto-muted">Your saved reading can wait until after the proposal.</p>
              </div>
            </section>
            <section className="proto-chat" aria-label="Moss conversation">
              <header className="proto-chat-head">
                <div className="proto-chat-brand">
                  <IconButton
                    ref={menuButton}
                    aria-label="Conversations"
                    aria-expanded={menuOpen}
                    aria-controls="conversation-menu"
                    onClick={() => setMenuOpen(!menuOpen)}
                  >
                    <Menu size={21} />
                  </IconButton>
                  <div>
                    <strong>Moss</strong>
                    <span>Your chief of staff</span>
                  </div>
                </div>
                <BrandMark size={24} />
              </header>
              <div className="proto-chat-layout">
                {menuOpen && (
                  <>
                    <button
                      className="proto-conversation-scrim"
                      aria-label="Close conversation menu"
                      onClick={closeMenu}
                    />
                    <aside
                      id="conversation-menu"
                      className="proto-conversation-overlay"
                      aria-label="Conversations"
                    >
                      <div className="proto-list-top">
                        <Eyebrow tone="muted">Your conversations</Eyebrow>
                        <IconButton aria-label="Close conversation list" onClick={closeMenu}>
                          <X size={18} />
                        </IconButton>
                      </div>
                      <NavIndex ariaLabel="Main conversation">
                        <NavIndexItem
                          label="Main chat"
                          selected={active === "main"}
                          onSelect={() => selectChat("main")}
                        />
                      </NavIndex>
                      <div className="proto-topic-heading">
                        <Eyebrow tone="muted">Side chats</Eyebrow>
                        <Button variant="quiet" icon={<Plus size={17} />} onClick={newChat}>
                          New side chat
                        </Button>
                      </div>
                      <NavIndex ariaLabel="Side conversations">
                        {topics.map((topic) => (
                          <NavIndexItem
                            key={topic.id}
                            label={topic.title}
                            selected={active === topic.id}
                            onSelect={() => selectChat(topic.id)}
                          />
                        ))}
                      </NavIndex>
                      <p className="proto-nav-note">
                        Separate topics.
                        <br />
                        The same Moss.
                      </p>
                    </aside>
                  </>
                )}
                <div className="proto-conversation" inert={menuOpen ? true : undefined}>
                  <div className="proto-conversation-title">
                    <div>
                      <h1>{title}</h1>
                      <p>
                        {active === "main"
                          ? "Your ongoing conversation with Moss"
                          : "A side chat · same Moss, focused on this topic"}
                      </p>
                    </div>
                  </div>
                  <div ref={thread} className="proto-thread" aria-live="polite">
                    {variant === "C" && reviewOpen && showTask ? (
                      <VariantC {...flow} back={() => setReviewOpen(false)} />
                    ) : (
                      <>
                        {records[active]?.length ? (
                          <Thread records={records[active] ?? []} working={false} />
                        ) : (
                          <EmptyState
                            title="What’s on your mind?"
                            description="Start typing. Moss will name this chat as you go."
                          />
                        )}
                        {showTask &&
                          (variant === "A" ? (
                            <VariantA {...flow} />
                          ) : variant === "B" ? (
                            <VariantB {...flow} />
                          ) : (
                            <div className="create-receipt">
                              <Badge tone={status === "saved" ? "forest" : "amber"}>
                                {status === "saved" ? "Saved" : "Not saved yet"}
                              </Badge>
                              <h2>{task.title}</h2>
                              <p>{task.instruction}</p>
                              <p>
                                {task.when}
                                {task.end && <> · {task.end}</>}
                              </p>
                              <p>Results in {destination}.</p>
                              {status === "saved" && (
                                <p>
                                  {task.changes ? "Approved actions" : "What Moss will do"}:{" "}
                                  {task.actions.join("; ")}.
                                </p>
                              )}
                              <Button variant="secondary" onClick={() => setReviewOpen(true)}>
                                {status === "saved" ? "View saved task" : "Review task"}
                              </Button>
                            </div>
                          ))}
                      </>
                    )}
                  </div>
                  <form
                    className="proto-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      send();
                    }}
                  >
                    <textarea
                      ref={composer}
                      className="jds-input"
                      aria-label={`Message ${title}`}
                      placeholder="Message Moss…"
                      rows={2}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          send();
                        }
                      }}
                    />
                    <div className="proto-composer-foot">
                      <span>{title}</span>
                      <IconButton aria-label="Send message" disabled={!draft.trim()} onClick={send}>
                        <ArrowDown className="proto-send-arrow" size={18} />
                      </IconButton>
                    </div>
                  </form>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
      {import.meta.env.DEV && (
        <div className="proto-switcher create-switcher" aria-label="Compare creation designs">
          <IconButton aria-label="Previous design" onClick={() => cycle(-1)}>
            <ArrowLeft size={18} />
          </IconButton>
          <div>
            <div className="proto-option-buttons">
              {layouts.map((option) => (
                <Button
                  key={option.key}
                  variant="quiet"
                  aria-label={`Option ${option.key}: ${option.name}`}
                  aria-pressed={variant === option.key}
                  onClick={() => chooseVariant(option.key)}
                >
                  {option.key}
                </Button>
              ))}
            </div>
            <strong>
              {variant} · {layout.name}
            </strong>
            <span>{layout.description}</span>
          </div>
          <IconButton aria-label="Next design" onClick={() => cycle(1)}>
            <ArrowRight size={18} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Prototype />);
