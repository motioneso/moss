/** THROWAWAY #3102: proactive updates as ordinary replies in the accepted chat.
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
import "./proactive-updates.prototype.css";

type Sample = {
  title: string;
  context: string;
  explanation: string;
  steps: { note: string; reply?: string; complete?: boolean }[];
};
// All names, sources, clocks and findings are fictional. No connector is contacted.
const email =
  "[Open Maya’s email in Gmail](https://mail.google.com/mail/u/0/#search/from%3Amaya%40example.com+subject%3Aproposal)";
const samples: Record<string, Sample> & { useful: Sample } = {
  useful: {
    title: "Useful sourced update",
    context:
      "I’ll check for important changes to the proposal and let you know when there’s something useful.",
    explanation:
      "A useful finding arrives as an ordinary message. Reply below. The source is fictional; Gmail is one sample connected provider.",
    steps: [
      {
        note: "One useful update delivered to main chat.",
        reply: `Maya replied about the proposal at 2:12 PM PDT. She’s happy with the scope, but wants the first draft by Friday rather than Monday. ${email}.`
      },
      { note: "Same finding checked again. No new message." }
    ]
  },
  complete: {
    title: "Watch goal fulfilled",
    context:
      "I’ll watch for Maya’s reply about the proposal, let you know when it arrives, then stop.",
    explanation:
      "This watch ends on receipt of a matching email, not on whether you have read it. The matching sender and proposal subject are sample evidence.",
    steps: [
      {
        note: "Matching email received. Watch completed; one stop explanation.",
        complete: true,
        reply: `Maya’s reply about the proposal arrived at 2:12 PM PDT. She’s approved the scope. ${email}. I’ve stopped watching because her reply has arrived.`
      }
    ]
  },
  unread: {
    title: "Opening an email is not reading it",
    context: "I’ll keep an eye on Maya’s proposal email until you’ve read it.",
    explanation:
      "No reliable provider read-state evidence is available in this sample. Clicking the source leaves the watch active. Reply “I’ve read it” to supply explicit confirmation.",
    steps: [
      {
        note: "Email found. Watch stays active; read status is unknown.",
        reply: `Maya’s proposal email is here. ${email}. I can’t tell whether you’ve read it yet, so I’m still watching.`
      },
      { note: "No new evidence that the email was read. No new message." }
    ]
  },
  late: {
    title: "Late reminder after downtime",
    context: "I’ll remind you at 9 AM PDT today to send Maya the proposal.",
    explanation:
      "Sample clock: Thursday 8 October, 10:20 AM PDT. A reminder without an expired deadline is delivered once and clearly marked late.",
    steps: [
      {
        note: "Reminder delivered once, 1 hour 20 minutes late.",
        complete: true,
        reply:
          "This reminder is 1 hour 20 minutes late: you asked me to remind you at 9 AM PDT today to send Maya the proposal. Moss was offline then and is back at 10:20 AM."
      }
    ]
  },
  expired: {
    title: "Expired task does nothing",
    context:
      "I’ll send the draft before 10 AM PDT today. If I’m not back by then, I won’t send it.",
    explanation:
      "Sample clock: Thursday 8 October, 10:20 AM PDT. The deadline has passed. No send, catch-up execution, or chat update is produced.",
    steps: [{ note: "Deadline passed. Task expired; 0 sends and 0 new messages.", complete: true }]
  },
  recovery: {
    title: "One fresh check after downtime",
    context: "I’ll check AI news hourly and tell you when there’s something worth your attention.",
    explanation:
      "Moss was offline from 9 AM to noon. Returning at 12:10 PM causes one fresh check, not three replayed checks. The next regular check is 1 PM PDT.",
    steps: [
      {
        note: "One fresh check at 12:10 PM; no replay. Next check: 1 PM PDT.",
        reply:
          "There’s a new AI model release worth a look: the release notes describe an offline mode that fits your research setup. [Read the sample release notes](https://example.com/ai-release-notes)."
      },
      { note: "Regular check at 1 PM. Finding unchanged; no new message." }
    ]
  },
  quiet: {
    title: "Nothing useful to report",
    context: "I’ll check hourly and only tell you about useful changes.",
    explanation:
      "Both checks succeed. Neither deserves a message. Try them from a side chat too: there is no main-chat banner or interruption.",
    steps: [
      { note: "Check succeeded; nothing useful. No message." },
      { note: "Check succeeded; finding unchanged. No message." }
    ]
  },
  failures: {
    title: "Quiet retry, then repeated failure",
    context: "I’ll check your inbox every 15 minutes for Maya’s reply.",
    explanation:
      "Read-only checks can retry quietly. Repeated failures surface a concrete way to restore checking. This sample does not reconnect a real account.",
    steps: [
      { note: "Temporary read failure. Quiet retry; no message." },
      { note: "Second read failure. Quiet retry; no message." },
      {
        note: "Repeated failures reported with a next step.",
        reply:
          "I haven’t been able to check for Maya’s reply on the last three attempts because your email connection needs attention. Reconnect it in Settings → Connectors, then tell me to try again. I haven’t been able to tell whether she’s replied."
      }
    ]
  },
  write: {
    title: "A started change is not retried",
    context: "I’ll archive the agreed Field Notes newsletters and report what changed.",
    explanation:
      "Sample archive run started, then the connection failed. It is not automatically rerun. Permanent deletions follow the same no-retry rule.",
    steps: [
      {
        note: "Archive started; outcome uncertain. No automatic rerun.",
        reply:
          "The connection dropped after I started archiving the Field Notes newsletters. I can’t confirm which changes finished, so I haven’t run it again. Reconnect your email in Settings → Connectors and review the affected emails before asking me to continue."
      },
      { note: "Task remains stopped for review. No retry or new message." }
    ]
  },
  concurrent: {
    title: "Update alongside a live reply",
    context: "I’ll watch for Maya’s proposal reply while we work on the draft.",
    explanation:
      "Sample UI behavior only, not backend concurrency proof. Send a message below, deliver the background update, then finish the live reply. Try the same flow in a side chat.",
    steps: [
      {
        note: "Background update delivered to main chat; live reply continues.",
        reply: `Maya replied: she’s approved the scope. ${email}. I’ve stopped watching because her reply has arrived.`,
        complete: true
      }
    ]
  }
};
const params = new URLSearchParams(location.search);
const initialSample = params.get("example") ?? "useful";

function Prototype() {
  const [scenario, setScenario] = useState(samples[initialSample] ? initialSample : "useful");
  const sample = samples[scenario] ?? samples.useful;
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const [note, setNote] = useState("Ready. No sample checks run.");
  const [liveChat, setLiveChat] = useState<string | null>(null);
  const liveIndex = useRef(0);
  const [view, setView] = useState(params.get("view") === "phone" ? "phone" : "docked");
  const [active, setActive] = useState("main");
  const [topics, setTopics] = useState([
    { id: "reading", title: "AI reading" },
    { id: "home", title: "Home projects" }
  ]);
  const [records, setRecords] = useState<Record<string, TranscriptRecord[]>>({
    main: [{ kind: "reply", text: (samples[initialSample] ?? samples.useful).context }],
    reading: [{ kind: "reply", text: "Let’s work on your reading list." }],
    home: [{ kind: "reply", text: "What would you like to work on at home?" }]
  });
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
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
    url.searchParams.set("example", scenario);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    console.info("Proactive preview state", {
      scenario,
      step,
      complete,
      note,
      active,
      liveChat,
      records
    });
  }, [scenario, view, step, complete, note, active, liveChat, records]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [records, active]);
  useEffect(() => {
    if (menuOpen)
      document
        .getElementById("conversation-menu")
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
  }, [menuOpen]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === "Tab" && menuOpen) {
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>("#conversation-menu button")
        );
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
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
  function load(next: string) {
    const nextSample = samples[next];
    if (!nextSample) return;
    setScenario(next);
    setStep(0);
    setComplete(false);
    setNote("Ready. No sample checks run.");
    setLiveChat(null);
    setRecords({
      main: [{ kind: "reply", text: nextSample.context }],
      reading: [{ kind: "reply", text: "Let’s work on your reading list." }],
      home: [{ kind: "reply", text: "What would you like to work on at home?" }]
    });
    setDraft("");
    setActive("main");
    setMenuOpen(false);
    setTopics([
      { id: "reading", title: "AI reading" },
      { id: "home", title: "Home projects" }
    ]);
  }
  function append(chat: string, items: TranscriptRecord[]) {
    setRecords((previous) => ({ ...previous, [chat]: [...(previous[chat] ?? []), ...items] }));
  }
  function run() {
    if (complete) return;
    const next = sample.steps[step];
    if (!next) return;
    if (next.reply) append("main", [{ kind: "reply", text: next.reply }]);
    setNote(next.note);
    if (next.complete) setComplete(true);
    setStep(step + 1);
  }
  function finish() {
    if (!liveChat) return;
    setRecords((previous) => ({
      ...previous,
      [liveChat]: (previous[liveChat] ?? []).map((record, index) =>
        index === liveIndex.current
          ? {
              ...record,
              text: "For the proposal, I’d lead with the agreed scope, then the delivery date. Here’s a starting point: ‘Thanks, Maya. The scope looks good. I’ll send the first draft by Friday.’"
            }
          : record
      )
    }));
    setLiveChat(null);
    setNote("Live reply finished; the background message remains in its conversation.");
  }
  function send() {
    const text = draft.trim();
    if (!text || liveChat !== null) return;
    setDraft("");
    if (active.startsWith("new-") && !records[active]?.length)
      setTopics((previous) =>
        previous.map((topic) =>
          topic.id === active ? { ...topic, title: text.split(/\s+/).slice(0, 4).join(" ") } : topic
        )
      );
    let reply =
      "That reply stays in this conversation. This fictional preview doesn’t run real tasks.";
    if (
      scenario === "unread" &&
      active === "main" &&
      step > 0 &&
      !complete &&
      /^(i['’]ve read it|i have read it)[.!]?$/i.test(text)
    ) {
      reply = "Thanks for confirming you’ve read it. I’ve stopped watching now.";
      setComplete(true);
      setNote("User explicitly confirmed reading. Watch completed; one stop explanation.");
    } else if (scenario === "concurrent") {
      liveIndex.current = (records[active]?.length ?? 0) + 1;
      setLiveChat(active);
      reply = "For the proposal, I’d lead with the agreed scope…";
      setNote("Sample live reply in progress. Deliver the update, then finish this reply.");
    }
    append(active, [
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
    <div className="proto-preview create-preview updates-preview">
      <div className="proto-toolbar">
        <div className="proto-preview-label">
          <Eyebrow tone="accent">Proactive update design</Eyebrow>
          <span>Fictional examples · browser-only state</span>
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
          <FormLabel htmlFor="example">Try a situation</FormLabel>
          <Select id="example" value={scenario} onChange={(event) => load(event.target.value)}>
            {Object.entries(samples).map(([key, sample]) => (
              <option key={key} value={key}>
                {sample.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="primary"
          disabled={
            complete || step >= sample.steps.length || (scenario === "concurrent" && !liveChat)
          }
          onClick={run}
        >
          {step === 0 ? "Run sample" : "Next check"}
        </Button>
        {scenario === "concurrent" && (
          <Button variant="secondary" disabled={!liveChat} onClick={finish}>
            Finish live reply
          </Button>
        )}
        <Button variant="quiet" onClick={() => load(scenario)}>
          Start over
        </Button>
      </div>
      <div className="updates-guide" aria-label="Sample explanation">
        <p>{sample.explanation}</p>
        <p role="status">
          {note}{" "}
          {(scenario === "complete" || scenario === "unread") &&
            `Watch: ${complete ? "completed" : "active"}.`}
        </p>
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
              Thursday, 8 October · Sample clock
              <Avatar name="Alex" size="sm" />
            </span>
          </div>
          <div className="proto-content">
            <section className="proto-today" aria-label="Sample Today page">
              <Masthead
                tone="field"
                eyebrow="Thursday · Your day, at a glance"
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
                      <Thread records={records[active] ?? []} working={liveChat === active} />
                    ) : (
                      <EmptyState
                        title="What’s on your mind?"
                        description="Start typing. Moss will name this chat as you go."
                      />
                    )}
                    {liveChat === active && (
                      <p className="proto-muted" role="status">
                        Moss is replying…
                      </p>
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
                      <IconButton
                        aria-label="Send message"
                        disabled={!draft.trim() || liveChat !== null}
                        onClick={send}
                      >
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
