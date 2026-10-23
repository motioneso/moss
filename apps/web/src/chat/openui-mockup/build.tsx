/** THROWAWAY DESIGN PROTOTYPE: three visual reply treatments inside Moss chat.
 * Synthetic examples only. No OpenUI runtime, API calls, model calls, or stored state.
 * Run: pnpm exec tsx apps/web/src/chat/openui-mockup/build.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrandMark } from "../../../../../packages/ui/src/brand-mark";
import { Button } from "../../../../../packages/ui/src/button";
import { IconButton } from "../../../../../packages/ui/src/icon-button";
import { Card } from "../../../../../packages/ui/src/card";
import { Badge } from "../../../../../packages/ui/src/badge";
import { Eyebrow } from "../../../../../packages/ui/src/eyebrow";
import { Note } from "../../../../../packages/ui/src/note";
import { AgendaRow } from "../../../../../packages/ui/src/agenda-row";
import { RowIndex, RowIndexItem } from "../../../../../packages/ui/src/row-index";
import { SectionHead } from "../../../../../packages/ui/src/section-head";
import {
  ArrowUp,
  ArrowUpRight,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  House,
  Landmark,
  ListTodo,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Search,
  Settings,
  SquarePen
} from "lucide-react";

Object.assign(globalThis, { React });
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const noop = () => {};
type Scenario = "plan" | "money" | "compare";
type Variant = "A" | "B" | "C";

const examples = {
  plan: {
    prompt: "What does tomorrow look like? Where can I fit some focused work?",
    intro:
      "Your morning has the breathing room. I’d keep 10–11:30 clear for focused work; the afternoon has two meetings close together.",
    title: "A little space before the busy part",
    eyebrow: "Tomorrow · Monday, October 26",
    source: "Calendar + Tasks",
    suggestion: "What should I focus on first?",
    answer:
      "I’d start with the proposal outline. It needs a clear head, and that 90-minute gap gives you room to get a first draft down."
  },
  money: {
    prompt: "How’s my everyday spending looking this month?",
    intro:
      "You’ve spent $1,284 of the $1,650 you set aside. Groceries still have room; dining out is $40 over its plan.",
    title: "Most of your plan still holds",
    eyebrow: "Everyday spending · October 1–25",
    source: "Finance · 42 transactions",
    suggestion: "Show me the dining-out details",
    answer:
      "In this example, the dining total is $320 across 12 purchases. The largest is a $78 dinner; the remaining purchases total $242."
  },
  compare: {
    prompt:
      "Compare my two options for getting to the workshop. I’d rather avoid a rushed morning.",
    intro:
      "I’d lean toward the train. It costs $18 more, but gives you an extra 35 minutes of margin and time to read on the way.",
    title: "A calmer start for $18 more",
    eyebrow: "Workshop travel · Two saved options",
    source: "Your saved options",
    suggestion: "What’s the trade-off with driving?",
    answer:
      "Driving is cheaper and more flexible on the way home. The train gives you more arrival margin, but you’d need to leave the workshop by 5:10 to catch the return."
  }
} satisfies Record<Scenario, Record<string, string>>;

function Metrics({ scenario }: { scenario: Scenario }) {
  const values =
    scenario === "plan"
      ? [
          ["2", "meetings"],
          ["90 min", "clear stretch"],
          ["3", "open tasks"]
        ]
      : scenario === "money"
        ? [
            ["$1,284", "spent so far"],
            ["$366", "left in plan"],
            ["6 days", "left this month"]
          ]
        : [
            ["$18", "extra by train"],
            ["35 min", "more margin"],
            ["1 change", "on the train"]
          ];
  return (
    <dl className="visual-metrics">
      {values.map(([value, label]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Timeline({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "visual-agenda compact" : "visual-agenda"}>
      <AgendaRow time="9:00" title="A gentle start" location="30 min · Inbox and planning" />
      <div className="visual-gap">
        <div className="visual-gap-time">
          10:00
          <br />
          <span>11:30</span>
        </div>
        <div>
          <Eyebrow tone="accent">A good opening</Eyebrow>
          <strong>90 minutes for focused work</strong>
          <p>No meetings. Enough room for the proposal outline.</p>
        </div>
        <Badge tone="forest">Free</Badge>
      </div>
      <AgendaRow
        time="12:00"
        title="Lunch, away from the desk"
        location="45 min · Keep a little breathing room"
      />
      <AgendaRow time="1:30" title="Project check-in" location="30 min · Video call" />
      <AgendaRow time="3:00" title="Design workshop" location="60 min · Studio" />
    </div>
  );
}

const spending = [
  { label: "Groceries", spent: 620, planned: 800 },
  { label: "Dining out", spent: 320, planned: 280 },
  { label: "Getting around", spent: 194, planned: 300 },
  { label: "Other everyday", spent: 150, planned: 270 }
];
function SpendChart() {
  return (
    <div className="visual-bars" aria-label="Spending by category compared with planned amounts">
      {spending.map((row) => (
        <div className="visual-bar-row" key={row.label}>
          <div className="visual-bar-label">
            <span>{row.label}</span>
            <strong>
              ${row.spent} <small>/ ${row.planned}</small>
            </strong>
          </div>
          <div
            className="visual-track"
            role="img"
            aria-label={`${row.label}: $${row.spent} spent of $${row.planned} planned`}
          >
            <span
              style={{
                width: `${Math.min((row.spent / row.planned) * 100, 100)}%`,
                background: row.spent > row.planned ? "var(--warn)" : "var(--accent)"
              }}
            />
          </div>
          {row.spent > row.planned && <p className="visual-bar-note">$40 above plan</p>}
        </div>
      ))}
    </div>
  );
}

function Comparison({ cards = false }: { cards?: boolean }) {
  if (cards)
    return (
      <div className="visual-options">
        <Card padding="sm">
          <Eyebrow tone="accent">More breathing room</Eyebrow>
          <h3>Take the train</h3>
          <div className="visual-price">
            $46 <span>return</span>
          </div>
          <p>
            Leave at 8:10
            <br />
            Arrive at 9:05
          </p>
          <Badge tone="forest">55 min of margin</Badge>
          <p className="visual-muted">One change. Time to read.</p>
        </Card>
        <Card padding="sm">
          <Eyebrow tone="muted">Lower cost</Eyebrow>
          <h3>Drive</h3>
          <div className="visual-price">
            $28 <span>estimated</span>
          </div>
          <p>
            Leave at 8:40
            <br />
            Arrive at 9:40
          </p>
          <Badge tone="neutral">20 min of margin</Badge>
          <p className="visual-muted">Includes fuel and parking.</p>
        </Card>
      </div>
    );
  return (
    <div className="visual-table-wrap">
      <table className="visual-table">
        <caption>Workshop starts at 10:00 · Example estimates</caption>
        <thead>
          <tr>
            <th scope="col">At a glance</th>
            <th scope="col">
              Train <span>My pick</span>
            </th>
            <th scope="col">Drive</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Return cost", "$46", "$28"],
            ["Leave home", "8:10", "8:40"],
            ["Arrive", "9:05", "9:40"],
            ["Arrival margin", "55 min", "20 min"],
            ["On the way", "Read or relax", "At the wheel"]
          ].map((row) => (
            <tr key={row[0]}>
              <th scope="row">{row[0]}</th>
              <td>{row[1]}</td>
              <td>{row[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ scenario }: { scenario: Scenario }) {
  return scenario === "plan" ? (
    <Timeline />
  ) : scenario === "money" ? (
    <SpendChart />
  ) : (
    <Comparison />
  );
}

function VariantA({ scenario }: { scenario: Scenario }) {
  return (
    <section className="visual-reply visual-inline" aria-label="Inline visual summary">
      <Eyebrow tone="muted">{examples[scenario].eyebrow}</Eyebrow>
      <h2>{examples[scenario].title}</h2>
      <Detail scenario={scenario} />
    </section>
  );
}

function VariantB({ scenario }: { scenario: Scenario }) {
  return (
    <section className="visual-reply visual-contained" aria-label="Contained visual card">
      <Card padding="sm">
        <div className="visual-card-head">
          <Eyebrow tone="accent">{examples[scenario].eyebrow}</Eyebrow>
          <Badge tone="neutral">Snapshot</Badge>
        </div>
        <h2>{examples[scenario].title}</h2>
        <Metrics scenario={scenario} />
        {scenario === "compare" ? <Comparison cards /> : <Detail scenario={scenario} />}
        <Note variant="plan">
          {scenario === "plan"
            ? "An opening, not a booking. Your calendar is unchanged."
            : scenario === "money"
              ? "A snapshot of recorded spending. No money has been moved."
              : "Based on your saved options. Nothing has been booked."}
        </Note>
      </Card>
    </section>
  );
}

function VariantC({ scenario }: { scenario: Scenario }) {
  return (
    <section className="visual-reply visual-dashboard" aria-label="Compact dashboard">
      <div className="visual-summary">
        <Eyebrow tone="accent">{examples[scenario].eyebrow}</Eyebrow>
        <div className="visual-hero-value">
          {scenario === "plan" ? "10–11:30" : scenario === "money" ? "$366" : "Take the train"}
        </div>
        <p>
          {scenario === "plan"
            ? "Your clearest stretch tomorrow"
            : scenario === "money"
              ? "Still available in your everyday plan"
              : "More room for an unhurried arrival"}
        </p>
      </div>
      <div className="visual-dashboard-grid">
        <div>
          <SectionHead
            title={
              scenario === "plan"
                ? "The rest of the day"
                : scenario === "money"
                  ? "Where it went"
                  : "The two options"
            }
          />
          <Detail scenario={scenario} />
        </div>
        <aside className="visual-insight">
          <Eyebrow tone="accent">One thing to keep in mind</Eyebrow>
          <p>
            {scenario === "plan"
              ? "Your afternoon is more fragmented. Save the small admin jobs for the gaps between calls."
              : scenario === "money"
                ? "Dining out is the only category above plan. You have room elsewhere if you want to adjust it."
                : "The train’s return time is fixed. Driving buys you flexibility after the workshop."}
          </p>
          <div className="visual-mini-facts">
            <Metrics scenario={scenario} />
          </div>
        </aside>
      </div>
    </section>
  );
}

function Reply({ scenario, variant }: { scenario: Scenario; variant: Variant }) {
  const Component = { A: VariantA, B: VariantB, C: VariantC }[variant];
  return (
    <>
      <div className="mockup-day-label">Today · 9:41 am</div>
      <div className="chatd-msg chatd-msg--me">
        <div className="chatd-bubble">{examples[scenario].prompt}</div>
      </div>
      <div className="mockup-activity">
        <Check size={13} aria-hidden="true" />
        {scenario === "plan"
          ? "Checked your calendar and tasks"
          : scenario === "money"
            ? "Read your October spending"
            : "Compared your saved options"}
      </div>
      <div className="chatd-msg">
        <span className="chatd-msg__av">
          <BrandMark size={16} />
        </span>
        <div className="chatd-bubble">
          <p className="mockup-lede">{examples[scenario].intro}</p>
          <Component scenario={scenario} />
          <div className="mockup-sources">
            <Button variant="chip" size="sm" data-action="sources">
              {examples[scenario].source}
              <ArrowUpRight size={12} />
            </Button>
            <span>Example data</span>
          </div>
          <div className="mockup-source-detail" hidden>
            These are invented examples for design review. A shipped response would link to the
            records supporting its facts.
          </div>
          <div className="mockup-reply-tools">
            <IconButton aria-label="Copy example answer" data-action="copy">
              <Copy size={14} />
            </IconButton>
            <span>Just now</span>
          </div>
        </div>
      </div>
      <div className="mockup-followups">
        <Button variant="chip" size="sm" data-action="followup">
          {examples[scenario].suggestion}
          <ArrowUpRight size={12} />
        </Button>
      </div>
    </>
  );
}

function Shell() {
  return (
    <>
      <header className="review-head">
        <div>
          <Eyebrow tone="accent">Moss · Design study 01</Eyebrow>
          <strong>Visual replies, in conversation</strong>
        </div>
        <div className="review-controls">
          <label>
            Example
            <select id="scenario">
              <option value="plan">Day plan</option>
              <option value="money">Spending</option>
              <option value="compare">Compare options</option>
            </select>
          </label>
          <label>
            Chat width
            <select id="view">
              <option value="expanded">Expanded</option>
              <option value="drawer">Drawer · 404px</option>
              <option value="phone">Phone · 390px</option>
            </select>
          </label>
          <label>
            Theme
            <select id="theme">
              <option value="light">Forest / light</option>
              <option value="dark">Forest / dark</option>
              <option value="sage">Sage / light</option>
            </select>
          </label>
        </div>
      </header>
      <div className="mockup-stage" data-view="expanded">
        <div className="mockup-app">
          <nav className="mockup-nav" aria-label="Application context">
            <div className="mockup-wordmark">
              <BrandMark size={27} />
              <strong>Moss</strong>
            </div>
            <div className="mockup-nav-label">YOUR DAY</div>
            {[
              [House, "Today"],
              [MessageCircle, "Main chat"],
              [Calendar, "Calendar"],
              [ListTodo, "Tasks"],
              [Landmark, "Finance"]
            ].map(([Icon, name]) => {
              const Mark = Icon as typeof House;
              return (
                <div
                  className={name === "Main chat" ? "mockup-nav-item active" : "mockup-nav-item"}
                  key={String(name)}
                >
                  <Mark size={17} />
                  <span>{String(name)}</span>
                </div>
              );
            })}
            <div className="mockup-nav-bottom">
              <Settings size={17} />
              <span>Settings</span>
            </div>
            <div className="mockup-account">
              <span>JD</span>
              <div>
                Jamie Davis<small>Personal workspace</small>
              </div>
            </div>
          </nav>
          <div className="mockup-workspace">
            <div className="mockup-topbar">
              <span id="page-title">Main chat</span>
              <span className="mockup-context-label">Illustrative workspace</span>
              <Search size={17} />
            </div>
            <main className="mockup-context">
              <Eyebrow tone="accent">MONDAY, OCTOBER 26</Eyebrow>
              <h1>
                A little room
                <br />
                to get into it.
              </h1>
              <p>Your morning is open. Keep the big work there.</p>
              <SectionHead number="01" title="Your day, laid out" />
              <Timeline compact />
              <SectionHead number="02" title="A few things on your mind" />
              <RowIndex density="compact">
                <RowIndexItem title="Draft the proposal outline" meta="90 min" />
                <RowIndexItem title="Send the workshop notes" meta="15 min" />
                <RowIndexItem title="Choose a travel option" meta="10 min" />
              </RowIndex>
            </main>
            <section
              className="chatd chatd--docked chatd--expanded mockup-chat"
              aria-label="Moss chat preview"
            >
              <div className="chatd__head">
                <span className="chatd__mark">
                  <BrandMark size={21} />
                </span>
                <div className="chatd__id">
                  <div className="chatd__name">Moss</div>
                  <div className="chatd__status">Main conversation</div>
                </div>
                <IconButton aria-label="New example conversation" data-action="reset">
                  <SquarePen size={17} />
                </IconButton>
                <IconButton aria-label="Toggle expanded chat" data-action="expand">
                  <Maximize2 size={17} />
                </IconButton>
                <IconButton aria-label="About this mockup" data-action="about">
                  <MoreHorizontal size={18} />
                </IconButton>
              </div>
              <div className="chatd__body" id="conversation" />
              <form className="mockup-composer" id="composer">
                <div className="mockup-compose-input">
                  <textarea
                    aria-label="Example message"
                    placeholder="Ask Moss anything…"
                    rows={1}
                  />
                  <div className="mockup-compose-bottom">
                    <IconButton aria-label="About example attachments" data-action="about">
                      <Paperclip size={17} />
                    </IconButton>
                    <span>Example conversation</span>
                    <Button size="sm" type="submit" aria-label="Send example message">
                      <ArrowUp size={16} />
                    </Button>
                  </div>
                </div>
                <div className="mockup-composer-note">Design target · No live data or actions</div>
              </form>
            </section>
          </div>
        </div>
      </div>
      <div className="review-dock">
        <IconButton aria-label="Previous reply layout" data-action="prev">
          <ChevronLeft size={18} />
        </IconButton>
        <div className="review-layout">
          <span id="variant-title">A · Inline summary</span>
          <small id="variant-description">A visual passage in the flow of the reply</small>
        </div>
        <IconButton aria-label="Next reply layout" data-action="next">
          <ChevronRight size={18} />
        </IconButton>
        <div className="review-dock-divider" />
        <Button variant="quiet" size="sm" data-action="reveal">
          Replay reveal
        </Button>
        <span className="review-counter" id="variant-counter">
          1 / 3
        </span>
      </div>
      <div className="review-toast" role="status" id="toast" hidden />
    </>
  );
}

function inlineCss(path: string): string {
  const absolute = resolve(root, path);
  return readFileSync(absolute, "utf8").replace(/@import\s+"([^"]+)";/g, (_, child: string) =>
    inlineCss(resolve(dirname(absolute), child))
  );
}
const tokens = read("apps/web/src/styles/tokens.css").replace(
  /url\("\/fonts\/archivo\/([^\"]+)"\)/g,
  (_, name: string) =>
    `url("data:font/woff2;base64,${readFileSync(resolve(root, "apps/web/public/fonts/archivo", name)).toString("base64")}")`
);
const templates = (Object.keys(examples) as Scenario[])
  .flatMap((scenario) =>
    (["A", "B", "C"] as Variant[]).map(
      (variant) =>
        `<template id="reply-${scenario}-${variant}">${renderToStaticMarkup(<Reply scenario={scenario} variant={variant} />)}</template>`
    )
  )
  .join("\n");
const styles = [
  tokens,
  inlineCss("packages/ui/src/styles.css"),
  read("apps/web/src/styles/kit-chat.css"),
  read("apps/web/src/chat/openui-mockup/mockup.css")
]
  .join("\n")
  .replace(/\n\s*/g, " ");
const fontNotice = read("apps/web/public/fonts/archivo/OFL.txt").replace(/[ \t]+$/gm, "");
const html = `<!doctype html><!-- Embedded Archivo font licence:\n${fontNotice}\n--><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moss — visual chat targets</title><style>${styles}</style></head><body>${renderToStaticMarkup(<Shell />)}${templates}<script type="application/json" id="example-data">${JSON.stringify(examples)}</script><script>${read("apps/web/src/chat/openui-mockup/mockup.js")}</script></body></html>`;
writeFileSync(resolve(here, "index.html"), html);
const live = html
  .replace("Moss — visual chat targets", "Moss — live visual chat")
  .replace("</style>", `${read("apps/web/src/chat/openui-mockup/live.css")}</style>`)
  .replace(
    `<script>${read("apps/web/src/chat/openui-mockup/mockup.js")}</script>`,
    `<script>${read("apps/web/src/chat/openui-mockup/live.js")}</script>`
  );
writeFileSync(resolve(here, "live.html"), live);
console.log("Built standalone mockup: apps/web/src/chat/openui-mockup/index.html");
