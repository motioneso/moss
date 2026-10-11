import { Component, lazy, Suspense, useMemo, type ReactNode } from "react";
import { MODULE_PERSISTENT_CONTROLS } from "virtual:moss-module-web";
import { Button } from "@moss/ui";
type Entry = (typeof MODULE_PERSISTENT_CONTROLS)[number];
class ControlsBoundary extends Component<
  { children: ReactNode; quiet?: boolean },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed && this.props.quiet) return null;
    return this.state.failed ? (
      <p role="alert" className="jds-hint">
        Recording controls couldn’t load. Use Trail Marker’s local Stop.{" "}
        <Button variant="link" onClick={() => this.setState({ failed: false })}>
          Retry controls
        </Button>
      </p>
    ) : (
      this.props.children
    );
  }
}
function EntryControls({
  entry,
  navigation
}: {
  readonly entry: Entry;
  readonly navigation?: boolean;
}) {
  const Controls = useMemo(
    () =>
      lazy(async () => {
        const contribution = (await entry.load()).default;
        return {
          default: () =>
            navigation ? (contribution.navigationIndicator ?? null) : contribution.element
        };
      }),
    [entry, navigation]
  );
  return (
    <Suspense fallback={null}>
      <Controls />
    </Suspense>
  );
}
/** A module owns its controls; the shell keeps them mounted through ordinary navigation. */
export function ModulePersistentControls({
  disabledModuleIds = [],
  navigationFor
}: {
  readonly disabledModuleIds?: readonly string[];
  readonly navigationFor?: string;
}) {
  return (
    <>
      {MODULE_PERSISTENT_CONTROLS.filter(
        (entry) =>
          !disabledModuleIds.includes(entry.moduleId) &&
          (!navigationFor || entry.moduleId === navigationFor)
      ).map((entry) => (
        <ControlsBoundary key={entry.moduleId} quiet={!!navigationFor}>
          <EntryControls entry={entry} navigation={!!navigationFor} />
        </ControlsBoundary>
      ))}
    </>
  );
}
