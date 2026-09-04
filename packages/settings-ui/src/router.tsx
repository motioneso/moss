import {
  Component,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode
} from "react";
import { ArrowLeft } from "lucide-react";

import type { GeneratedSettingsSurface } from "./scanner.js";
import type { ModuleSettingsSurfaceProps } from "./index.js";

export type ModuleSettingsComponent =
  | ComponentType<ModuleSettingsSurfaceProps>
  | LazyExoticComponent<ComponentType<ModuleSettingsSurfaceProps>>;

export interface ModuleSettingsRouterProps extends ModuleSettingsSurfaceProps {
  readonly moduleId: string;
  readonly surfaces: readonly GeneratedSettingsSurface[];
  readonly components: Readonly<Record<string, ModuleSettingsComponent>>;
}

export function findModuleSettingsSurface(
  moduleId: string,
  surfaces: readonly GeneratedSettingsSurface[]
): GeneratedSettingsSurface | undefined {
  return surfaces.find((surface) => surface.moduleId === moduleId && surface.scope === "user");
}

export function findModuleSettingsEntrySurface(
  moduleId: string,
  surfaces: readonly GeneratedSettingsSurface[]
): GeneratedSettingsSurface | undefined {
  const surface = findModuleSettingsSurface(moduleId, surfaces);
  return surface?.hasEntry ? surface : undefined;
}

export function ModuleSettingsRouter(props: ModuleSettingsRouterProps) {
  const surface = findModuleSettingsSurface(props.moduleId, props.surfaces);
  if (!surface) {
    return <ModuleSettingsNoUiFallback moduleName="Module" onBack={props.onBack} />;
  }

  if (!surface.hasEntry) {
    return <ModuleSettingsNoUiFallback moduleName={surface.moduleName} onBack={props.onBack} />;
  }

  const Surface = props.components[props.moduleId];
  if (!Surface) {
    return <ModuleSettingsMissingFallback moduleName={surface.moduleName} onBack={props.onBack} />;
  }

  return (
    <ModuleSettingsErrorBoundary surface={surface} onBack={props.onBack}>
      <RouterBackButton onBack={props.onBack} />
      <Suspense
        fallback={<RouterPaneHead title={`${surface.moduleName} settings`} desc="Loading…" />}
      >
        <Surface
          onBack={props.onBack}
          onSelectSection={props.onSelectSection}
          onNavigate={props.onNavigate}
        />
      </Suspense>
    </ModuleSettingsErrorBoundary>
  );
}

function ModuleSettingsNoUiFallback(props: {
  readonly moduleName: string;
  readonly onBack: () => void;
}) {
  return (
    <>
      <RouterPaneHead title={`${props.moduleName} settings`} />
      <RouterBackButton onBack={props.onBack} />
      <p className="set2-note">
        <span>No settings UI for this module yet.</span>
      </p>
    </>
  );
}

function ModuleSettingsMissingFallback(props: {
  readonly moduleName: string;
  readonly onBack: () => void;
}) {
  return (
    <>
      <RouterPaneHead title={`${props.moduleName} settings`} />
      <RouterBackButton onBack={props.onBack} />
      <p className="set2-note">
        <span>
          This module declares settings but its client surface isn't installed. Rebuild with the
          module package present to configure it here.
        </span>
      </p>
    </>
  );
}

export function ModuleSettingsErrorFallback(props: {
  readonly surface: GeneratedSettingsSurface;
  readonly onBack: () => void;
}) {
  return (
    <>
      <RouterPaneHead title={`${props.surface.moduleName} settings failed to load`} />
      <RouterBackButton onBack={props.onBack} />
      <p className="set2-note">
        <span>This settings surface crashed. The rest of Settings is still available.</span>
      </p>
    </>
  );
}

function RouterBackButton(props: { readonly onBack: () => void }) {
  return (
    <button type="button" className="gflow__back" onClick={props.onBack}>
      <ArrowLeft size={15} aria-hidden="true" />
      Back to modules
    </button>
  );
}

function RouterPaneHead(props: { readonly title: string; readonly desc?: string }) {
  return (
    <div className="pane__head">
      <h2 className="pane__title">{props.title}</h2>
      {props.desc ? <p className="pane__desc">{props.desc}</p> : null}
    </div>
  );
}

class ModuleSettingsErrorBoundary extends Component<
  {
    readonly surface: GeneratedSettingsSurface;
    readonly onBack: () => void;
    readonly children: ReactNode;
  },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <ModuleSettingsErrorFallback surface={this.props.surface} onBack={this.props.onBack} />
      );
    }
    return this.props.children;
  }
}
