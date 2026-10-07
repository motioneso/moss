/** Design-only static fixtures. No model-authored summary and no runtime action handlers. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrandMark, Button, ButtonLink, Card, IconButton, SectionHead } from "@moss/ui";
import { ArrowUp, MoreHorizontal, SquarePen, X } from "lucide-react";
Object.assign(globalThis, { React });
const out = resolve("docs/superpowers/specs/approval-card");

// Synthetic stand-ins for the server's approval record. This is a design fixture, not an API type.
// title: route chat.title; target: server-read resource; fields: validated submitted values.
// There is intentionally no model summary, HTML, route path or internal ID in this view model.
type ApprovalRecord = Readonly<{
  title: string;
  target: string;
  fields: readonly (readonly [label: string, value: string])[];
  outsideContent: boolean;
}>;
const memory: ApprovalRecord = {
  title: "Delete memory",
  target: "I prefer morning meetings, and I keep Friday afternoons free for focused work.",
  fields: [],
  outsideContent: false
};
const settings: ApprovalRecord = {
  title: "Change settings",
  target: "Weather",
  fields: [
    ["Temperature", "Celsius"],
    ["Wind speed", "Kilometres per hour"],
    ["Rainfall", "Millimetres"]
  ],
  outsideContent: false
};
const theme: ApprovalRecord = {
  title: "Delete custom theme",
  target: "Canyon after rain",
  fields: [],
  outsideContent: true
};
function Approval({ record }: { record: ApprovalRecord }) {
  return (
    <Card padding="sm" aria-label={record.title}>
      <div className="approval-stack">
        <h2 className="approval-title">{record.title}</h2>
        <p className="approval-target">{record.target}</p>
        {record.fields.length > 0 && (
          <dl className="approval-fields">
            {record.fields.map(([label, value]) => (
              <div className="approval-field" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {record.outsideContent && (
          <p className="jds-hint approval-notice">
            moss read something from outside your account before asking this.
          </p>
        )}
        <div className="approval-actions">
          <Button variant={record.title.startsWith("Delete") ? "danger" : "primary"}>
            Approve
          </Button>
          <Button variant="secondary">Reject</Button>
        </div>
      </div>
    </Card>
  );
}
function Drawer({ prompt, children }: { prompt: string; children: ReactNode }) {
  return (
    <>
      <header className="mock-app-head">
        <BrandMark size={22} />
        <strong>moss</strong>
        <span className="jds-hint">Today</span>
      </header>
      <aside className="chatd" role="dialog" aria-label="Chat with Moss">
        <div className="chatd__head">
          <span className="chatd__mark">
            <BrandMark size={16} />
          </span>
          <div className="chatd__id">
            <div className="chatd__name">Moss</div>
            <div className="chatd__status">Here when you need me</div>
          </div>
          <IconButton aria-label="New chat">
            <SquarePen />
          </IconButton>
          <IconButton aria-label="More chat options">
            <MoreHorizontal />
          </IconButton>
          <IconButton aria-label="Close chat">
            <X />
          </IconButton>
        </div>
        <div className="chatd__body-wrap">
          <div className="chatd__body">
            <div className="chatd-msg chatd-msg--me">
              <div className="chatd-bubble">{prompt}</div>
            </div>
            {children}
          </div>
        </div>
        <div className="chatd__composer">
          <div className="chatd-input">
            <textarea aria-label="Message Moss" placeholder="Message Moss…" rows={1} readOnly />
            <IconButton aria-label="Send message" disabled>
              <ArrowUp />
            </IconButton>
          </div>
        </div>
      </aside>
    </>
  );
}
const pending = [
  {
    file: "01-delete-memory",
    title: "Delete memory",
    prompt: "Forget my meeting preference.",
    record: memory
  },
  {
    file: "02-change-settings",
    title: "Change settings",
    prompt: "Use metric units for the weather.",
    record: settings
  },
  {
    file: "03-outside-content",
    title: "Outside content",
    prompt: "Delete my Canyon after rain theme.",
    record: theme
  }
];
const outcomes = [
  { file: "04-approved", title: "Approved", text: "Approved · Delete memory" },
  {
    file: "05-declined",
    title: "You declined",
    text: "You declined · Delete memory"
  },
  {
    file: "06-timed-out",
    title: "Timed out",
    text: "Timed out · Delete memory"
  },
  {
    file: "07-cancelled",
    title: "Cancelled",
    text: "Cancelled · Delete memory"
  }
];
const screens = [
  ...pending.map((p) => ({
    ...p,
    content: (
      <Drawer prompt={p.prompt}>
        <Approval record={p.record} />
      </Drawer>
    )
  })),
  ...outcomes.map((p) => ({
    ...p,
    content: (
      <Drawer prompt="Forget my meeting preference.">
        <p className="jds-hint approval-outcome" role="status">
          {p.text}
        </p>
      </Drawer>
    )
  }))
];
function document(title: string, content: ReactNode) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Moss mockup</title><link rel="stylesheet" href="moss-ui.css"><link rel="stylesheet" href="mockup.css"></head><body>${renderToStaticMarkup(content).replaceAll('<p class="approval-target">', '<!-- prettier-ignore --><p class="approval-target">')}</body></html>\n`;
}
for (const p of screens)
  writeFileSync(resolve(out, p.file + ".html"), document(p.title, p.content));
writeFileSync(
  resolve(out, "screens.json"),
  JSON.stringify(
    screens.map(({ file, title }) => ({ file, title })),
    null,
    2
  ) + "\n"
);
writeFileSync(
  resolve(out, "index.html"),
  document(
    "Approval cards",
    <main className="mock-index">
      <SectionHead title="Approval cards" titleAs="h1" />
      <p className="jds-hint">Static design review · open a state at desktop or phone width.</p>
      <nav aria-label="Mockup states">
        {screens.map((p) => (
          <ButtonLink key={p.file} variant="quiet" href={p.file + ".html"}>
            {p.title}
          </ButtonLink>
        ))}
      </nav>
      <div className="mock-review-pair">
        <section>
          <h2>Desktop · 404px drawer</h2>
          <iframe title="Delete memory at desktop width" src="01-delete-memory.html" />
        </section>
        <section>
          <h2>Phone · 390px</h2>
          <iframe
            className="mock-phone"
            title="Delete memory at phone width"
            src="01-delete-memory.html"
          />
        </section>
      </div>
    </main>
  )
);
readFileSync(resolve(out, "moss-ui.css"));
console.log(`Built ${screens.length} static states.`);
