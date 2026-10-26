/** Design artifact only. Renders the Work mail settings section with shipped Moss primitives. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Button, ButtonLink, Eyebrow, Indicator, Switch } from "@moss/ui";
import { Group, PaneHead, Row } from "@moss/settings-ui";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Link2,
  Mail,
  MailCheck,
  MailWarning,
  Palette,
  User
} from "lucide-react";

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
              <dd>0</dd>
              <dt>Accounts</dt>
            </div>
            <div className="conn__count">
              <dd>None</dd>
              <dt>Notes folder</dt>
            </div>
            <div className="conn__count">
              <dd>0</dd>
              <dt>Services</dt>
            </div>
          </dl>
          {children}
          <AccountsNeighbour />
          <NotesNeighbour />
        </div>
      </div>
    </div>
  );
}

/* Static copies of the shipped neighbouring sections, for comparison. */
function AccountsNeighbour() {
  return (
    <Group title="Accounts">
      <div className="provpick">
        <div className="provpick__hd">Connect an account</div>
        <div className="provpick__grid">
          <button type="button" className="provpick__item">
            <span className="provpick__dot" />
            Google
          </button>
          <button type="button" className="provpick__item">
            <span className="provpick__dot" />
            Email (IMAP)
          </button>
        </div>
        <div className="provpick__foot">
          Connect Google or an email (IMAP) account using the credentials you provide.
        </div>
      </div>
    </Group>
  );
}

function NotesNeighbour() {
  return (
    <Group
      title={<span className="src-title">Notes folder</span>}
      desc="Choose a folder of Markdown notes on this server."
    >
      <div className="vault">
        <span className="vault__ic">
          <FolderOpen size={18} aria-hidden="true" />
        </span>
        <div className="vault__main" role="status">
          <div className="vault__path vault__path--empty">No folder linked</div>
          <div className="vault__meta">
            Choose a folder on the server to include your notes as context.
          </div>
        </div>
        <div className="vault__act">
          <Button variant="secondary" size="sm" icon={<FolderSearch size={15} />}>
            Browse…
          </Button>
        </div>
      </div>
    </Group>
  );
}

/* ---- The Work mail section ---- */

type Health = "ready" | "drift" | "error" | "idle";

function WorkMail(props: { on: boolean; children: ReactNode }) {
  return (
    <Group
      title={<span className="src-title">Work mail</span>}
      desc="Outlook on the web, read only."
      action={<Switch ariaLabel="Read work mail" checked={props.on} />}
    >
      {props.children}
    </Group>
  );
}

/* One status row in the Notes folder pattern: icon tile, status, detail lines, small actions. */
function StatusRow(props: {
  icon: ReactNode;
  status: ReactNode;
  empty?: boolean;
  health?: Health;
  meta: ReactNode[];
  actions?: ReactNode;
}) {
  return (
    <div className="vault">
      <span className="vault__ic">{props.icon}</span>
      <div className="vault__main" role="status">
        <div className={`vault__path${props.empty ? " vault__path--empty" : ""}`}>
          {props.health ? <Indicator status={props.health} label={props.status} /> : props.status}
        </div>
        {props.meta.map((line, i) => (
          <div className="vault__meta" key={i}>
            {line}
          </div>
        ))}
      </div>
      {props.actions ? <div className="vault__act">{props.actions}</div> : null}
    </div>
  );
}

const READ_LINE = "Messages Moss opens show as read in Outlook.";
const LAST_READ = (when: string) => `Last read ${when} · 214 messages read`;

function Off() {
  return (
    <WorkMail on={false}>
      <StatusRow
        icon={<Mail size={18} aria-hidden="true" />}
        status="Not reading work mail"
        empty
        meta={["Switch on to pair the Moss add-on."]}
      />
    </WorkMail>
  );
}

function TurningOn() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<Mail size={18} aria-hidden="true" />}
        status="Waiting for the add-on"
        empty
        meta={["Pairing code expires at 2:55 PM."]}
      />
      <Row
        className="set-row--stack-narrow"
        name="1. Download the add-on"
        desc="Open the file in Firefox. Chrome and Edge come later."
        control={
          <Button variant="secondary" size="sm" icon={<Download size={15} />}>
            Download for Firefox
          </Button>
        }
      />
      <Row name="2. Add it to Firefox" desc="Click Add when Firefox asks." />
      <Row
        className="set-row--stack-narrow"
        name="3. Enter the pairing code"
        desc="Open Outlook on the web, click the Moss add-on, and enter this code. It works once."
        control={
          <span className="wm-code">
            <dl className="wm-code__count">
              <div className="conn__count">
                <dd>K7Q 4MP</dd>
                <dt>Pairing code</dt>
              </div>
            </dl>
            <Button variant="quiet" size="sm">
              New code
            </Button>
          </span>
        }
      />
      <Row
        className="set-row--stack-narrow"
        name="Cannot install add-ons?"
        desc="Moss can read mail in a browser window on its server instead."
        control={
          <Button variant="secondary" size="sm">
            Use the server window
          </Button>
        }
      />
    </WorkMail>
  );
}

function ServerWindow() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<Mail size={18} aria-hidden="true" />}
        status="Waiting for Outlook sign-in"
        empty
        meta={["Open the server window and sign in with your work account."]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<ExternalLink size={15} />}>
              Open server window
            </Button>
            <Button variant="quiet" size="sm">
              Use the add-on
            </Button>
          </>
        }
      />
    </WorkMail>
  );
}

function Connected() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<MailCheck size={18} aria-hidden="true" />}
        status="Reading through the Firefox add-on"
        meta={[LAST_READ("today, 2:41 PM"), `Add-on paired 26 Oct 2026. ${READ_LINE}`]}
        actions={
          <Button variant="quiet" size="sm">
            Revoke add-on
          </Button>
        }
      />
    </WorkMail>
  );
}

function NotSeen() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<MailWarning size={18} aria-hidden="true" />}
        health="drift"
        status="Add-on not seen since yesterday, 5:12 PM"
        meta={[
          "Mail is read only while Outlook is open in Firefox.",
          LAST_READ("yesterday, 5:12 PM")
        ]}
        actions={
          <>
            <ButtonLink
              variant="secondary"
              size="sm"
              href="https://outlook.office.com/mail/"
              icon={<ExternalLink size={15} />}
            >
              Open Outlook
            </ButtonLink>
            <Button variant="quiet" size="sm">
              Revoke add-on
            </Button>
          </>
        }
      />
    </WorkMail>
  );
}

function SignInAddOn() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<MailWarning size={18} aria-hidden="true" />}
        health="drift"
        status="Outlook sign-in required"
        meta={[
          "Work mail is not current. Sign in to Outlook in Firefox, then Moss carries on.",
          LAST_READ("today, 9:05 AM")
        ]}
        actions={
          <ButtonLink
            variant="secondary"
            size="sm"
            href="https://outlook.office.com/mail/"
            icon={<ExternalLink size={15} />}
          >
            Open Outlook
          </ButtonLink>
        }
      />
    </WorkMail>
  );
}

function SignInServer() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<MailWarning size={18} aria-hidden="true" />}
        health="drift"
        status="Outlook sign-in required"
        meta={[
          "Work mail is not current. Open the server window and sign in, then retry.",
          LAST_READ("today, 9:05 AM")
        ]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<ExternalLink size={15} />}>
              Open server window
            </Button>
            <Button variant="secondary" size="sm">
              Retry
            </Button>
          </>
        }
      />
    </WorkMail>
  );
}

function PageChanged() {
  return (
    <WorkMail on>
      <StatusRow
        icon={<MailWarning size={18} aria-hidden="true" />}
        health="error"
        status="Paused: Outlook mail page changed"
        meta={[
          "Moss cannot read the new layout and needs an update.",
          LAST_READ("today, 11:20 AM")
        ]}
      />
    </WorkMail>
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
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Work mail mockup</title><link rel="stylesheet" href="moss-ui.css"></head><body><main style="padding:var(--space-7)"><h1>Work mail settings section</h1><ul>${links}</ul></main></body></html>\n`
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
