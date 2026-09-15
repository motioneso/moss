import { Component, Fragment, lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { MODULE_WEB_CONTRIBUTIONS } from "virtual:moss-module-web";

import type { ModuleTodayWidget, ModuleWebContribution } from "@moss/module-web-sdk";

type ContributionEntry = (typeof MODULE_WEB_CONTRIBUTIONS)[number];

function widgetsForSlot(
  contribution: ModuleWebContribution,
  slot: string | undefined
): readonly ModuleTodayWidget[] {
  const widgets = contribution.todayWidgets ?? [];
  if (slot === undefined) return widgets;
  return widgets.filter((widget) => widget.slot === slot);
}

function makeSlotComponent(entry: ContributionEntry, slot: string | undefined) {
  return lazy(async () => {
    const contribution = (await entry.load()).default;
    const widgets = widgetsForSlot(contribution, slot);
    return {
      default: () => (
        <>
          {widgets.map((widget, index) => (
            <Fragment key={`${widget.slot}-${index}`}>{widget.element}</Fragment>
          ))}
        </>
      )
    };
  });
}

interface BoundaryProps {
  readonly onRetry: () => void;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
}

/** Per-module fallback: a failed widget shows a retry line, never a page error. */
class ModuleWidgetBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  private handleRetry = () => {
    this.props.onRetry();
  };
  render() {
    if (this.state.failed) {
      return (
        <div className="cmd-empty" role="status">
          Couldn&apos;t load this widget right now.{" "}
          <button type="button" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ModuleEntryWidgets(props: { entry: ContributionEntry; slot: string | undefined }) {
  const [attempt, setAttempt] = useState(0);
  // Recreated on retry so a failed load() runs again; the module loader caches a
  // successful import, so working modules still load their code exactly once.
  const Component = useMemo(
    () => makeSlotComponent(props.entry, props.slot),
    [props.entry, props.slot, attempt]
  );
  return (
    <ModuleWidgetBoundary key={attempt} onRetry={() => setAttempt((n) => n + 1)}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </ModuleWidgetBoundary>
  );
}

/**
 * Generic Today-widget docking (#799 module-web-registry Phase A).
 *
 * Without `slot` every widget of every enabled module renders, as before. With
 * `slot` only widgets declaring that slot render. Disabled modules are filtered
 * before anything mounts, so their `load()` never runs.
 */
export function ModuleTodayWidgets(props: {
  readonly disabledModuleIds: readonly string[];
  readonly slot?: string;
}): ReactNode {
  const disabled = new Set(props.disabledModuleIds);
  return (
    <>
      {MODULE_WEB_CONTRIBUTIONS.filter((entry) => !disabled.has(entry.moduleId)).map((entry) => (
        <ModuleEntryWidgets key={entry.moduleId} entry={entry} slot={props.slot} />
      ))}
    </>
  );
}
