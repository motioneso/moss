import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  Field,
  FormLabel,
  Note,
  SectionHead,
  Select
} from "@moss/ui";
import "../../../../apps/web/src/styles/tokens.css";
import "../../../../packages/ui/src/styles.css";
import "../../../../apps/web/src/styles/components-forms.css";
import "./layout.css";

const scenarios = {
  disconnected: "Not connected",
  preparing: "Preparing browser",
  signin: "Microsoft sign-in",
  confirm: "Confirm account",
  syncing: "First sync",
  current: "Up to date",
  reconnect: "Sign-in expired",
  changed: "Different account detected",
  blocked: "Sign-in blocked",
  unavailable: "Browser unavailable",
  unreadable: "Calendar unreadable",
  disconnect: "Disconnect confirmation",
  removing: "Removing browser session",
  cleanup: "Session removal failed"
};

function App() {
  const [person, setPerson] = useState("Alex");
  const [states, setStates] = useState({ Alex: "disconnected", Sam: "disconnected" });
  const [theme, setTheme] = useState("light");
  const state = states[person];
  const address = `${person.toLowerCase()}@example.com`;
  const go = (next) => setStates((old) => ({ ...old, [person]: next }));
  const action = (label, next, variant = "primary") => (
    <Button variant={variant} onClick={() => go(next)}>
      {label}
    </Button>
  );
  document.documentElement.dataset.colorMode = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme === "sage" ? "sage" : "forest";

  let content;
  switch (state) {
    case "disconnected":
      content = (
        <>
          <EmptyState
            title="Bring your Outlook calendar into Moss"
            description="See your upcoming events alongside your day. Start by signing into Outlook in a separate browser session."
          />
          <Note variant="practical">
            Your primary calendar, from yesterday through the next 30 days. Moss checks for changes
            about every five minutes. Edit events in Outlook.
          </Note>
          <p>
            Sign-in happens on Microsoft’s pages. Your organization’s usual sign-in and device
            requirements still apply.
          </p>
          <div className="actions">{action("Connect Outlook", "preparing")}</div>
        </>
      );
      break;
    case "preparing":
      content = (
        <>
          <SectionHead title="Preparing your Outlook session" />
          <p role="status">Creating a separate browser for your connection…</p>
          <p>You can leave Settings and return to finish.</p>
          <div className="actions">{action("Cancel setup", "removing", "secondary")}</div>
        </>
      );
      break;
    case "signin":
      content = (
        <>
          <SectionHead title="Sign into Outlook" />
          <p>
            Open your sign-in window and complete Microsoft sign-in, including any verification your
            organization asks for.
          </p>
          <Note variant="practical">
            The separate window will show Microsoft’s real sign-in pages. This review does not open
            Microsoft or accept passwords.
          </Note>
          <div className="actions">
            {action("Open sign-in window", "signin")}
            {action("Cancel setup", "removing", "secondary")}
          </div>
          <p role="status">
            Waiting for Outlook to show your account. Once it is ready, Moss will ask you to confirm
            it.
          </p>
          <p>
            The browser stays signed in on this Moss installation so calendar updates can continue
            after you close Moss.
          </p>
        </>
      );
      break;
    case "confirm":
      content = (
        <>
          <SectionHead title="Is this your Outlook account?" />
          <p>Moss found this account in Outlook:</p>
          <p>
            <strong>{address}</strong>
          </p>
          <p>
            Connect this primary calendar to {person}’s Moss account. No events will be imported
            until you confirm.
          </p>
          <div className="actions">
            {action("Connect this calendar", "syncing")}
            {action("Use a different account", "removing", "secondary")}
          </div>
          <p>Choosing a different account clears this setup session so you can start again.</p>
        </>
      );
      break;
    case "syncing":
      content = (
        <>
          <SectionHead title="Getting your upcoming events" />
          <p>{address}</p>
          <p role="status">
            Reading your primary calendar. Your events will appear when the first sync finishes.
          </p>
          <p>You can close this page; Moss will continue.</p>
          <div className="actions">{action("Disconnect", "disconnect", "secondary")}</div>
        </>
      );
      break;
    case "current":
      content = (
        <>
          <SectionHead title="Outlook calendar" meta={<Badge tone="forest">Up to date</Badge>} />
          <p>
            <strong>{address}</strong> · Primary calendar
          </p>
          <p role="status">12 upcoming events · Last checked just now</p>
          <p>
            Coverage: yesterday through the next 30 days. Checks about every five minutes while Moss
            is running.
          </p>
          <Note variant="practical">
            Your imported events are read-only. Open Outlook to change them.
          </Note>
          <div className="actions">
            {action("Sync now", "syncing")}
            {action("Disconnect", "disconnect", "secondary")}
          </div>
        </>
      );
      break;
    case "reconnect":
      content = (
        <>
          <SectionHead
            title="Sign in again to keep your calendar current"
            meta={<Badge tone="amber">Sync paused</Badge>}
          />
          <p>{address}</p>
          <p>
            Microsoft needs you to sign in again. Your existing events remain visible with their
            last checked time.
          </p>
          <div className="actions">
            {action("Sign in again", "signin")}
            {action("Disconnect", "disconnect", "secondary")}
          </div>
          <p>After sign-in, Moss checks that you returned to the same Outlook account.</p>
        </>
      );
      break;
    case "changed":
      content = (
        <>
          <SectionHead
            title="This is a different Outlook account"
            meta={<Badge tone="amber">Sync paused</Badge>}
          />
          <p>Expected: {address}</p>
          <p>Detected: another@example.com</p>
          <p>
            Moss has paused this connection. No events from the different account have been
            imported.
          </p>
          <div className="actions">
            {action("Sign into the original account", "signin")}
            {action("Disconnect", "disconnect", "secondary")}
          </div>
          <p>To connect a different calendar, disconnect first and start a new connection.</p>
        </>
      );
      break;
    case "blocked":
      content = (
        <>
          <SectionHead title="Microsoft could not finish sign-in" />
          <p>
            Your organization may require an approved device or a different sign-in method. Follow
            the message in Microsoft’s window or ask your organization’s IT team.
          </p>
          <div className="actions">
            {action("Open sign-in window", "signin")}
            {action("Cancel setup", "removing", "secondary")}
          </div>
        </>
      );
      break;
    case "unavailable":
      content = (
        <>
          <SectionHead title="Outlook’s browser is unavailable" />
          <p>Calendar sync cannot run right now. Existing events keep their last checked time.</p>
          <p>
            If retrying does not help, ask the person who manages this Moss installation to check
            the Outlook browser service.
          </p>
          <div className="actions">{action("Try again", "preparing")}</div>
        </>
      );
      break;
    case "unreadable":
      content = (
        <>
          <SectionHead
            title="Moss could not read this calendar view"
            meta={<Badge tone="amber">Sync paused</Badge>}
          />
          <p>
            Outlook may have changed its layout. Existing events remain visible; this failed scan
            will not remove them.
          </p>
          <div className="actions">
            {action("Try again", "syncing")}
            {action("Disconnect", "disconnect", "secondary")}
          </div>
        </>
      );
      break;
    case "disconnect":
      content = (
        <>
          <SectionHead title="Disconnect Outlook?" />
          <p>
            Stop future imports, remove this connection’s events from Moss, and delete its saved
            browser session from this installation.
          </p>
          <p>
            Your events in Outlook will stay as they are. To reconnect later, you will sign in
            again.
          </p>
          <div className="actions">
            {action("Disconnect and remove session", "removing", "danger")}
            {action("Keep connected", "current", "secondary")}
          </div>
        </>
      );
      break;
    case "removing":
      content = (
        <>
          <SectionHead title="Removing your Outlook session" />
          <p role="status">
            Sync is stopped. Moss is removing the saved browser session before allowing another
            connection.
          </p>
        </>
      );
      break;
    case "cleanup":
      content = (
        <>
          <SectionHead title="Sync stopped; session removal needs attention" />
          <p>
            Moss could not finish removing the saved browser session. A new connection is blocked
            until cleanup finishes.
          </p>
          <div className="actions">{action("Retry session removal", "removing")}</div>
        </>
      );
      break;
  }

  return (
    <main className="review">
      <header className="stack">
        <Eyebrow>Design review · Fictional accounts</Eyebrow>
        <SectionHead title="Outlook setup" titleAs="h1" />
        <p>
          This interactive draft has no backend and makes no network requests. Review controls
          simulate states; they do not prove account isolation.
        </p>
      </header>
      <section className="review-controls" aria-label="Review controls">
        <Field>
          <FormLabel htmlFor="person">Moss user</FormLabel>
          <Select id="person" value={person} onChange={(e) => setPerson(e.target.value)}>
            <option>Alex</option>
            <option>Sam</option>
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor="state">Preview state</FormLabel>
          <Select id="state" value={state} onChange={(e) => go(e.target.value)}>
            {Object.entries(scenarios).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor="theme">Theme</FormLabel>
          <Select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="sage">Sage</option>
          </Select>
        </Field>
      </section>
      <section className="stack" aria-label="Proposed connection screen">
        <Eyebrow>Settings / Connections · {person}</Eyebrow>
        <div className="stack" key={`${person}-${state}`} aria-live="polite">
          {content}
        </div>
      </section>
      <footer className="stack">
        <SectionHead title="Review the flow" rule />
        <p>
          Use Preview state to simulate Microsoft finishing sign-in, sync completion, or failures.
          Switch Moss user to compare independent in-memory drafts. Reloading resets both.
        </p>
        <p>Proposed flow: Connect Outlook → sign in → confirm account → first sync → up to date.</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
