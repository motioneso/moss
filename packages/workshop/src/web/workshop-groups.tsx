import type { ReactNode } from "react";

import { EmptyState } from "@moss/ui";
import type { ModuleBuildSummary, WorkshopLiveModuleSummary } from "@moss/shared";

export interface WorkshopGroupsProps {
  readonly builds: readonly ModuleBuildSummary[];
  readonly modules: readonly WorkshopLiveModuleSummary[];
  readonly actions: WorkshopActions;
}

export interface WorkshopActions {
  readonly onApprove: (buildId: string) => void;
  readonly onCancel: (buildId: string) => void;
  readonly onOpenDraft: (moduleId: string) => void;
  readonly onDiscardDraft: (moduleId: string) => void;
  readonly onAskForChange: (moduleId: string) => void;
  readonly onShip: (moduleId: string) => void;
}

const NEEDS_YOU_STATUSES = new Set<ModuleBuildSummary["status"]>([
  "awaiting_plan_approval",
  "awaiting_change"
]);

const BUILDING_STATUSES = new Set<ModuleBuildSummary["status"]>(["planning", "building"]);

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function NeedsYouCard({
  build,
  actions
}: {
  readonly build: ModuleBuildSummary;
  readonly actions: WorkshopActions;
}) {
  const awaitingPlan = build.status === "awaiting_plan_approval";
  return (
    <div className="jds-rail-row workshop-row">
      <span className="jds-rail jds-rail--gold" />
      <div className="jds-card jds-card--raised">
        <h3 className="jds-card-title jds-card-title--heavy">
          {build.plan?.whatItDoes ?? "New module"}
        </h3>
        <span className="jds-badge jds-badge--amber jds-badge--pill">
          {awaitingPlan ? "Plan ready · needs a look" : "Waiting on you"}
        </span>
        {build.plan?.whenItRuns ? <p className="jds-card__meta">{build.plan.whenItRuns}</p> : null}
        <div className="workshop-actions">
          <button
            type="button"
            className="jds-btn jds-btn--primary jds-btn--sm"
            disabled={!awaitingPlan && !build.moduleId}
            onClick={() =>
              awaitingPlan
                ? actions.onApprove(build.id)
                : build.moduleId
                  ? actions.onOpenDraft(build.moduleId)
                  : undefined
            }
          >
            {awaitingPlan ? "Build it" : build.moduleId ? "Look at the draft" : "Draft unavailable"}
          </button>
          <button
            type="button"
            className="jds-btn jds-btn--quiet jds-btn--sm"
            onClick={() =>
              build.moduleId ? actions.onDiscardDraft(build.moduleId) : actions.onCancel(build.id)
            }
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

function BuildLogList({
  label,
  items
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="workshop-log-group">
      <span className="jds-eyebrow jds-eyebrow--muted">{label}</span>
      <ul className="workshop-log">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function BuildingNowCard({
  build,
  actions
}: {
  readonly build: ModuleBuildSummary;
  readonly actions: WorkshopActions;
}) {
  return (
    <div className="jds-rail-row workshop-row">
      <span className="jds-rail jds-rail--accent" />
      <div className="jds-card">
        <h3 className="jds-card-title jds-card-title--heavy">
          {build.plan?.whatItDoes ?? "New module"}
        </h3>
        <span className="jds-indicator jds-indicator--ready jds-indicator--live">
          <span className="jds-indicator__dot" />
          {build.step ?? "Working"}
        </span>
        <BuildLogList label="What it has written" items={build.writtenFiles} />
        <BuildLogList label="What it has read" items={build.fetchedUrls} />
        <div className="workshop-actions">
          <span className="workshop-spacer" />
          {build.plan ? (
            <span className="jds-card__meta">
              Spent so far {formatCents(build.costCents)} of your{" "}
              {formatCents(build.plan.roughCost.budgetCents)} budget
            </span>
          ) : null}
          <button
            type="button"
            className="jds-btn jds-btn--quiet jds-btn--sm"
            onClick={() => actions.onCancel(build.id)}
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveModuleRow({
  module: mod,
  actions
}: {
  readonly module: WorkshopLiveModuleSummary;
  readonly actions: WorkshopActions;
}) {
  return (
    <div className="jds-rail-row workshop-row">
      <span className="jds-rail jds-rail--line-strong" />
      <div className="jds-card">
        <h3 className="jds-card-title">{mod.name}</h3>
        <span className="jds-badge jds-badge--forest jds-badge--pill">
          {mod.scope === "everyone" ? "Live · everyone" : "Live · you only"}
        </span>
        <div className="workshop-actions">
          <button
            type="button"
            className="jds-btn jds-btn--secondary jds-btn--sm"
            onClick={() => actions.onAskForChange(mod.id)}
          >
            Ask for a change
          </button>
          {mod.scope === "you" ? (
            <button
              type="button"
              className="jds-btn jds-btn--quiet jds-btn--sm"
              onClick={() => actions.onShip(mod.id)}
            >
              Turn on for everyone
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GroupSection({
  label,
  children
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="workshop-group">
      <div className="jds-section-head">
        <span className="jds-eyebrow jds-eyebrow--muted">{label}</span>
        <div className="jds-section-head__rule" />
      </div>
      {children}
    </div>
  );
}

export function WorkshopGroups({ builds, modules, actions }: WorkshopGroupsProps) {
  const needsYou = builds.filter((build) => NEEDS_YOU_STATUSES.has(build.status));
  const buildingNow = builds.filter((build) => BUILDING_STATUSES.has(build.status));

  if (needsYou.length === 0 && buildingNow.length === 0 && modules.length === 0) {
    return (
      <EmptyState
        title="Nothing in the workshop yet"
        description="Ask Moss to build something and it will show up here."
      />
    );
  }

  return (
    <div className="workshop-groups">
      {needsYou.length > 0 ? (
        <GroupSection label="Needs you">
          {needsYou.map((build) => (
            <NeedsYouCard key={build.id} build={build} actions={actions} />
          ))}
        </GroupSection>
      ) : null}
      {buildingNow.length > 0 ? (
        <GroupSection label="Building now">
          {buildingNow.map((build) => (
            <BuildingNowCard key={build.id} build={build} actions={actions} />
          ))}
        </GroupSection>
      ) : null}
      {modules.length > 0 ? (
        <GroupSection label="Live">
          {modules.map((mod) => (
            <LiveModuleRow key={mod.id} module={mod} actions={actions} />
          ))}
        </GroupSection>
      ) : null}
    </div>
  );
}
