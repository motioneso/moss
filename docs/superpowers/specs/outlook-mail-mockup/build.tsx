/** Design artifact only. Renders Outlook work mail inside the add-account flow with shipped Moss primitives. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Button, ButtonLink, Eyebrow, Indicator, Switch } from "@moss/ui";
import { Group, PaneHead } from "@moss/settings-ui";
import {
  ArrowLeft,
  Bell,
  CalendarClock,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Link2,
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

/* An open flow hides the pane head, counts and other sections, as the app does. */
function Shell({ flow = false, children }: { flow?: boolean; children: ReactNode }) {
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
          {flow ? (
            children
          ) : (
            <>
              <PaneHead
                title="Connections"
                desc="Everything Moss can reach outside itself, and how each one is doing."
              />
              <dl className="conn__counts" aria-label="Connections at a glance">
                <div className="conn__count">
                  <dd>1</dd>
                  <dt>Account</dt>
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
              <Group title="Accounts">{children}</Group>
              <NotesNeighbour />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Static copy of the shipped Notes folder section, for comparison. */
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

/* ---- Add account: the shipped picker with Outlook added ---- */

function Picker() {
  return (
    <div className="provpick">
      <div className="provpick__hd">Connect an account</div>
      <div className="provpick__grid">
        {["Google", "Outlook", "Email (IMAP)"].map((name) => (
          <button key={name} type="button" className="provpick__item">
            <span className="provpick__dot" />
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---- Connect Outlook: the shipped Google flow layout ---- */

function Flow({ children }: { children: ReactNode }) {
  return (
    <div className="gflow">
      <button type="button" className="gflow__back">
        <ArrowLeft size={15} aria-hidden="true" />
        All accounts
      </button>
      <div className="gflow__intro">
        <span className="gflow__g">O</span>
        <div className="gflow__introtx">
          <div className="gflow__title">Connect Outlook</div>
        </div>
      </div>
      <div className="gflow__card">{children}</div>
    </div>
  );
}

function SignIn() {
  return (
    <Flow>
      <div className="onb-cred__actions">
        <Button size="sm" icon={<ExternalLink size={15} />}>
          Sign in with Microsoft
        </Button>
        <Button variant="quiet" size="sm">
          Cancel
        </Button>
      </div>
    </Flow>
  );
}

function Step({ n, text, children }: { n: number; text: string; children?: ReactNode }) {
  return (
    <li className="onb-guide__step">
      <span className="onb-guide__n">{n}</span>
      <div className="onb-guide__body">
        <div className="onb-guide__t">{text}</div>
        {children ? <div className="wm-stepact">{children}</div> : null}
      </div>
    </li>
  );
}

function Blocked() {
  return (
    <Flow>
      <p className="wm-flowstatus" role="status">
        <Indicator status="drift" label="Your organisation blocked this sign-in" />
      </p>
      <div className="onb-cred__hd">Use the browser add-on instead</div>
      <ol className="onb-guide">
        <Step n={1} text="Download the add-on">
          <Button variant="secondary" size="sm" icon={<Download size={15} />}>
            Download
          </Button>
        </Step>
        <Step n={2} text="Add it to your browser" />
        <Step n={3} text="Enter this code in the add-on">
          <dl className="wm-code" aria-label="Pairing code">
            <div className="conn__count">
              <dd>K7Q 4MP</dd>
            </div>
          </dl>
          <Button variant="quiet" size="sm">
            New code
          </Button>
        </Step>
      </ol>
      <div className="onb-cred__actions">
        <span className="onb-cred__hint">Waiting for the add-on</span>
      </div>
      <p className="wm-alt">
        <Button variant="link" size="sm">
          Use the server window
        </Button>
      </p>
    </Flow>
  );
}

/* ---- Connected: the shipped account row with a mail line ---- */

function OutlookRow(props: {
  health: "ready" | "drift" | "error";
  label: string;
  mail: string;
  actions?: ReactNode;
}) {
  return (
    <div className="acct">
      <div className="acct__logo">O</div>
      <div className="acct__main">
        <div className="acct__name">Outlook</div>
        <div className="acct__sub">
          <span>Browser add-on</span>
          <span className="acct__dot">·</span>
          <Indicator status={props.health} label={props.label} />
        </div>
        <div className="acct__features">
          <div className="acct-feature">
            <div>
              <div className="acct-feature__label">Email access</div>
              <div className="acct-feature__desc">{props.mail}</div>
            </div>
            <Switch ariaLabel="Email access" checked />
          </div>
        </div>
      </div>
      <div className="acct__actions">
        {props.actions}
        <Button variant="quiet" size="sm">
          Revoke
        </Button>
      </div>
    </div>
  );
}

const openOutlook = (
  <ButtonLink
    variant="secondary"
    size="sm"
    href="https://outlook.office.com/mail/"
    icon={<ExternalLink size={15} />}
  >
    Open Outlook
  </ButtonLink>
);

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="wm-state" aria-label={label}>
      <Eyebrow tone="muted">{label}</Eyebrow>
      {children}
    </section>
  );
}

/* ---- Pages ---- */

const pages: { file: string; title: string; flow?: boolean; content: ReactNode }[] = [
  { file: "01-add-account", title: "Add account", content: <Picker /> },
  { file: "02-sign-in", title: "Connect Outlook", flow: true, content: <SignIn /> },
  { file: "03-sign-in-blocked", title: "Sign-in blocked", flow: true, content: <Blocked /> },
  {
    file: "04-connected",
    title: "Connected",
    content: <OutlookRow health="ready" label="Connected" mail="Last read 2:40 PM" />
  },
  {
    file: "05-problems",
    title: "Problem states",
    content: (
      <>
        <Labelled label="Mockup state: add-on not seen">
          <OutlookRow
            health="drift"
            label="Add-on not seen"
            mail="Last read yesterday 5:12 PM"
            actions={openOutlook}
          />
        </Labelled>
        <Labelled label="Mockup state: Outlook sign-in needed">
          <OutlookRow
            health="drift"
            label="Outlook sign-in needed"
            mail="Last read 9:05 AM"
            actions={openOutlook}
          />
        </Labelled>
        <Labelled label="Mockup state: Outlook page changed">
          <OutlookRow health="error" label="Outlook page changed" mail="Last read 11:20 AM" />
        </Labelled>
      </>
    )
  }
];

function page(title: string, flow: boolean, content: ReactNode) {
  const body = renderToStaticMarkup(<Shell flow={flow}>{content}</Shell>);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Outlook mail mockup</title><link rel="stylesheet" href="moss-ui.css"><link rel="stylesheet" href="frame.css"></head><body>${body}</body></html>\n`;
}

for (const p of pages)
  writeFileSync(resolve(out, `${p.file}.html`), page(p.title, p.flow === true, p.content));

const links = pages.map((p) => `<li><a href="${p.file}.html">${p.title}</a></li>`).join("");
writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outlook mail mockup</title><link rel="stylesheet" href="moss-ui.css"></head><body><main style="padding:var(--space-7)"><h1>Outlook work mail mockups</h1><ul>${links}</ul></main></body></html>\n`
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
