/** THROWAWAY #3103: one final Settings flow; fictional data and browser-memory state.
 * Question: can people control unsolicited email and interruptions without stopping requested work?
 * One presentation: earlier chat and Settings layout decisions are already settled.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, House, Mail, Moon, Settings, Sun } from "lucide-react";
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
  NavIndex,
  NavIndexItem,
  Note,
  SectionHead,
  Select,
  Switch
} from "@moss/ui";
import type { TranscriptRecord } from "@moss/shared";
import { InterruptionChat } from "./interruption-chat.prototype";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "../styles/settings.css";
import "../chat/main-side-chats.prototype.css";
import "./interruption-preferences.prototype.css";

const situations = {
  fresh: "Email alerts with no saved choice",
  saved: "Email alerts previously turned off",
  disconnected: "Email disconnected",
  revoked: "Email access turned off",
  conflict: "Different saved quiet hours",
  empty: "No requested tasks",
  loading: "Settings loading",
  error: "Settings could not load",
  saveError: "Quiet-hours save fails",
  muted: "App notifications muted"
};
type Situation = keyof typeof situations;
type Quiet = { enabled: boolean; start: string; end: string; zone: string };
const initialQuiet: Quiet = {
  enabled: true,
  start: "22:00",
  end: "07:00",
  zone: "America/Los_Angeles"
};
const params = new URLSearchParams(location.search);
const requested = params.get("example") ?? "fresh";
const initial = requested in situations ? (requested as Situation) : "fresh";
const clockLabel = (time: string) => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
};

function Prototype() {
  const [example, setExample] = useState<Situation>(initial);
  const [email, setEmail] = useState(initial !== "saved");
  const [quiet, setQuiet] = useState(initialQuiet);
  const [editing, setEditing] = useState(initialQuiet);
  const [reconcile, setReconcile] = useState(initial === "conflict");
  const [exception, setException] = useState(false);
  const [push, setPush] = useState(initial !== "muted");
  const [notify, setNotify] = useState(initial !== "muted");
  const [digest, setDigest] = useState(false);
  const [page, setPage] = useState("alerts");
  const [dark, setDark] = useState(false);
  const [park, setPark] = useState("default");
  const [phone, setPhone] = useState(params.get("view") === "phone");
  const [chat, setChat] = useState(false);
  const chatTrigger = useRef<HTMLElement | null>(null);
  const modal = phone || window.innerWidth <= 760;
  function openChat() {
    chatTrigger.current = document.activeElement as HTMLElement;
    setChat(true);
  }
  function closeChat() {
    setChat(false);
    setTimeout(() => chatTrigger.current?.focus(), 0);
  }
  const [records, setRecords] = useState<TranscriptRecord[]>([
    {
      kind: "reply",
      text: "Your requested watches and reminders keep running when you turn off automatic email alerts. During quiet hours, you can still read their updates here."
    }
  ]);
  const [sample, setSample] = useState("email");
  const [clock, setClock] = useState("23:00");
  const [urgent, setUrgent] = useState(false);
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState("Ready. No sample work run.");
  const [status, setStatus] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const dirty =
    editing.enabled !== quiet.enabled ||
    editing.start !== quiet.start ||
    editing.end !== quiet.end ||
    editing.zone !== quiet.zone;
  function editQuiet(patch: Partial<Quiet>) {
    setEditing((previous) => ({ ...previous, ...patch }));
    setStatus("");
  }
  const unavailable = example === "disconnected" || example === "revoked";
  const busy = example === "loading" || example === "error";
  const isQuiet =
    quiet.enabled &&
    (quiet.start < quiet.end
      ? clock >= quiet.start && clock < quiet.end
      : clock >= quiet.start || clock < quiet.end);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.dataset.theme = park;
  }, [dark, park]);
  useEffect(() => {
    console.info("Interruption preview", {
      example,
      email,
      quiet,
      editing,
      reconcile,
      exception,
      push,
      notify,
      digest,
      clock,
      pending,
      note
    });
  }, [
    example,
    email,
    quiet,
    editing,
    reconcile,
    exception,
    push,
    notify,
    digest,
    clock,
    pending,
    note
  ]);
  function load(next: Situation) {
    setExample(next);
    setEmail(next !== "saved");
    setQuiet(initialQuiet);
    setEditing(initialQuiet);
    setReconcile(next === "conflict");
    setException(false);
    setPush(next !== "muted");
    setNotify(next !== "muted");
    setDigest(false);
    setPending(0);
    setClock("23:00");
    setUrgent(false);
    setSample("email");
    setStatus("");
    setEmailStatus("");
    setNote("Ready. No sample work run.");
    setRecords([
      {
        kind: "reply",
        text: "Your requested work stays separate from automatic email alerts. Quiet hours delay interruptions, not the work itself."
      }
    ]);
    const url = new URL(location.href);
    url.searchParams.set("example", next);
    history.replaceState(null, "", url);
  }
  function append(text: string) {
    setRecords((prev) => [...prev, { kind: "reply", text }]);
  }
  function send(text: string) {
    let reply =
      "To change this watch’s exception, say “Let Maya’s reply interrupt me during quiet hours” or “Stop Maya’s reply interrupting me during quiet hours”.";
    if (example === "empty")
      reply = "You don’t have a requested watch yet. Ask me to create one first.";
    else if (/^let maya['’]s reply interrupt me during quiet hours[.!]?$/i.test(text)) {
      setException(true);
      reply =
        "Maya’s proposal reply can now interrupt you during quiet hours. Your other work still waits, and your notification choices still apply.";
    } else if (/^stop maya['’]s reply interrupting me during quiet hours[.!]?$/i.test(text)) {
      setException(false);
      reply =
        "Maya’s proposal reply will now wait until quiet hours end before interrupting you. I’ll keep watching, and its update will still be readable here.";
    }
    setRecords((prev) => [...prev, { kind: "user", text }, { kind: "reply", text: reply }]);
    return reply;
  }
  function run() {
    if (busy || reconcile) {
      setNote("Choose or load your settings before running this sample.");
      return;
    }
    if ((sample === "email" || sample === "watch") && unavailable) {
      setNote("Email access unavailable. No email checked and no message produced.");
      return;
    }
    if (sample !== "email" && example === "empty") {
      setNote("No requested tasks in this example. Nothing runs.");
      return;
    }
    if (sample === "email" && !email) {
      setNote("Automatic email alerts off. No unsolicited message. Requested work stays active.");
      return;
    }
    append(
      sample === "news"
        ? "There’s a new AI release worth a look. Your requested news check is still running. [Read the fictional release notes](https://example.com/ai-release)."
        : `Maya replied about the proposal. She’d like the draft by Friday. [Open Maya’s email in Gmail](https://mail.google.com/mail/u/0/#search/from%3Amaya%40example.com+subject%3Aproposal).${sample === "watch" ? " Your requested watch found this reply." : ""}`
    );
    if (!notify || !push)
      setNote(
        "Work completed. Message readable in Main chat. No device interruption: notifications are off."
      );
    else if (isQuiet && !(sample === "watch" && exception)) {
      setPending((n) => n + 1);
      setNote(
        "Work completed. Message readable in Main chat now. Device interruption waits until quiet hours end, regardless of Moss’s urgency assessment."
      );
    } else
      setNote(
        `Work completed. Message readable in Main chat. Sample device interruption delivered${isQuiet ? " for the exception you requested" : " outside quiet hours"}.`
      );
  }
  function finishQuiet() {
    setClock(quiet.end);
    setPending(0);
    setNote(
      pending
        ? notify && push
          ? `${pending} waiting sample interruption${pending === 1 ? "" : "s"} released. Chat messages were already readable; no duplicate chat messages.`
          : "Waiting device interruptions suppressed because notifications are off. Chat messages remain readable."
        : "Quiet hours ended. No interruptions were waiting."
    );
  }
  return (
    <div className="proto-preview interruptions-preview">
      <div className="proto-toolbar" inert={(chat && modal) || undefined}>
        <div className="proto-preview-label">
          <Eyebrow tone="accent">Alerts & quiet hours design</Eyebrow>
          <span>Fictional examples · browser-only state</span>
        </div>
        <div className="proto-toolbar-actions">
          <Button variant={phone ? "quiet" : "accentSoft"} onClick={() => setPhone(false)}>
            Desktop
          </Button>
          <Button variant={phone ? "accentSoft" : "quiet"} onClick={() => setPhone(true)}>
            Phone
          </Button>
          <IconButton
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <Select aria-label="Preview theme" value={park} onChange={(e) => setPark(e.target.value)}>
            <option value="default">Forest</option>
            <option value="teal">Teal</option>
          </Select>
        </div>
      </div>
      <div
        className="interruptions-review"
        aria-label="Fictional examples"
        inert={(chat && modal) || undefined}
      >
        <Field>
          <FormLabel htmlFor="example">Try a situation</FormLabel>
          <Select id="example" value={example} onChange={(e) => load(e.target.value as Situation)}>
            {Object.entries(situations).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor="sample">Sample work</FormLabel>
          <Select id="sample" value={sample} onChange={(e) => setSample(e.target.value)}>
            <option value="email">Automatic email alert</option>
            <option value="watch">Requested inbox watch</option>
            <option value="news">Requested AI news check</option>
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor="clock">Sample local time</FormLabel>
          <Select id="clock" value={clock} onChange={(e) => setClock(e.target.value)}>
            <option value="23:00">11:00 PM</option>
            <option value="09:00">9:00 AM</option>
            <option value={quiet.end}>End of quiet hours</option>
          </Select>
        </Field>
        <Switch
          ariaLabel="Moss judges the finding urgent"
          label="Moss judges it urgent"
          checked={urgent}
          onChange={setUrgent}
        />
        <Button onClick={run}>Run sample</Button>
        <Button variant="secondary" onClick={finishQuiet}>
          End quiet hours
        </Button>
        <Button variant="quiet" onClick={() => load(example)}>
          Start over
        </Button>
      </div>
      <p className="interruptions-review-status" role="status">
        {note}
      </p>
      <div className="proto-stage" data-view={phone ? "phone" : "docked"} data-chat={chat}>
        <aside className="sidebar proto-app-nav" inert={(chat && modal) || undefined}>
          <div className="brand-lockup">
            <BrandMark size={28} />
            <strong className="brand-wordmark">Moss</strong>
          </div>
          <div className="module-nav">
            <div className="module-link">
              <House />
              <span>Today</span>
            </div>
            <div className="module-link active">
              <Settings />
              <span>Settings</span>
            </div>
          </div>
          <div className="proto-account">
            <Avatar name="Alex" size="sm" />
            <div>
              <strong>Alex</strong>
              <span>Your workspace</span>
            </div>
          </div>
        </aside>
        <div className="proto-workspace">
          <div className="proto-app-topbar" inert={(chat && modal) || undefined}>
            <span>Settings</span>
            <Button variant="quiet" icon={<Bell size={16} />} onClick={openChat}>
              Chat with Moss
            </Button>
          </div>
          <div className="proto-content">
            <section
              className="interruptions-settings"
              aria-label="Settings preferences"
              inert={(chat && modal) || undefined}
            >
              <div className="set2__mast">
                <h1 className="set2__masttitle">Settings</h1>
                <Eyebrow tone="accent">Personal</Eyebrow>
              </div>
              <div className="interruptions-settings-grid">
                <NavIndex ariaLabel="Personal settings">
                  <NavIndexItem
                    label="Alerts & quiet hours"
                    selected={page === "alerts"}
                    onSelect={() => setPage("alerts")}
                  />
                  <NavIndexItem
                    label="Notifications"
                    selected={page === "notifications"}
                    onSelect={() => setPage("notifications")}
                  />
                </NavIndex>
                <div className="interruptions-pane">
                  {page === "notifications" ? (
                    <>
                      <SectionHead title="Notifications" />
                      <p>Choose how you receive notifications.</p>
                      <div className="set-row">
                        <div className="set-row__main">
                          <strong>App notifications</strong>
                          <p>Your saved module notification choices apply to outward alerts.</p>
                        </div>
                        <Badge tone={notify ? "forest" : "neutral"}>
                          {notify ? "Enabled" : "Muted"}
                        </Badge>
                      </div>
                      <div className="set-row">
                        <div className="set-row__main">
                          <strong>This device</strong>
                          <p>Send notifications to this device.</p>
                        </div>
                        <Switch
                          ariaLabel="This device notifications"
                          checked={push}
                          onChange={setPush}
                        />
                      </div>
                      <div className="set-row">
                        <div className="set-row__main">
                          <strong>Email digest</strong>
                          <p>A scheduled summary, separate from automatic inbox alerts.</p>
                        </div>
                        <Switch
                          ariaLabel="Email digest"
                          checked={digest}
                          disabled={unavailable}
                          onChange={setDigest}
                        />
                      </div>
                      <Note variant="practical">
                        Messages remain readable in Moss when device notifications are off.
                      </Note>
                      <div className="interruptions-actions">
                        <Button variant="link" onClick={() => setPage("alerts")}>
                          Back to alerts & quiet hours
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <SectionHead title="Alerts & quiet hours" />
                      {busy ? (
                        <EmptyState
                          title={
                            example === "loading"
                              ? "Loading your preferences…"
                              : "Your preferences couldn’t load"
                          }
                          description={
                            example === "loading"
                              ? "Your saved choices will appear here."
                              : "Try again before changing your preferences."
                          }
                          children={
                            example === "error" && (
                              <Button onClick={() => load("fresh")}>Try again</Button>
                            )
                          }
                        />
                      ) : (
                        <>
                          <div className="interruptions-groups">
                            <div className="interruptions-column">
                              {" "}
                              <section aria-labelledby="email-heading">
                                <SectionHead
                                  title="Email alerts"
                                  titleId="email-heading"
                                  titleAs="h3"
                                  rule
                                />
                                <div className="set-row">
                                  <div className="set-row__main">
                                    <strong>Automatic email alerts</strong>
                                    <p>Receive automatic alerts from your connected inbox.</p>
                                  </div>
                                  <Switch
                                    ariaLabel="Automatic email alerts"
                                    checked={email}
                                    onChange={(enabled) => {
                                      setEmail(enabled);
                                      setEmailStatus("Email alert preference saved.");
                                    }}
                                  />
                                </div>
                                {emailStatus && (
                                  <p role="status" className="interruptions-email-status">
                                    {emailStatus}
                                  </p>
                                )}
                                {example === "saved" && (
                                  <p>
                                    Your previous choice is kept. Automatic email alerts are{" "}
                                    {email ? "on" : "off"}.
                                  </p>
                                )}
                                {unavailable ? (
                                  <Note variant="practical">
                                    {example === "revoked"
                                      ? "Email access is turned off. Your alert preference is kept, but Moss can’t check this inbox."
                                      : "No email account is connected. Your alert preference is kept until you connect one."}
                                    <div className="interruptions-actions">
                                      <Button variant="link" onClick={() => setPage("connectors")}>
                                        Go to Connectors
                                      </Button>
                                    </div>
                                  </Note>
                                ) : (
                                  <p className="interruptions-meta">
                                    <Mail size={15} /> Gmail connected · alex@example.com
                                  </p>
                                )}
                              </section>
                              {page === "connectors" && (
                                <EmptyState
                                  title="Connect an email account"
                                  description="Connect your email to receive inbox alerts and run your requested email watches."
                                  children={
                                    <Button
                                      onClick={() => {
                                        load("fresh");
                                        setPage("alerts");
                                      }}
                                    >
                                      Connect Gmail
                                    </Button>
                                  }
                                />
                              )}
                              <section>
                                <SectionHead title="How updates reach you" titleAs="h3" rule />
                                <p>
                                  Always readable in Moss · Device notifications{" "}
                                  {notify && push ? "on" : "off"} · Email digest{" "}
                                  {digest ? "on" : "off"}
                                </p>
                                <Button variant="link" onClick={() => setPage("notifications")}>
                                  Manage notification preferences
                                </Button>
                              </section>
                            </div>
                            <div className="interruptions-column">
                              {" "}
                              <section aria-labelledby="quiet-heading">
                                <SectionHead
                                  title="Quiet hours"
                                  titleId="quiet-heading"
                                  titleAs="h3"
                                  rule
                                  meta={
                                    dirty && !reconcile ? <Badge>Unsaved changes</Badge> : undefined
                                  }
                                />
                                {reconcile ? (
                                  <Note variant="practical">
                                    <strong>Your saved quiet hours differ</strong>
                                    <p>
                                      Choose which schedule to use for future interruptions. Nothing
                                      changes until you choose.
                                    </p>
                                    <div className="interruptions-actions">
                                      <Button
                                        variant="secondary"
                                        onClick={() => {
                                          const next = { ...initialQuiet, enabled: false };
                                          setQuiet(next);
                                          setEditing(next);
                                          setReconcile(false);
                                          setStatus("Kept your saved quiet hours: off.");
                                        }}
                                      >
                                        Keep quiet hours off
                                      </Button>
                                      <Button
                                        variant="secondary"
                                        onClick={() => {
                                          const next = { ...initialQuiet, end: "08:00" };
                                          setQuiet(next);
                                          setEditing(next);
                                          setReconcile(false);
                                          setStatus(
                                            "Using your saved email-check schedule: 10 PM–8 AM."
                                          );
                                        }}
                                      >
                                        Use 10 PM–8 AM
                                      </Button>
                                    </div>
                                  </Note>
                                ) : (
                                  <form
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      if (
                                        !editing.start ||
                                        !editing.end ||
                                        editing.start === editing.end
                                      ) {
                                        setStatus("Choose different start and end times.");
                                        return;
                                      }
                                      if (example === "saveError") {
                                        setStatus(
                                          "Quiet hours couldn’t save. Your previous schedule still applies. Try again."
                                        );
                                        return;
                                      }
                                      setQuiet(editing);
                                      setStatus("Quiet hours saved.");
                                    }}
                                  >
                                    <div className="set-row">
                                      <div className="set-row__main">
                                        <strong>Enable quiet hours</strong>
                                        <p>
                                          {quiet.enabled
                                            ? `Saved schedule: Every day, ${clockLabel(quiet.start)}–${clockLabel(quiet.end)}`
                                            : "Saved schedule: Quiet hours are off"}
                                        </p>
                                      </div>
                                      <Switch
                                        ariaLabel="Enable quiet hours"
                                        checked={editing.enabled}
                                        onChange={(enabled) => editQuiet({ enabled })}
                                      />
                                    </div>
                                    <div className="interruptions-time-fields">
                                      <Field>
                                        <FormLabel htmlFor="from">From</FormLabel>
                                        <input
                                          className="jds-input"
                                          id="from"
                                          type="time"
                                          required
                                          value={editing.start}
                                          onChange={(e) => editQuiet({ start: e.target.value })}
                                        />
                                      </Field>
                                      <Field>
                                        <FormLabel htmlFor="until">Until</FormLabel>
                                        <input
                                          className="jds-input"
                                          id="until"
                                          type="time"
                                          required
                                          value={editing.end}
                                          onChange={(e) => editQuiet({ end: e.target.value })}
                                        />
                                      </Field>
                                    </div>
                                    <Field>
                                      <FormLabel htmlFor="zone">Time zone</FormLabel>
                                      <Select
                                        id="zone"
                                        value={editing.zone}
                                        onChange={(e) => editQuiet({ zone: e.target.value })}
                                      >
                                        <option value="America/Los_Angeles">
                                          Pacific · Los Angeles
                                        </option>
                                        <option value="America/New_York">Eastern · New York</option>
                                        <option value="Europe/London">London</option>
                                      </Select>
                                    </Field>
                                    <div className="interruptions-actions">
                                      <Button type="submit" variant="secondary">
                                        Save quiet hours
                                      </Button>
                                      {example === "saveError" &&
                                        status.includes("couldn’t save") && (
                                          <Button
                                            variant="link"
                                            onClick={() => {
                                              setExample("fresh");
                                              setQuiet(editing);
                                              setStatus("Quiet hours saved.");
                                            }}
                                          >
                                            Try again
                                          </Button>
                                        )}
                                    </div>
                                    {status && (
                                      <p role="status" className="interruptions-save-status">
                                        {status}
                                      </p>
                                    )}
                                  </form>
                                )}
                                <p>Device notifications wait until quiet hours end.</p>
                              </section>
                              <section aria-labelledby="exceptions-heading">
                                <SectionHead
                                  title="Allowed during quiet hours"
                                  titleId="exceptions-heading"
                                  titleAs="h3"
                                  rule
                                />
                                {example === "empty" ? (
                                  <p role="status">
                                    No requested tasks yet. Ask Moss to set up a reminder or watch.
                                  </p>
                                ) : (
                                  <div className="set-row">
                                    <div className="set-row__main">
                                      <strong>Watch for Maya’s reply</strong>
                                      <p>
                                        {exception
                                          ? "You asked for this reply to interrupt you during quiet hours."
                                          : "Its update is readable in chat. Interruptions wait during quiet hours."}
                                      </p>
                                      <Badge tone={exception ? "forest" : "neutral"}>
                                        {exception ? "Exception requested" : "No exception"}
                                      </Badge>
                                    </div>
                                    <Button
                                      variant="link"
                                      onClick={() => {
                                        openChat();
                                        append(
                                          exception
                                            ? "To remove this exception, say: ‘Stop Maya’s reply interrupting me during quiet hours’."
                                            : "If you want this watch to interrupt you, say: ‘Let Maya’s reply interrupt me during quiet hours’. This applies only to Maya’s reply."
                                        );
                                      }}
                                    >
                                      Change in chat
                                    </Button>
                                  </div>
                                )}
                                <p>
                                  Allow a specific task in chat. Disabled notification channels stay
                                  off.
                                </p>
                              </section>
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </section>
            {chat && (
              <InterruptionChat
                key={example}
                records={records}
                onSend={send}
                onClose={closeChat}
                modal={modal}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Prototype />);
