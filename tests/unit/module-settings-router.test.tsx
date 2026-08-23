import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ModuleSettingsErrorFallback,
  ModuleSettingsRouter,
  findModuleSettingsEntrySurface,
  findModuleSettingsSurface,
  type ModuleSettingsComponent
} from "../../packages/settings-ui/src/router.js";
import type {
  GeneratedSettingsSurface,
  ModuleSettingsSurfaceProps
} from "../../packages/settings-ui/src/index.js";

const surfaces: GeneratedSettingsSurface[] = [
  {
    moduleId: "fixture",
    moduleName: "Fixture",
    id: "fixture.settings",
    label: "Fixture",
    path: "/settings/modules/fixture",
    scope: "user",
    order: 10,
    hasEntry: true
  }
];
const declarativeSurfaces: GeneratedSettingsSurface[] = [
  {
    ...surfaces[0]!,
    moduleId: "declarative",
    moduleName: "Declarative",
    hasEntry: false
  }
];

describe("ModuleSettingsRouter", () => {
  it("renders a contributed module settings component with host props", () => {
    const FixtureSettings: ModuleSettingsComponent = ({
      onBack,
      onSelectSection,
      onNavigate
    }: ModuleSettingsSurfaceProps) => (
      <section>
        <button type="button" onClick={onBack}>
          Back
        </button>
        <div>Fixture settings body</div>
        <div>{onSelectSection ? "can select" : "missing select"}</div>
        <div>{onNavigate ? "can navigate" : "missing navigate"}</div>
      </section>
    );

    const markup = renderToStaticMarkup(
      <ModuleSettingsRouter
        moduleId="fixture"
        surfaces={surfaces}
        components={{ fixture: FixtureSettings }}
        onBack={() => undefined}
        onSelectSection={() => undefined}
        onNavigate={() => undefined}
      />
    );

    expect(markup).toContain("Fixture settings body");
    expect(markup).toContain("can select");
    expect(markup).toContain("can navigate");
  });

  it("renders the shared back control on the loaded-surface path", () => {
    const FixtureSettings: ModuleSettingsComponent = () => <div>Fixture settings body</div>;

    const markup = renderToStaticMarkup(
      <ModuleSettingsRouter
        moduleId="fixture"
        surfaces={surfaces}
        components={{ fixture: FixtureSettings }}
        onBack={() => undefined}
      />
    );

    expect(markup).toContain("Fixture settings body");
    expect(markup).toContain(">Back to modules<");
  });

  it("renders an installed-code fallback when metadata has no component", () => {
    const markup = renderToStaticMarkup(
      <ModuleSettingsRouter
        moduleId="fixture"
        surfaces={surfaces}
        components={{}}
        onBack={() => undefined}
      />
    );

    expect(markup).toContain("Fixture settings");
    expect(markup).toContain("Back");
    expect(markup).toContain("client surface isn&#x27;t installed");
  });

  it("renders a benign fallback for declarative settings surfaces", () => {
    const markup = renderToStaticMarkup(
      <ModuleSettingsRouter
        moduleId="declarative"
        surfaces={declarativeSurfaces}
        components={{}}
        onBack={() => undefined}
      />
    );

    expect(markup).toContain("Declarative settings");
    expect(markup).toContain("Back");
    expect(markup).toContain("No settings UI for this module yet");
    expect(markup).not.toContain("client surface isn&#x27;t installed");
  });

  it("exposes the error fallback used by the per-surface boundary", () => {
    const markup = renderToStaticMarkup(
      <ModuleSettingsErrorFallback surface={surfaces[0]!} onBack={() => undefined} />
    );

    expect(markup).toContain("Fixture settings failed to load");
    expect(markup).toContain("Back");
  });

  it("finds only user-scoped surfaces for module rows", () => {
    expect(
      findModuleSettingsSurface("fixture", [{ ...surfaces[0]!, scope: "admin" }, surfaces[0]!])?.id
    ).toBe("fixture.settings");
  });

  it("finds only entry-backed surfaces for configure buttons", () => {
    expect(findModuleSettingsEntrySurface("declarative", declarativeSurfaces)).toBeUndefined();
    expect(findModuleSettingsEntrySurface("fixture", surfaces)?.id).toBe("fixture.settings");
  });
});
