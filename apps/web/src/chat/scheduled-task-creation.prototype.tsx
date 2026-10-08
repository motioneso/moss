/** THROWAWAY #3100: ordinary chat replies for task creation, as selected by Ben.
 * Fictional samples and memory-only state. Never imported by the production app.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
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
  SectionHead,
  Select,
  Thread
} from "@moss/ui";
import type { TranscriptRecord } from "@moss/shared";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "./main-side-chats.prototype.css";
import "./scheduled-task-creation.prototype.css";

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
const params = new URLSearchParams(location.search);
const initialScenario = Object.keys(examples).find((key) => key === params.get("example")) as
  | Scenario
  | undefined;

function Prototype() {
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
  const [taskChat, setTaskChat] = useState("main");
  const [dark, setDark] = useState(false);
  const [park, setPark] = useState("default");
  const menuButton = useRef<HTMLButtonElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const title =
    active === "main" ? "Main chat" : (topics.find((t) => t.id === active)?.title ?? "Side chat");
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.dataset.theme = park;
  }, [dark, park]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete("variant");
    url.searchParams.set("example", scenario);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    console.info("Creation preview state", {
      scenario,
      status,
      saved: status === "saved",
      instruction: task.instruction,
      when: task.when,
      stops: task.end,
      destination,
      actions: task.actions
    });
  }, [scenario, view, status, task, destination]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [records, status, active]);
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
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }
  function load(next: Scenario, side = sideDestination) {
    setScenario(next);
    setStatus("ready");
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
  function savedReply(target: string) {
    const text = task.changes
      ? "Okay, I’ll tidy the Field Notes emails every Friday at 4 PM PDT, starting 9 October, using those actions. I’ll tell you what changed."
      : scenario === "reminder"
        ? "I’ll remind you tomorrow, Thursday 8 October, at 9 AM PDT to send Maya the proposal."
        : "I’ll check for Maya’s reply every 15 minutes for the next three hours, until 5 PM PDT today. I’ll let you know when it arrives, then stop watching.";
    return target === "Main chat" ? text : `${text} I’ll put the results in ${target}.`;
  }
  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    let reply: string;
    if ((status === "approval" || status === "proposed") && active === taskChat) {
      if (
        /^(yes|sure|go ahead|yes please|yes, please|yes, save it|yes, approve those actions and save it|please do)[.!]?$/i.test(
          text
        )
      ) {
        setStatus("saved");
        reply = savedReply(destination);
      } else if (
        /^(no|no thanks|no, thanks|don't save it|don’t save it|cancel)[.!]?$/i.test(text)
      ) {
        setStatus("declined");
        reply = "No problem. I haven’t saved a task.";
      } else {
        reply = "I haven’t saved it yet. Let me know whether you want me to go ahead.";
      }
    } else if (
      status === "ready" &&
      text ===
        examples[scenario].request + (sideDestination ? " Put the results in AI reading." : "")
    ) {
      const target = sideDestination ? "AI reading" : "Main chat";
      const nextStatus =
        scenario === "suggestion" ? "proposed" : task.changes ? "approval" : "saved";
      setDestination(target);
      setTaskChat(active);
      setStatus(nextStatus);
      reply =
        nextStatus === "saved"
          ? savedReply(target)
          : task.changes
            ? "Before I save this: every Friday at 4 PM PDT, starting 9 October, I’ll read emails from Field Notes, archive their newsletters over 7 days old, permanently delete their promotional emails over 30 days old, and tell you what changed. Permanent deletion can’t be undone. Once you agree, I’ll do this without asking again. Shall I go ahead?"
            : "Want me to check your inbox for Maya’s reply every 15 minutes for the next three hours, until 5 PM PDT today? I’ll let you know when it arrives, then stop watching.";
    } else {
      if (active.startsWith("new-") && !records[active]?.length)
        setTopics((previous) =>
          previous.map((topic) =>
            topic.id === active
              ? { ...topic, title: text.split(/\s+/).slice(0, 5).join(" ") }
              : topic
          )
        );
      reply =
        "This preview only creates the sample requests. Use the example selector and Send to try a task.";
    }
    append([
      { kind: "user", text },
      { kind: "reply", text: reply }
    ]);
  }
  function selectChat(id: string) {
    setActive(id);
    setDraft("");
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
      <div className="proto-stage" data-view={view}>
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
                    {records[active]?.length ? (
                      <Thread records={records[active] ?? []} working={false} />
                    ) : (
                      <EmptyState
                        title="What’s on your mind?"
                        description="Start typing. Moss will name this chat as you go."
                      />
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
    </div>
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Prototype />);
