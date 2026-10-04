import { Check, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import type {
  IntegrationClassifierRisk,
  IntegrationDetail,
  IntegrationToolDescriptor
} from "@moss/shared";
import { Button, Menu, SectionHead, Segmented } from "@moss/ui";

import { isToolOn } from "./integration-group-state";
import { Badge, Group, Note, Row, Switch } from "./settings-ui";

/* The connection's tools, grouped by what the sorting pass says each one does (#2984 R2.5). */

type ToolsDetail = Pick<
  IntegrationDetail,
  | "tools"
  | "groups"
  | "enabledGroups"
  | "enabledTools"
  | "mutedTools"
  | "groupOptIn"
  | "classifierTools"
>;

type GroupKey = IntegrationClassifierRisk | "unsorted";

interface ToolGroup {
  readonly key: GroupKey;
  readonly title: string;
  readonly help: string;
  readonly tools: readonly IntegrationToolDescriptor[];
}

const RISK_GROUPS: readonly { key: IntegrationClassifierRisk; title: string; help: string }[] = [
  { key: "read", title: "Looks things up", help: "Only reads. Never changes anything." },
  { key: "write", title: "Changes things", help: "Adds, edits or switches things in the app." },
  {
    key: "outbound",
    title: "Sends things out",
    help: "Sends a message, a notification or a request outside Moss. Asks you first unless you allow it."
  },
  {
    key: "destructive",
    title: "Sensitive",
    help: "Unlocks, removes or cancels. Always asks you before it runs."
  }
];

const UNSORTED_GROUP = {
  key: "unsorted",
  title: "Not sorted yet",
  help: "Moss has not worked out what these do yet."
} as const;

/** A group shows this many tools until the person asks for the rest. */
export const GROUP_PREVIEW = 6;

export function isToolOnIn(detail: ToolsDetail, tool: IntegrationToolDescriptor): boolean {
  if (!detail.groupOptIn) return !detail.mutedTools.includes(tool.name);
  return isToolOn(detail, tool.name, tool.group || "Other");
}

/** Patch that turns the named tools on or off without touching any other tool. */
export function toolsOnPatch(
  detail: ToolsDetail,
  names: readonly string[],
  on: boolean
): { enabledTools: string[]; mutedTools: string[] } {
  const explicit = new Set(detail.enabledTools);
  const muted = new Set(detail.mutedTools);
  for (const name of names) {
    if (on) {
      // A tool in an app group that is off only comes on when picked by name.
      const group = detail.tools.find((t) => t.name === name)?.group || "Other";
      const groupOn = detail.groups.find((g) => g.name === group)?.enabled ?? false;
      muted.delete(name);
      if (detail.groupOptIn && !groupOn) explicit.add(name);
    } else {
      explicit.delete(name);
      muted.add(name);
    }
  }
  return { enabledTools: [...explicit], mutedTools: [...muted] };
}

function sortOf(detail: ToolsDetail, toolName: string) {
  return detail.classifierTools.find((entry) => entry.toolName === toolName);
}

/** Tools that are on and still show an approval card before they run. */
export function alwaysAskCount(detail: ToolsDetail): number {
  return detail.tools.filter(
    (tool) => isToolOnIn(detail, tool) && sortOf(detail, tool.name)?.asksFirst === true
  ).length;
}

/**
 * Sorted tools fall into the four risk groups in a fixed order; tools the sorting pass has not
 * placed yet trail in their own group. `null` means nothing is sorted, so the page lists A to Z.
 */
export function groupToolsByRisk(detail: ToolsDetail): readonly ToolGroup[] | null {
  const riskOf = (tool: IntegrationToolDescriptor) => {
    const entry = sortOf(detail, tool.name);
    return entry?.status === "current" ? entry.risk : null;
  };
  if (detail.tools.every((tool) => riskOf(tool) === null)) return null;
  const groups: ToolGroup[] = RISK_GROUPS.map((group) => ({
    ...group,
    tools: detail.tools.filter((tool) => riskOf(tool) === group.key)
  }));
  groups.push({ ...UNSORTED_GROUP, tools: detail.tools.filter((tool) => riskOf(tool) === null) });
  return groups.filter((group) => group.tools.length > 0);
}

function byName(a: IntegrationToolDescriptor, b: IntegrationToolDescriptor): number {
  return a.name.localeCompare(b.name);
}

type OnFilter = "all" | "on" | "off";
type Order = "risk" | "az";

export function IntegrationToolsSection(props: {
  readonly detail: ToolsDetail;
  readonly onSetOn: (names: readonly string[], on: boolean) => void;
  readonly onSendWithoutAsking: (toolNames: readonly string[], allow: boolean) => void;
}) {
  const { detail } = props;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<OnFilter>("all");
  const [order, setOrder] = useState<Order>("risk");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const total = detail.tools.length;
  const onCount = detail.tools.filter((tool) => isToolOnIn(detail, tool)).length;
  const asking = alwaysAskCount(detail);
  const sortedGroups = groupToolsByRisk(detail);

  const needle = search.trim().toLowerCase();
  const visible = (tool: IntegrationToolDescriptor) => {
    if (filter !== "all" && isToolOnIn(detail, tool) !== (filter === "on")) return false;
    if (!needle) return true;
    return (
      tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
    );
  };

  const groups: readonly ToolGroup[] =
    order === "risk" && sortedGroups
      ? sortedGroups
      : [{ key: "unsorted", title: "", help: "", tools: [...detail.tools].sort(byName) }];

  return (
    <section className="intg-tools" aria-labelledby="intg-tools-title">
      <SectionHead
        number="01"
        title="Tools"
        titleId="intg-tools-title"
        meta={`${onCount} of ${total} on, ${asking} always ask`}
        rule
      />
      <p className="pane__desc">
        {detail.groupOptIn
          ? "This app has a lot of tools, so they start off. Switch on the ones Moss should use."
          : "Every tool starts on. Switch one off and Moss stops using it everywhere."}{" "}
        Tools marked Asks first check with you before they run. YOLO mode skips the asking.
      </p>
      {sortedGroups ? null : (
        <Note>Moss has not sorted these tools by what they do yet, so they show A to Z.</Note>
      )}
      <div className="intg-tools__bar">
        <input
          type="search"
          className="jds-input intg-tools__search"
          aria-label="Search tools"
          placeholder={`Search ${total} tools`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Segmented
          value={filter}
          ariaLabel="Show tools"
          options={[
            { value: "all", label: `All ${total}` },
            { value: "on", label: `On ${onCount}` },
            { value: "off", label: `Off ${total - onCount}` }
          ]}
          onChange={setFilter}
        />
        {sortedGroups ? (
          <Segmented
            value={order}
            ariaLabel="Order tools"
            options={[
              { value: "risk", label: "By what it does" },
              { value: "az", label: "A to Z" }
            ]}
            onChange={setOrder}
          />
        ) : null}
      </div>
      {groups.map((group) => {
        const shown = group.tools.filter(visible);
        if (shown.length === 0) return null;
        const open = expanded.has(group.key) || needle !== "";
        const rows = open ? shown : shown.slice(0, GROUP_PREVIEW);
        const list = (
          <>
            {rows.map((tool) => (
              <ToolRow
                key={tool.name}
                detail={detail}
                tool={tool}
                onSetOn={props.onSetOn}
                onSendWithoutAsking={props.onSendWithoutAsking}
              />
            ))}
            {rows.length < shown.length ? (
              <div className="intg-tools__more">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setExpanded(new Set([...expanded, group.key]))}
                >
                  Show {shown.length - rows.length} more
                </Button>
              </div>
            ) : null}
          </>
        );
        if (!group.title) return <div key={group.key}>{list}</div>;
        return (
          <ToolGroupBlock
            key={group.key}
            detail={detail}
            group={group}
            confirming={group.key === "outbound" && confirming}
            onConfirming={setConfirming}
            onSetOn={props.onSetOn}
            onSendWithoutAsking={props.onSendWithoutAsking}
          >
            {list}
          </ToolGroupBlock>
        );
      })}
    </section>
  );
}

function ToolGroupBlock(props: {
  readonly detail: ToolsDetail;
  readonly group: ToolGroup;
  readonly confirming: boolean;
  readonly onConfirming: (open: boolean) => void;
  readonly onSetOn: (names: readonly string[], on: boolean) => void;
  readonly onSendWithoutAsking: (toolNames: readonly string[], allow: boolean) => void;
  readonly children: ReactNode;
}) {
  const { detail, group } = props;
  const names = group.tools.map((tool) => tool.name);
  const on = group.tools.filter((tool) => isToolOnIn(detail, tool)).length;
  const sending = group.key === "outbound";
  const allowed = sending
    ? names.filter((name) => sortOf(detail, name)?.sendWithoutAsking === true)
    : [];

  return (
    <Group
      title={
        <span className="intg__name">
          {group.title}
          <Badge>{`${on} of ${names.length} on`}</Badge>
        </span>
      }
      desc={group.help}
      action={
        <span className="intg-tools__acts">
          {sending && allowed.length < names.length ? (
            <Button
              variant="link"
              size="sm"
              aria-expanded={props.confirming}
              onClick={() => props.onConfirming(!props.confirming)}
            >
              Send all without asking
            </Button>
          ) : null}
          {sending && allowed.length > 0 ? (
            <Button
              variant="link"
              size="sm"
              onClick={() => props.onSendWithoutAsking(allowed, false)}
            >
              Ask first for all
            </Button>
          ) : null}
          {on === 0 ? (
            <Button variant="link" size="sm" onClick={() => props.onSetOn(names, true)}>
              Turn all on
            </Button>
          ) : (
            <Button variant="link" size="sm" onClick={() => props.onSetOn(names, false)}>
              Turn all off
            </Button>
          )}
        </span>
      }
    >
      {props.confirming ? (
        <div className="intg-tools__confirm" role="group" aria-label="Send all without asking">
          <Note>{`Let chat send with these ${names.length} tools without checking with you?`}</Note>
          <span className="intg__acts">
            <Button
              size="sm"
              onClick={() => {
                props.onConfirming(false);
                props.onSendWithoutAsking(names, true);
              }}
            >
              Allow
            </Button>
            <Button variant="quiet" size="sm" onClick={() => props.onConfirming(false)}>
              Cancel
            </Button>
          </span>
        </div>
      ) : null}
      {props.children}
    </Group>
  );
}

function ToolRow(props: {
  readonly detail: ToolsDetail;
  readonly tool: IntegrationToolDescriptor;
  readonly onSetOn: (names: readonly string[], on: boolean) => void;
  readonly onSendWithoutAsking: (toolNames: readonly string[], allow: boolean) => void;
}) {
  const { detail, tool } = props;
  const sort = sortOf(detail, tool.name);
  const sending = sort?.status === "current" && sort.risk === "outbound";

  return (
    <Row
      name={tool.name}
      desc={tool.description || "No description from the app."}
      control={
        <span className="intg-tools__ctl">
          {sort?.asksFirst ? <Badge tone="amber">Asks first</Badge> : null}
          {sending && sort.sendWithoutAsking ? (
            <Badge>
              <Check size={12} aria-hidden="true" />
              Sends without asking
            </Badge>
          ) : null}
          <Switch
            ariaLabel={`Enable ${tool.name}`}
            checked={isToolOnIn(detail, tool)}
            onChange={(next) => props.onSetOn([tool.name], next)}
          />
          {sending ? (
            <Menu
              triggerIcon={<MoreHorizontal size={16} aria-hidden="true" />}
              triggerLabel={`More for ${tool.name}`}
              items={[
                sort.sendWithoutAsking
                  ? {
                      id: "ask",
                      label: "Ask before sending",
                      description: "Chat checks with you first"
                    }
                  : {
                      id: "allow",
                      label: "Send without asking",
                      description: "Chat sends with this tool without checking with you"
                    }
              ]}
              onSelect={(id) => props.onSendWithoutAsking([tool.name], id === "allow")}
            />
          ) : null}
        </span>
      }
    />
  );
}
