/** Design artifact only. Renders the Work mail settings row with shipped Moss primitives. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Badge, Button, ButtonLink, Divider, Eyebrow, Note, Switch } from "@moss/ui";
import { PaneHead } from "@moss/settings-ui";
import { Bell, CalendarClock, ChevronDown, Link2, Palette, User } from "lucide-react";

Object.assign(globalThis, { React });

const out = resolve("docs/superpowers/specs/outlook-mail-mockup");
const styles = resolve("apps/web/src/styles");

/* ---- Shell: the real Settings frame, Connections pane ---- */

const nav = [
  { label: "Account & preferences", icon: User },
  { label: "Appearance", icon: Palette },
  { label: "Scheduled tasks", icon: CalendarClock },
  { label: "Alerts & quiet hours", icon: Bell },
  { label: "Connections", icon: Link2, active: true }
];

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="set2">
      <div className="set2__mast">
        <h1 className="set2__masttitle">Settings</h1>
        <div className="set2__bar">
          <span />
        </div>
      </div>
      <button type="button" className="set2__picker" aria-expanded={false}>
        <span className="set2__pickerlbl">Section</span>
        <span className="set2__pickername">Connections</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className="set2__grid">
        <nav className="set2__nav" aria-label="Settings categories">
          <div className="set2__navgroup">Your account</div>
          {nav.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className={`set2__navitem${active ? " is-active" : ""}`}
              aria-current={active === true}
            >
              <span className="ic">
                <Icon size={17} aria-hidden="true" />
              </span>
              <span className="lbl">{label}</span>
            </button>
          ))}
        </nav>
        <div className="set2__pane">
          <PaneHead
            title="Connections"
            desc="Everything Moss can reach outside itself, and how each one is doing."
          />
          <dl className="conn__counts" aria-label="Connections at a glance">
            <div className="conn__count">
              <dd>2</dd>
              <dt>Accounts</dt>
            </div>
            <div className="conn__count">
              <dd>Linked</dd>
              <dt>Notes folder</dt>
            </div>
            <div className="conn__count">
              <dd>3</dd>
              <dt>Services</dt>
            </div>
          </dl>
          <div className="wm-stack">
            <CalendarRow />
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Static copy of the shipped calendar row in its current state, for placement. */
function CalendarRow() {
  return (
    <Note variant="practical" aria-label="Outlook calendar connection">
      <p>
        <strong>Outlook calendar · Read only</strong>
      </p>
      <p role="status">Outlook calendar is current within the covered dates.</p>
      <p>
        Last complete refresh: 26 Oct 2026, 2:30 PM. Covered dates: 2026-10-19 through 2026-11-09
        (end date excluded).
      </p>
      <div className="wm-actions">
        <Button>Sync now</Button>
        <Button>Disconnect</Button>
      </div>
    </Note>
  );
}

/* ---- The Work mail row ---- */

type Tone = "amber" | "red";

function MailRow(props: {
  on: boolean;
  badge?: { tone: Tone; text: string };
  status: string;
  children?: ReactNode;
}) {
  return (
    <Note variant="practical" aria-label="Outlook work mail connection">
      <div className="wm-head">
        <p className="wm-title">
          <strong>Outlook work mail · Read only</strong>
          {props.badge ? <Badge tone={props.badge.tone}>{props.badge.text}</Badge> : null}
        </p>
        <Switch ariaLabel="Read work mail" checked={props.on} />
      </div>
      <p role="status">{props.status}</p>
      {props.children}
    </Note>
  );
}

const READ_LINE = "Messages Moss opens show as read in Outlook.";

function Actions({ children }: { children: ReactNode }) {
  return <div className="wm-actions">{children}</div>;
}

function Off() {
  return <MailRow on={false} status="Moss is not reading your work mail." />;
}

function TurningOn() {
  return (
    <MailRow on status="Waiting for the add-on to pair.">
      <div className="wm-setup">
        <ol className="wm-steps">
          <li>
            <span>Download the add-on and open the file in Firefox.</span>
            <span className="wm-inline">
              <ButtonLink href="#download">Download for Firefox</ButtonLink>
              <span>Chrome and Edge come later.</span>
            </span>
          </li>
          <li>Click Add when Firefox asks.</li>
          <li>Open Outlook on the web, click the Moss add-on, and enter this code.</li>
        </ol>
        <div className="wm-code" aria-label="Pairing code">
          <Eyebrow tone="gold">Pairing code</Eyebrow>
          <p className="wm-code__value">K7Q 4MP</p>
          <p>Works once. Expires at 2:55 PM.</p>
          <div>
            <Button variant="link">New code</Button>
          </div>
        </div>
      </div>
      <Divider />
      <p className="wm-alt">
        <span>Cannot install add-ons?</span>
        <Button variant="link">Use the server window</Button>
      </p>
    </MailRow>
  );
}

function ServerWindow() {
  return (
    <MailRow on status="Waiting for Outlook sign-in in the server window.">
      <p>
        Open the server window and sign in to Outlook with your work account. Moss starts reading
        once you are signed in.
      </p>
      <Actions>
        <Button>Open server window</Button>
        <Button variant="link">Use the add-on instead</Button>
      </Actions>
    </MailRow>
  );
}

function Connected() {
  return (
    <MailRow on status="Reading work mail through the Firefox add-on.">
      <p>Last read: today, 2:41 PM. 214 messages read.</p>
      <p>Add-on paired on 26 Oct 2026.</p>
      <p>{READ_LINE}</p>
      <Actions>
        <Button variant="secondary">Revoke add-on</Button>
      </Actions>
    </MailRow>
  );
}

function NotSeen() {
  return (
    <MailRow
      on
      badge={{ tone: "amber", text: "Not seen" }}
      status="The add-on has not checked in since yesterday at 5:12 PM. Mail is read only while Outlook is open in Firefox."
    >
      <p>Last read: yesterday, 5:12 PM. 214 messages read.</p>
      <p>{READ_LINE}</p>
      <Actions>
        <ButtonLink href="https://outlook.office.com/mail/">Open Outlook</ButtonLink>
        <Button variant="secondary">Revoke add-on</Button>
      </Actions>
    </MailRow>
  );
}

function SignInAddOn() {
  return (
    <MailRow
      on
      badge={{ tone: "amber", text: "Sign-in needed" }}
      status="Outlook sign-in required; work mail is not current. Sign in to Outlook in Firefox, then Moss carries on."
    >
      <p>Last read: today, 9:05 AM. 214 messages read.</p>
      <Actions>
        <ButtonLink href="https://outlook.office.com/mail/">Open Outlook</ButtonLink>
        <Button variant="secondary">Revoke add-on</Button>
      </Actions>
    </MailRow>
  );
}

function SignInServer() {
  return (
    <MailRow
      on
      badge={{ tone: "amber", text: "Sign-in needed" }}
      status="Outlook sign-in required; work mail is not current. Open the server window and sign in, then retry."
    >
      <p>Last read: today, 9:05 AM. 214 messages read.</p>
      <Actions>
        <Button>Open server window</Button>
        <Button>Retry</Button>
      </Actions>
    </MailRow>
  );
}

function PageChanged() {
  return (
    <MailRow
      on
      badge={{ tone: "red", text: "Paused" }}
      status="Outlook mail layout is unsupported. Reading is paused; the reader needs repair."
    >
      <p>Last read: today, 11:20 AM. 214 messages read.</p>
    </MailRow>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="wm-state" aria-label={label}>
      <Eyebrow tone="muted">{label}</Eyebrow>
      {children}
    </section>
  );
}

/* ---- Pages ---- */

const pages: { file: string; title: string; content: ReactNode }[] = [
  { file: "01-off", title: "Off", content: <Off /> },
  { file: "02-turning-on", title: "Turning on: add-on", content: <TurningOn /> },
  { file: "03-server-window", title: "Turning on: server window", content: <ServerWindow /> },
  { file: "04-connected", title: "Connected", content: <Connected /> },
  {
    file: "05-problems",
    title: "Problem states",
    content: (
      <>
        <Labelled label="Mockup state: add-on not seen">
          <NotSeen />
        </Labelled>
        <Labelled label="Mockup state: sign-in needed, add-on route">
          <SignInAddOn />
        </Labelled>
        <Labelled label="Mockup state: sign-in needed, server window route">
          <SignInServer />
        </Labelled>
        <Labelled label="Mockup state: Outlook page changed">
          <PageChanged />
        </Labelled>
      </>
    )
  }
];

function page(title: string, content: ReactNode) {
  const body = renderToStaticMarkup(<Shell>{content}</Shell>);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Work mail mockup</title><link rel="stylesheet" href="moss-ui.css"><link rel="stylesheet" href="frame.css"></head><body>${body}</body></html>\n`;
}

for (const p of pages) writeFileSync(resolve(out, `${p.file}.html`), page(p.title, p.content));

const links = pages.map((p) => `<li><a href="${p.file}.html">${p.title}</a></li>`).join("");
writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Work mail mockup</title><link rel="stylesheet" href="moss-ui.css"></head><body><main style="padding:var(--space-7)"><h1>Work mail settings row</h1><ul>${links}</ul></main></body></html>\n`
);

/* ---- Frozen stylesheet: the app's cascade plus the Settings sheets, fonts kept local ---- */

const bundle = await build({
  stdin: {
    contents: [
      "index.css",
      "settings.css",
      "settings-panes.css",
      "settings-panes-2.css",
      "settings-panes-3.css"
    ]
      .map((f) => `@import "./${f}";`)
      .join("\n"),
    resolveDir: styles,
    loader: "css"
  },
  bundle: true,
  write: false,
  external: ["/fonts/*"],
  loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  logLevel: "error"
});
writeFileSync(
  resolve(out, "moss-ui.css"),
  bundle.outputFiles[0].text.replaceAll("/fonts/archivo/", "fonts/")
);
mkdirSync(resolve(out, "fonts"), { recursive: true });
for (const f of readdirSync(resolve("apps/web/public/fonts/archivo"))) {
  copyFileSync(resolve("apps/web/public/fonts/archivo", f), resolve(out, "fonts", f));
}
console.log(`Built ${pages.length} screens.`);
