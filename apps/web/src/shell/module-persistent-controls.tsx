import { Component, lazy, Suspense, useMemo, type ReactNode } from "react";
import { MODULE_PERSISTENT_CONTROLS } from "virtual:moss-module-web";
import { Button } from "@moss/ui";
type Entry = (typeof MODULE_PERSISTENT_CONTROLS)[number];
class ControlsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
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
function EntryControls({ entry }: { readonly entry: Entry }) {
  const Controls = useMemo(
    () =>
      lazy(async () => {
        const contribution = (await entry.load()).default;
        return { default: () => contribution.element };
      }),
    [entry]
  );
  return (
    <Suspense fallback={null}>
      <Controls />
    </Suspense>
  );
}
/** A module owns its controls; the shell keeps them mounted through ordinary navigation. */
export function ModulePersistentControls({
  disabledModuleIds
}: {
  readonly disabledModuleIds: readonly string[];
}) {
  return (
    <>
      {MODULE_PERSISTENT_CONTROLS.filter(
        (entry) => !disabledModuleIds.includes(entry.moduleId)
      ).map((entry) => (
        <ControlsBoundary key={entry.moduleId}>
          <EntryControls entry={entry} />
        </ControlsBoundary>
      ))}
    </>
  );
}
