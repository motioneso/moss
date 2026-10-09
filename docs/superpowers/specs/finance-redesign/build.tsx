/** Design artifacts only. Renders the finance R1 screens from shipped @moss/ui primitives. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Badge,
  BrandMark,
  Button,
  ButtonLink,
  DisclosureToggle,
  Eyebrow,
  Field,
  FormLabel,
  IconButton,
  Indicator,
  Masthead,
  Note,
  RadioCardGroup,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Segmented,
  Select,
  StatTile,
  Switch
} from "@moss/ui";
import {
  ArrowUp,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Heart,
  House,
  Landmark,
  ListTodo,
  Menu,
  MessageCircle,
  Settings,
  Newspaper,
  SquarePen,
  Trophy,
  TriangleAlert,
  Wrench,
  X
} from "lucide-react";

Object.assign(globalThis, { React });
const out = resolve("docs/superpowers/specs/finance-redesign");
const noop = () => {};

type Width = "desktop" | "phone";
type Tab = "budget" | "transactions" | "accounts";

// ---- Made-up example data ----

const money = (cents: number) => {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type Line = { name: string; assigned: number; spent: number; available: number };
const groups: { name: string; lines: Line[] }[] = [
  {
    name: "Bills",
    lines: [
      { name: "Rent", assigned: 185000, spent: 185000, available: 0 },
      { name: "Electric and gas", assigned: 14000, spent: 9612, available: 4388 },
      { name: "Phone and internet", assigned: 12000, spent: 12000, available: 0 },
      { name: "Car insurance", assigned: 21000, spent: 0, available: 21000 }
    ]
  },
  {
    name: "Everyday",
    lines: [
      { name: "Groceries", assigned: 65000, spent: 41827, available: 23173 },
      { name: "Dining out", assigned: 22000, spent: 24650, available: -2650 },
      { name: "Gas and transit", assigned: 18000, spent: 9240, available: 8760 },
      { name: "Household", assigned: 9000, spent: 3785, available: 5215 }
    ]
  },
  {
    name: "Fun",
    lines: [
      { name: "Streaming", assigned: 3200, spent: 3200, available: 0 },
      { name: "Hobbies", assigned: 8000, spent: 1999, available: 6001 }
    ]
  },
  {
    name: "Savings",
    lines: [
      { name: "Emergency fund", assigned: 30000, spent: 0, available: 214000 },
      { name: "Travel", assigned: 20000, spent: 0, available: 86000 }
    ]
  }
];

type Tx = {
  payee: string;
  category: string;
  account: string;
  amount: number;
  look?: boolean;
  income?: boolean;
};
const days: { label: string; txs: Tx[] }[] = [
  {
    label: "Today, Thursday October 8",
    txs: [
      { payee: "Fernwood Market", category: "Groceries", account: "Harbor Checking", amount: 8412 },
      {
        payee: "Copperline Coffee",
        category: "Dining out",
        account: "Harbor Visa",
        amount: 675,
        look: true
      },
      { payee: "City Transit", category: "Gas and transit", account: "Harbor Visa", amount: 275 }
    ]
  },
  {
    label: "Wednesday October 7",
    txs: [
      {
        payee: "Brightwire Internet",
        category: "Phone and internet",
        account: "Harbor Checking",
        amount: 6500
      },
      {
        payee: "Kestrel Hardware",
        category: "Household",
        account: "Harbor Visa",
        amount: 3785,
        look: true
      },
      {
        payee: "Paycheck, Alder Studio",
        category: "Income",
        account: "Harbor Checking",
        amount: -284000,
        income: true
      }
    ]
  },
  {
    label: "Tuesday October 6",
    txs: [
      {
        payee: "Little Pine Noodle Bar",
        category: "Dining out",
        account: "Harbor Visa",
        amount: 4280
      },
      { payee: "Fernwood Market", category: "Groceries", account: "Harbor Checking", amount: 11905 }
    ]
  }
];

const categoryNames = groups.flatMap((g) => g.lines.map((l) => l.name));

// ---- Shell ----

const navLinks: (string | [ReactNode, string, boolean?])[] = [
  [<House key="h" />, "Today"],
  [<Wrench key="w" />, "The Workshop"],
  "Plan",
  [<ListTodo key="t" />, "Tasks"],
  [<Calendar key="c" />, "Calendar"],
  "Your world",
  [<Newspaper key="n" />, "News"],
  [<Trophy key="s" />, "Sports"],
  [<Heart key="he" />, "Wellness"],
  [<Landmark key="f" />, "Finance", true]
];

function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__brand">
        <BrandMark size={24} />
        Moss
      </div>
      <div className="nav__list">
        {navLinks.map((l) =>
          typeof l === "string" ? (
            <p key={l} className="nav__label">
              {l}
            </p>
          ) : (
            <a key={l[1]} className={`nav__link${l[2] ? " is-active" : ""}`} href="#">
              {l[0]}
              <span>{l[1]}</span>
            </a>
          )
        )}
      </div>
      <div className="nav__foot">Alex</div>
    </nav>
  );
}

function TopbarTitle() {
  return (
    <span className="topbar__title">
      Finance
      <IconButton aria-label="Finance settings" size="sm">
        <Settings aria-hidden="true" size={15} />
      </IconButton>
    </span>
  );
}

function Topbar({ width }: { width: Width }) {
  if (width === "phone") {
    return (
      <header className="topbar topbar--phone">
        <IconButton aria-label="Open menu">
          <Menu aria-hidden="true" />
        </IconButton>
        <TopbarTitle />
        <IconButton aria-label="Open chat">
          <MessageCircle aria-hidden="true" />
        </IconButton>
      </header>
    );
  }
  return (
    <header className="topbar">
      <TopbarTitle />
      <IconButton aria-label="Open chat">
        <MessageCircle aria-hidden="true" />
      </IconButton>
    </header>
  );
}

function Tabs({ width, tab }: { width: Width; tab: Tab }) {
  return (
    <div className={width === "phone" ? "tabs tabs--phone" : "tabs"}>
      <Segmented
        ariaLabel="Finance views"
        value={tab}
        onChange={noop}
        options={[
          { value: "budget", label: "Budget" },
          { value: "transactions", label: "Transactions" },
          { value: "accounts", label: "Accounts" }
        ]}
      />
    </div>
  );
}

function Frame(props: {
  width: Width;
  hero?: ReactNode;
  tab?: Tab;
  main: ReactNode;
  rail?: ReactNode;
  drawer?: ReactNode;
}) {
  const phone = props.width === "phone";
  const pageClass = phone
    ? "page page--phone"
    : props.drawer
      ? "page page--drawer"
      : props.rail
        ? "page"
        : "page page--single";
  const work = (
    <div className={props.drawer && !phone ? "work work--drawer" : "work"}>
      <Topbar width={props.width} />
      {props.hero ? <div className={phone ? "hero hero--phone" : "hero"}>{props.hero}</div> : null}
      {props.tab ? <Tabs width={props.width} tab={props.tab} /> : null}
      <div className={pageClass}>
        <main className="stack">{props.main}</main>
        {props.rail ? <aside className="stack stack--rail">{props.rail}</aside> : null}
      </div>
    </div>
  );
  return (
    <div className={`frame frame--${props.width}`}>
      {phone ? (
        work
      ) : (
        <div className="app">
          <Nav />
          {work}
        </div>
      )}
      {props.drawer && phone ? <div className="scrim" /> : null}
      {props.drawer}
    </div>
  );
}

function RailBlock({
  eyebrow,
  title,
  children
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="stack stack--tight">
      <Eyebrow tone="gold">{eyebrow}</Eyebrow>
      <SectionHead title={title} rule />
      {children}
    </section>
  );
}

// ---- Budget ----

function AvailableCell({ cents, labelled }: { cents: number; labelled?: boolean }) {
  if (cents < 0)
    return <Badge tone="red">{labelled ? `${money(-cents)} over` : money(cents)}</Badge>;
  if (cents === 0)
    return (
      <span className="jds-hint">
        {money(0)}
        {labelled ? " left" : ""}
      </span>
    );
  return (
    <strong>
      {money(cents)}
      {labelled ? " left" : ""}
    </strong>
  );
}

// Groups reorder by drag; the handle shows that they can.
function DragHandle() {
  return <GripVertical className="drag-handle" aria-hidden="true" size={18} />;
}

function Meter({ line }: { line: Line }) {
  const used = line.assigned === 0 ? 0 : Math.min(1, line.spent / line.assigned);
  return (
    <div className={`jds-progress${line.available < 0 ? " jds-progress--amber" : ""}`}>
      <div className="jds-progress__fill" style={{ width: `${Math.round(used * 100)}%` }} />
    </div>
  );
}

function GroupTable({ group }: { group: (typeof groups)[number] }) {
  const assigned = group.lines.reduce((s, l) => s + l.assigned, 0);
  return (
    <section className="stack stack--tight">
      <SectionHead
        marker={<DragHandle />}
        title={group.name}
        meta={`${money(assigned)} assigned`}
        rule
      />
      <table className="jds-table table--fixed">
        <colgroup>
          <col className="col--name" />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Category</th>
            <th className="jds-table__num">Assigned</th>
            <th className="jds-table__num">Spent</th>
            <th className="jds-table__num">Available</th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((l) => (
            <tr key={l.name}>
              <td>{l.name}</td>
              <td className="jds-table__num">{money(l.assigned)}</td>
              <td className="jds-table__num">
                <div className="cell-stack">
                  <span>{money(l.spent)}</span>
                  <div className="cell-meter">
                    <Meter line={l} />
                  </div>
                </div>
              </td>
              <td className="jds-table__num">
                <AvailableCell cents={l.available} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function GroupRows({ group }: { group: (typeof groups)[number] }) {
  return (
    <section className="stack stack--tight">
      <SectionHead marker={<DragHandle />} title={group.name} rule />
      <RowIndex density="compact">
        {group.lines.map((l) => (
          <RowIndexItem
            key={l.name}
            title={l.name}
            excerpt={
              <div className="stack stack--tight">
                <span>
                  {money(l.spent)} spent of {money(l.assigned)}
                </span>
                <Meter line={l} />
              </div>
            }
            meta={<AvailableCell cents={l.available} labelled />}
          />
        ))}
      </RowIndex>
    </section>
  );
}

function BudgetHero({ width }: { width: Width }) {
  return (
    <Masthead
      tone="field"
      eyebrow="October 2026, ready to assign"
      title="$412.00"
      lede="Give every dollar a job, or ask Moss to."
      aside={
        <div className="row">
          <Button variant="field" size="sm">
            <ChevronLeft aria-hidden="true" size={16} />
            September
          </Button>
          <Button variant="field" size="sm">
            November
            <ChevronRight aria-hidden="true" size={16} />
          </Button>
        </div>
      }
    />
  );
}

const balances = [
  { name: "Harbor Checking", cents: 348210 },
  { name: "Northline Savings", cents: 921000 },
  { name: "Harbor Visa", cents: -61244 }
];

function NeedsYou() {
  return (
    <RailBlock eyebrow="Needs you" title="Two things">
      <div className="stat-pair">
        <StatTile label="Needs a look" value="6" onClick={noop} />
        <StatTile label="Overspent" value="1" warn onClick={noop} />
      </div>
    </RailBlock>
  );
}

function Balances() {
  return (
    <RowIndex variant="facts">
      {balances.map((b) => (
        <RowIndexItem key={b.name} title={b.name} meta={money(b.cents)} />
      ))}
    </RowIndex>
  );
}

// Phone shows balances collapsed to their total; tapping opens the list.
function BalancesCollapsed() {
  const total = balances.reduce((sum, b) => sum + b.cents, 0);
  return (
    <section className="stack stack--tight">
      <Eyebrow tone="gold">Accounts</Eyebrow>
      <SectionHead
        title={
          <DisclosureToggle expanded={false} controls="balances" className="disclosure-head">
            Balances
            <ChevronDown aria-hidden="true" size={18} />
          </DisclosureToggle>
        }
        meta={money(total)}
        rule
      />
    </section>
  );
}

function BudgetRail() {
  return (
    <>
      <NeedsYou />
      <RailBlock eyebrow="Accounts" title="Balances">
        <Balances />
      </RailBlock>
      <div>
        <Button variant="secondary">
          <MessageCircle aria-hidden="true" size={16} />
          Ask Moss about your budget
        </Button>
      </div>
    </>
  );
}

function Budget({ width }: { width: Width }) {
  if (width === "phone")
    return (
      <Frame
        width={width}
        hero={<BudgetHero width={width} />}
        tab="budget"
        main={
          <>
            <NeedsYou />
            <BalancesCollapsed />
            {groups.map((g) => (
              <GroupRows key={g.name} group={g} />
            ))}
            <div>
              <Button variant="secondary">
                <MessageCircle aria-hidden="true" size={16} />
                Ask Moss about your budget
              </Button>
            </div>
          </>
        }
      />
    );
  return (
    <Frame
      width={width}
      hero={<BudgetHero width={width} />}
      tab="budget"
      main={groups.map((g) => (
        <GroupTable key={g.name} group={g} />
      ))}
      rail={<BudgetRail />}
    />
  );
}

// ---- Transactions ----

function CategoryPicker({ value }: { value: string }) {
  return (
    <Select aria-label="Category" defaultValue={value}>
      {categoryNames.map((n) => (
        <option key={n}>{n}</option>
      ))}
    </Select>
  );
}

function LookControls({ tx }: { tx: Tx }) {
  return (
    <div className="stack stack--tight">
      <div className="row">
        <CategoryPicker value={tx.category} />
        <Button size="sm">Confirm</Button>
      </div>
      <Switch
        ariaLabel="Always use this category for this merchant"
        label="Always for this merchant"
        checked
      />
    </div>
  );
}

function TxDayTable({ day }: { day: (typeof days)[number] }) {
  return (
    <section className="stack stack--tight">
      <SectionHead title={day.label} rule />
      <table className="jds-table table--fixed">
        <colgroup>
          <col className="col--payee" />
          <col className="col--category" />
          <col />
          <col className="col--amount" />
        </colgroup>
        <thead>
          <tr>
            <th>Payee</th>
            <th>Category</th>
            <th>Account</th>
            <th className="jds-table__num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {day.txs.map((t) => (
            <tr key={t.payee + t.amount}>
              <td>
                <div className="stack stack--tight">
                  <span>{t.payee}</span>
                  {t.look ? (
                    <div>
                      <Badge tone="amber">Predicted</Badge>
                    </div>
                  ) : null}
                </div>
              </td>
              <td>{t.look ? <LookControls tx={t} /> : t.category}</td>
              <td className="jds-hint">{t.account}</td>
              <td className="jds-table__num">
                {t.income ? <strong>+{money(-t.amount)}</strong> : money(t.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TxDayRows({ day }: { day: (typeof days)[number] }) {
  return (
    <section className="stack stack--tight">
      <SectionHead title={day.label} rule />
      <RowIndex density="compact">
        {day.txs.map((t) => (
          <RowIndexItem
            key={t.payee + t.amount}
            title={t.payee}
            excerpt={
              t.look ? (
                <div className="stack stack--tight">
                  <div>
                    <Badge tone="amber">Predicted</Badge>
                  </div>
                  <LookControls tx={t} />
                </div>
              ) : (
                `${t.category} · ${t.account}`
              )
            }
            meta={t.income ? <strong>+{money(-t.amount)}</strong> : money(t.amount)}
          />
        ))}
      </RowIndex>
    </section>
  );
}

function Transactions({ width }: { width: Width }) {
  const phone = width === "phone";
  return (
    <Frame
      width={width}
      hero={<Masthead compact eyebrow="October 2026" title="Transactions" />}
      tab="transactions"
      main={
        <>
          <div className="row row--spread">
            <Segmented
              ariaLabel="Filter transactions"
              value="all"
              onChange={noop}
              options={[
                { value: "all", label: "All" },
                { value: "look", label: "Needs a look (6)" }
              ]}
            />
            <input
              className="jds-input search"
              placeholder="Search payees"
              aria-label="Search payees"
            />
          </div>
          {days.map((d) =>
            phone ? <TxDayRows key={d.label} day={d} /> : <TxDayTable key={d.label} day={d} />
          )}
        </>
      }
    />
  );
}

// ---- Accounts ----

function Accounts({ width }: { width: Width }) {
  return (
    <Frame
      width={width}
      hero={
        <Masthead
          tone="field"
          eyebrow="Net worth"
          title="$12,079.66"
          lede="Up $384.20 since September."
        />
      }
      tab="accounts"
      main={
        <>
          <Note variant="plan">
            <TriangleAlert aria-hidden="true" size={18} />
            <span>
              Northline Bank needs you to sign in again. Balances up to date as of October 5.
            </span>
          </Note>
          <section className="stack stack--tight">
            <SectionHead title="Banks" rule />
            <RowIndex>
              <RowIndexItem
                title="Harbor Credit Union"
                excerpt="Checking ending 4821 · $3,482.10. Visa ending 1190 owes $612.44."
                meta={<Indicator status="ready" label="Synced 2 hours ago" />}
              />
              <RowIndexItem
                title="Northline Bank"
                excerpt="Savings ending 7302 · $9,210.00."
                meta={
                  <div className="stack stack--tight">
                    <Indicator status="error" label="Sign-in expired" />
                    <Button size="sm">Reconnect</Button>
                  </div>
                }
              />
            </RowIndex>
            <div>
              <Button variant="secondary">Add a bank</Button>
            </div>
          </section>
          <section className="stack stack--tight">
            <SectionHead title="Net worth by month" rule />
            <table className="jds-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="jds-table__num">Have</th>
                  <th className="jds-table__num">Owe</th>
                  <th className="jds-table__num">Net worth</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["October", 1269210, 61244, 1207966],
                  ["September", 1243086, 73540, 1169546],
                  ["August", 1218470, 58212, 1160258],
                  ["July", 1190015, 66090, 1123925]
                ].map(([m, have, owe, net]) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td className="jds-table__num">{money(have as number)}</td>
                    <td className="jds-table__num">{money(owe as number)}</td>
                    <td className="jds-table__num">
                      <strong>{money(net as number)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      }
    />
  );
}

// ---- Getting started: no bank ----

function StartConnect({ width }: { width: Width }) {
  return (
    <Frame
      width={width}
      hero={
        <Masthead
          tone="field"
          eyebrow="Finance"
          title="Run your money with Moss"
          lede="Connect a bank and Moss builds your first budget from the last three months."
        />
      }
      main={
        <section className="stack stack--tight">
          <SectionHead title="Three steps" rule />
          <RowIndex density="compact">
            <RowIndexItem
              title="1. Connect a bank"
              excerpt="Sign in through Plaid. It takes about a minute per bank."
              meta={<Button>Connect a bank</Button>}
            />
            <RowIndexItem
              title="2. Moss sorts your spending"
              excerpt="Every purchase lands in a category. You check anything from a new merchant."
            />
            <RowIndexItem
              title="3. Build your budget together"
              excerpt="Moss proposes an amount for each category from your history. You adjust them in one chat."
            />
          </RowIndex>
        </section>
      }
    />
  );
}

// ---- Getting started: first-budget draft with chat ----

type DraftLine = {
  name: string;
  avg: number;
  proposed: number;
  changed?: "you" | "moss";
  was?: number;
  dropped?: boolean;
};
const draft: { name: string; lines: DraftLine[] }[] = [
  {
    name: "Bills",
    lines: [
      { name: "Rent", avg: 185000, proposed: 185000 },
      { name: "Electric and gas", avg: 13140, proposed: 13500 },
      { name: "Phone and internet", avg: 12000, proposed: 12000 },
      { name: "Car insurance", avg: 21000, proposed: 21000 },
      { name: "Gym", avg: 4500, proposed: 0, changed: "moss", was: 4500, dropped: true }
    ]
  },
  {
    name: "Everyday",
    lines: [
      { name: "Groceries", avg: 61220, proposed: 65000, changed: "moss", was: 61500 },
      { name: "Dining out", avg: 21877, proposed: 22000 },
      { name: "Gas and transit", avg: 17410, proposed: 17500 },
      { name: "Household", avg: 8640, proposed: 9000 }
    ]
  },
  {
    name: "Fun",
    lines: [
      { name: "Streaming", avg: 3200, proposed: 3200 },
      { name: "Hobbies", avg: 7215, proposed: 7500 }
    ]
  }
];

function DraftTable({ group }: { group: (typeof draft)[number] }) {
  return (
    <section className="stack stack--tight">
      <SectionHead title={group.name} rule />
      <table className="jds-table table--fixed">
        <colgroup>
          <col className="col--name" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Category</th>
            <th className="jds-table__num">Monthly average</th>
            <th className="jds-table__num">Plan</th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((l) => (
            <tr key={l.name}>
              <td>
                <div className="stack stack--tight">
                  <span>{l.name}</span>
                  {l.changed ? (
                    <div>
                      <Badge tone="forest">
                        {l.dropped
                          ? "Dropped in chat"
                          : `Changed in chat, was ${money(l.was ?? 0)}`}
                      </Badge>
                    </div>
                  ) : null}
                </div>
              </td>
              <td className="jds-table__num jds-hint">{money(l.avg)}</td>
              <td className="jds-table__num">
                {l.dropped ? (
                  <span className="jds-hint">Not in budget</span>
                ) : (
                  <strong>{money(l.proposed)}</strong>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DraftRows({ group }: { group: (typeof draft)[number] }) {
  return (
    <section className="stack stack--tight">
      <SectionHead title={group.name} rule />
      <RowIndex density="compact">
        {group.lines.map((l) => (
          <RowIndexItem
            key={l.name}
            title={l.name}
            excerpt={
              l.changed
                ? l.dropped
                  ? "Dropped in chat"
                  : `Average ${money(l.avg)}. Changed in chat, was ${money(l.was ?? 0)}`
                : `Average ${money(l.avg)}`
            }
            meta={l.dropped ? "Not in budget" : <strong>Plan {money(l.proposed)}</strong>}
          />
        ))}
      </RowIndex>
    </section>
  );
}

function ChatDrawer() {
  return (
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
          <SquarePen aria-hidden="true" />
        </IconButton>
        <IconButton aria-label="Close chat">
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <div className="chatd__body-wrap">
        <div className="chatd__body">
          <div className="chatd-msg chatd-msg--me">
            <div className="chatd-bubble">Help me set up my first budget.</div>
          </div>
          <div className="chatd-msg">
            <span className="chatd-msg__av">
              <BrandMark size={14} />
            </span>
            <div className="chatd-bubble">
              Your draft plans $5,840 a month against $5,850 of income. Groceries averaged $612, so
              I put in $615. What would you like to change?
            </div>
          </div>
          <div className="chatd-msg chatd-msg--me">
            <div className="chatd-bubble">Make groceries 650 and drop the gym, I cancelled it.</div>
          </div>
          <div className="chatd-msg">
            <span className="chatd-msg__av">
              <BrandMark size={14} />
            </span>
            <div className="chatd-bubble">
              Done. Groceries is $650, up from $615. Gym is out of the budget, which frees $45. You
              have $10 left to plan. Press Start this budget when it looks right.
            </div>
          </div>
        </div>
      </div>
      <div className="chatd__composer">
        <div className="chatd-input">
          <textarea aria-label="Message Moss" placeholder="Message Moss" rows={1} />
          <IconButton aria-label="Send">
            <ArrowUp aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

function StartDraft({ width, chat }: { width: Width; chat?: boolean }) {
  const phone = width === "phone";
  return (
    <Frame
      width={width}
      hero={
        <Masthead
          tone="field"
          eyebrow="Your first budget"
          title="$5,840 a month"
          lede="Planned from July to September. $10 of your $5,850 monthly income is still unplanned."
          aside={
            <div className="row">
              <Button variant="field">Start this budget</Button>
            </div>
          }
        />
      }
      main={
        <>
          <div className="row">
            <Button variant="secondary">
              <MessageCircle aria-hidden="true" size={16} />
              Build my budget with Moss
            </Button>
          </div>
          {draft.map((g) =>
            phone ? <DraftRows key={g.name} group={g} /> : <DraftTable key={g.name} group={g} />
          )}
        </>
      }
      drawer={chat ? <ChatDrawer /> : undefined}
    />
  );
}

// ---- Finance settings ----

const families: { label: string; on: boolean }[] = [
  { label: "Sort purchases from merchants you've seen", on: true },
  { label: "Move money between categories", on: true },
  { label: "Sort purchases from new merchants", on: false },
  { label: "Make merchant rules", on: false },
  { label: "Add, rename or archive categories", on: false }
];

function FinanceSettings({ width }: { width: Width }) {
  return (
    <Frame
      width={width}
      hero={<Masthead compact={width === "phone"} eyebrow="Finance" title="Settings" />}
      main={
        <>
          <section className="stack stack--tight">
            <SectionHead title="How much Moss does alone" rule />
            <RadioCardGroup
              name="moss-step"
              ariaLabel="How much Moss does on its own"
              value="routine"
              onChange={noop}
              options={[
                {
                  value: "ask",
                  label: "Ask about everything",
                  description: "Moss suggests. Nothing changes until you say yes."
                },
                {
                  value: "routine",
                  label: "Handle routine, ask about new",
                  description:
                    "Moss sorts merchants it knows and moves money up to your limit. It asks about anything new."
                },
                {
                  value: "all",
                  label: "Run it all, review weekly",
                  description: "Moss handles everything up to your limit. You look over its week."
                }
              ]}
            />
          </section>
          <section className="stack stack--tight">
            <SectionHead title="Dollar limit" rule />
            <Field>
              <FormLabel htmlFor="limit">Moss can move up to</FormLabel>
              <input id="limit" className="jds-input limit" defaultValue="$100" />
            </Field>
          </section>
          <section className="stack stack--tight">
            <SectionHead title="Customize" rule />
            <div>
              {families.map((f) => (
                <div key={f.label} className="switch-row">
                  <span>{f.label}</span>
                  <Switch ariaLabel={f.label} checked={f.on} />
                </div>
              ))}
              {["Connect a bank", "Share an account"].map((label) => (
                <div key={label} className="switch-row">
                  <span>{label}</span>
                  <Badge tone="neutral">Always asks</Badge>
                </div>
              ))}
            </div>
          </section>
          <section className="stack stack--tight">
            <SectionHead title="Bank connection" meta="Admins only" rule />
            <div>
              {["Plaid client ID", "Plaid secret"].map((label) => (
                <div key={label} className="switch-row">
                  <span>{label}</span>
                  <div className="row">
                    <Indicator status="ready" label="Saved" />
                    <Button variant="secondary" size="sm">
                      Replace
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      }
      rail={
        <RailBlock eyebrow="Activity" title="This week">
          <div>
            {activity.map((a) => (
              <div key={a.when} className="switch-row">
                <div className="switch-row__text">
                  <span>{a.what}</span>
                  <span className="jds-hint">
                    {a.who} · {a.when}
                    {a.via ? ` · ${a.via}` : ""}
                  </span>
                </div>
                <Button variant="quiet" size="sm">
                  Undo
                </Button>
              </div>
            ))}
          </div>
          <div>
            <Button variant="link">Earlier weeks</Button>
          </div>
        </RailBlock>
      }
    />
  );
}

// ---- Activity, listed in the settings rail ----

const activity: { when: string; who: "Moss" | "You"; what: string; via?: string; undo: boolean }[] =
  [
    {
      when: "Today 9:14 AM",
      who: "Moss",
      what: "Sorted Fernwood Market, $84.12, into Groceries",
      undo: true
    },
    {
      when: "Today 8:02 AM",
      who: "Moss",
      what: "Moved $40.00 from Hobbies to Dining out",
      via: "You asked in chat",
      undo: true
    },
    {
      when: "Yesterday 6:45 PM",
      who: "You",
      what: "Made a rule: Kestrel Hardware goes to Household",
      undo: true
    },
    {
      when: "Yesterday 6:44 PM",
      who: "You",
      what: "Confirmed Kestrel Hardware, $37.85, as Household",
      undo: true
    },
    {
      when: "Tuesday 7:30 PM",
      who: "Moss",
      what: "Sorted Little Pine Noodle Bar, $42.80, into Dining out",
      undo: true
    },
    {
      when: "Monday 10:05 AM",
      who: "Moss",
      what: "Asked before moving $250.00 to Travel. You approved",
      via: "Over your $100 limit",
      undo: true
    }
  ];

// ---- Pages ----

type Screen = {
  id: string;
  title: string;
  what: string;
  render: (w: Width) => ReactNode;
  phoneChat?: () => ReactNode;
};

const screens: Screen[] = [
  {
    id: "01-budget",
    title: "Budget",
    what: "This month's budget, with what needs you first.",
    render: (w) => <Budget width={w} />
  },
  {
    id: "02-transactions",
    title: "Transactions",
    what: "By day, with Moss's guesses waiting for a look.",
    render: (w) => <Transactions width={w} />
  },
  {
    id: "03-accounts",
    title: "Accounts",
    what: "Banks, sync status, reconnect and net worth.",
    render: (w) => <Accounts width={w} />
  },
  {
    id: "04-start",
    title: "Getting started",
    what: "No bank yet.",
    render: (w) => <StartConnect width={w} />
  },
  {
    id: "05-first-budget",
    title: "First budget",
    what: "The draft from three months of history, adjusted in chat.",
    render: (w) => <StartDraft width={w} chat={w === "desktop"} />,
    phoneChat: () => <StartDraft width="phone" chat />
  },
  {
    id: "06-settings",
    title: "Finance settings",
    what: "How much Moss does alone, the Plaid keys, and this week's activity with undo.",
    render: (w) => <FinanceSettings width={w} />
  }
];

function document(title: string, body: string, phone = false) {
  const ui = phone ? "moss-ui.phone.css" : "moss-ui.css";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Finance mockup</title><link rel="stylesheet" href="${ui}"><link rel="stylesheet" href="frame.css"></head><body>${body}</body></html>\n`;
}

// The phone frame is 390px wide whatever the window is, so its stylesheet applies every
// max-width rule wider than that and drops the desktop-only min-width rules.
function phoneCss(css: string) {
  let result = "";
  let at = 0;
  const query = /@media \((max|min)-width: (\d+)px\) \{/g;
  for (let m = query.exec(css); m; m = query.exec(css)) {
    let depth = 1;
    let end = m.index + m[0].length;
    while (depth > 0) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    }
    const inner = css.slice(m.index + m[0].length, end - 1);
    const width = Number(m[2]);
    const applies = m[1] === "max" ? width >= 390 : width <= 390;
    result += css.slice(at, m.index) + (applies ? inner : "");
    at = end;
    query.lastIndex = end;
  }
  return result + css.slice(at);
}
writeFileSync(
  resolve(out, "moss-ui.phone.css"),
  phoneCss(readFileSync(resolve(out, "moss-ui.css"), "utf8"))
);

for (const s of screens) {
  for (const w of ["desktop", "phone"] as const) {
    writeFileSync(
      resolve(out, `${s.id}-${w}.html`),
      document(`${s.title} (${w})`, renderToStaticMarkup(<>{s.render(w)}</>), w === "phone")
    );
  }
  if (s.phoneChat) {
    writeFileSync(
      resolve(out, `${s.id}-phone-chat.html`),
      document(`${s.title} (phone, chat open)`, renderToStaticMarkup(<>{s.phoneChat()}</>), true)
    );
  }
}

const index = (
  <div className="index stack">
    <Masthead
      eyebrow="Mockups for issue 3162"
      title="Finance R1"
      lede="Every R1 screen at desktop (1440) and phone (390) width. All names and amounts are made up."
    />
    <RowIndex>
      {screens.map((s) => (
        <RowIndexItem
          key={s.id}
          title={s.title}
          excerpt={s.what}
          meta={
            <div className="row">
              <ButtonLink variant="secondary" size="sm" href={`${s.id}-desktop.html`}>
                Desktop
              </ButtonLink>
              <ButtonLink variant="secondary" size="sm" href={`${s.id}-phone.html`}>
                Phone
              </ButtonLink>
              {s.phoneChat ? (
                <ButtonLink variant="secondary" size="sm" href={`${s.id}-phone-chat.html`}>
                  Phone, chat open
                </ButtonLink>
              ) : null}
            </div>
          }
        />
      ))}
    </RowIndex>
  </div>
);
writeFileSync(resolve(out, "index.html"), document("Index", renderToStaticMarkup(index)));
console.log(`Built ${screens.length * 2 + screens.filter((s) => s.phoneChat).length} screens.`);
