import "../styles/settings.css";
import "../styles/settings-panes.css";
import "../styles/settings-panes-2.css";
import "../styles/settings-panes-3.css";

import {
  Activity,
  Boxes,
  Brain,
  Command,
  Database,
  Link2,
  ListChecks,
  Package,
  Palette,
  Plug,
  ScrollText,
  ServerCog,
  ShieldCheck,
  GitCommitHorizontal,
  UserRound,
  Users,
  type LucideIcon
} from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useAssistantName } from "../api/use-assistant-name";
import { FeedbackProvider } from "./settings-feedback";
import { ProfilePane } from "./settings-personal-panes";
import {
  coerceSettingsSectionId,
  flattenSettingsGroups,
  type SettingsSectionGroup
} from "./settings-navigation";
import {
  browserSettingsStorage,
  readSettingsStorage,
  writeSettingsStorage
} from "./settings-storage";
import type { PaneProps } from "./settings-types";
import { PrioritySettings, Segmented } from "./settings-ui";
import { CORE_APP_SETTINGS, type MeResponse } from "@moss/shared";

type SettingsPane = ComponentType<PaneProps>;

interface SettingsSection<Id extends string> {
  readonly id: Id;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly description: string;
  readonly Pane: SettingsPane;
}

function coreSettingDescription(id: string): string {
  const declaration = CORE_APP_SETTINGS.find((setting) => setting.id === id);
  if (!declaration) throw new Error(`Missing core app-map setting declaration: ${id}`);
  return declaration.description;
}

type PersonalSectionId =
  | "profile"
  | "assistant"
  | "priorities"
  | "memory"
  | "connected"
  | "sources"
  | "integrations"
  | "modules"
  | "appearance"
  | "activity"
  | "skills"
  | "released";

type AdminSectionId = "people" | "aiproviders" | "instmods" | "audit" | "oversight" | "host";

function lazyPane(loader: () => Promise<{ default: SettingsPane }>) {
  return lazy(loader);
}

const AssistantPane = lazyPane(() =>
  import("./settings-ai-pane").then((module) => ({ default: module.AssistantPane }))
);
const MemoryPane = lazyPane(() =>
  import("./settings-memory-pane").then((module) => ({ default: module.MemoryPane }))
);
const ConnectedPane = lazyPane(() =>
  import("./settings-personal-data-panes").then((module) => ({ default: module.ConnectedPane }))
);
const SourcesPane = lazyPane(() =>
  import("./settings-personal-data-panes").then((module) => ({ default: module.SourcesPane }))
);
const ModulesPane = lazyPane(() =>
  import("./settings-personal-data-panes").then((module) => ({ default: module.ModulesPane }))
);
const IntegrationsPane = lazyPane(() =>
  import("./settings-integrations-pane").then((module) => ({
    default: module.SettingsIntegrationsPane
  }))
);
const AppearancePane = lazyPane(() =>
  import("./settings-appearance-pane").then((module) => ({ default: module.AppearancePane }))
);
const ActivityPane = lazyPane(() =>
  import("./settings-activity-pane").then((module) => ({ default: module.ActivityPane }))
);
const SkillsPane = lazyPane(() =>
  import("./settings-skills-pane").then((module) => ({ default: module.SettingsSkillsPane }))
);
const ReleasedPane = lazyPane(() =>
  import("./settings-released-pane").then((module) => ({ default: module.ReleasedPane }))
);

function PrioritiesPane(_props: PaneProps) {
  return <PrioritySettings />;
}

const PeoplePane = lazyPane(() =>
  import("./settings-admin-panes").then((module) => ({ default: module.PeoplePane }))
);
const AiProvidersPane = lazyPane(() =>
  import("./settings-ai-admin-pane").then((module) => ({ default: module.AiProvidersPane }))
);
const InstanceModulesPane = lazyPane(() =>
  import("./settings-instance-modules-pane").then((module) => ({
    default: module.InstanceModulesPane
  }))
);
const AuditPane = lazyPane(() =>
  import("./settings-audit-pane").then((module) => ({ default: module.AuditPane }))
);
const OversightPane = lazyPane(() =>
  import("./settings-admin-panes").then((module) => ({ default: module.OversightPane }))
);
const HostPane = lazyPane(() =>
  import("./settings-admin-panes").then((module) => ({ default: module.HostPane }))
);

const ASSISTANT_NAME_GROUP_LABEL = "__ASSISTANT_NAME__";

const PERSONAL_GROUPS = [
  {
    label: "Your account",
    sections: [
      {
        id: "profile",
        icon: UserRound,
        label: "Account & preferences",
        description: coreSettingDescription("profile"),
        Pane: ProfilePane
      },
      {
        id: "appearance",
        icon: Palette,
        label: "Appearance",
        description: coreSettingDescription("appearance"),
        Pane: AppearancePane
      }
    ]
  },
  {
    label: ASSISTANT_NAME_GROUP_LABEL,
    sections: [
      {
        id: "assistant",
        icon: GitCommitHorizontal,
        label: "Assistant & AI",
        description: coreSettingDescription("assistant"),
        Pane: AssistantPane
      },
      {
        id: "priorities",
        icon: ListChecks,
        label: "Priorities",
        description: coreSettingDescription("priorities"),
        Pane: PrioritiesPane
      },
      {
        id: "memory",
        icon: Brain,
        label: "Memory & context",
        description: coreSettingDescription("memory"),
        Pane: MemoryPane
      },
      {
        id: "activity",
        icon: Activity,
        label: "Activity",
        description: coreSettingDescription("activity"),
        Pane: ActivityPane
      },
      {
        id: "released",
        icon: ScrollText,
        label: "Recently Released",
        description: coreSettingDescription("released"),
        Pane: ReleasedPane
      }
    ]
  },
  {
    label: "Connections",
    sections: [
      {
        id: "connected",
        icon: Link2,
        label: "Connected accounts",
        description: coreSettingDescription("connected"),
        Pane: ConnectedPane
      },
      {
        id: "sources",
        icon: Database,
        label: "Data sources",
        description: coreSettingDescription("sources"),
        Pane: SourcesPane
      },
      {
        id: "integrations",
        icon: Plug,
        label: "Integrations",
        description: coreSettingDescription("integrations"),
        Pane: IntegrationsPane
      }
    ]
  },
  {
    label: "Extensions",
    sections: [
      {
        id: "modules",
        icon: Boxes,
        label: "Modules",
        description: coreSettingDescription("modules"),
        Pane: ModulesPane
      },
      {
        id: "skills",
        icon: Command,
        label: "Skills",
        description: coreSettingDescription("skills"),
        Pane: SkillsPane
      }
    ]
  }
] as const satisfies readonly SettingsSectionGroup<SettingsSection<PersonalSectionId>>[];
export const PERSONAL_SECTIONS =
  flattenSettingsGroups<SettingsSection<PersonalSectionId>>(PERSONAL_GROUPS);

const ADMIN_GROUPS = [
  {
    label: "Access",
    sections: [
      {
        id: "people",
        icon: Users,
        label: "People & access",
        description: coreSettingDescription("people"),
        Pane: PeoplePane
      }
    ]
  },
  {
    label: "AI & extensions",
    sections: [
      {
        id: "aiproviders",
        icon: GitCommitHorizontal,
        label: "Assistant & AI",
        description: coreSettingDescription("aiproviders"),
        Pane: AiProvidersPane
      },
      {
        id: "instmods",
        icon: Package,
        label: "Instance modules",
        description: coreSettingDescription("instmods"),
        Pane: InstanceModulesPane
      }
    ]
  },
  {
    label: "Operations",
    sections: [
      {
        id: "oversight",
        icon: Activity,
        label: "Connector oversight",
        description: coreSettingDescription("oversight"),
        Pane: OversightPane
      },
      {
        id: "audit",
        icon: ScrollText,
        label: "Audit & operations",
        description: coreSettingDescription("audit"),
        Pane: AuditPane
      },
      {
        id: "host",
        icon: ServerCog,
        label: "Advanced host setup",
        description: coreSettingDescription("host"),
        Pane: HostPane
      }
    ]
  }
] as const satisfies readonly SettingsSectionGroup<SettingsSection<AdminSectionId>>[];
export const ADMIN_SECTIONS = flattenSettingsGroups<SettingsSection<AdminSectionId>>(ADMIN_GROUPS);

interface SettingsPageProps {
  readonly me: MeResponse;
}

export function SettingsPage({ me }: SettingsPageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = me.user.isInstanceAdmin;
  const storage = browserSettingsStorage();
  const assistantName = useAssistantName();

  const [mode, setMode] = useState<"personal" | "admin">(() =>
    isAdmin && readSettingsStorage(storage, "mode") === "admin" ? "admin" : "personal"
  );
  const [categoryPersonal, setCategoryPersonal] = useState<PersonalSectionId>(() =>
    coerceSettingsSectionId(PERSONAL_SECTIONS, readSettingsStorage(storage, "categoryPersonal"))
  );
  const [categoryAdmin, setCategoryAdmin] = useState<AdminSectionId>(() =>
    coerceSettingsSectionId(ADMIN_SECTIONS, readSettingsStorage(storage, "categoryAdmin"))
  );

  useEffect(() => writeSettingsStorage(storage, "mode", mode), [mode, storage]);
  useEffect(
    () => writeSettingsStorage(storage, "categoryPersonal", categoryPersonal),
    [categoryPersonal, storage]
  );
  useEffect(
    () => writeSettingsStorage(storage, "categoryAdmin", categoryAdmin),
    [categoryAdmin, storage]
  );

  const requested = searchParams.get("section");
  const requestedPersonal = PERSONAL_SECTIONS.find((section) => section.id === requested);
  const requestedAdmin = isAdmin
    ? ADMIN_SECTIONS.find((section) => section.id === requested)
    : undefined;

  useEffect(() => {
    if (requestedPersonal) {
      setMode("personal");
      setCategoryPersonal(requestedPersonal.id);
    } else if (requestedAdmin) {
      setMode("admin");
      setCategoryAdmin(requestedAdmin.id);
    }
  }, [requestedAdmin, requestedPersonal]);

  const adminMode = requestedAdmin ? true : requestedPersonal ? false : isAdmin && mode === "admin";
  const groups = adminMode ? ADMIN_GROUPS : PERSONAL_GROUPS;
  const sections = adminMode ? ADMIN_SECTIONS : PERSONAL_SECTIONS;
  const active =
    requestedAdmin?.id ?? requestedPersonal?.id ?? (adminMode ? categoryAdmin : categoryPersonal);
  const activeSection = sections.find((section) => section.id === active) ?? sections[0]!;
  const Pane = activeSection.Pane;

  const setActiveSection = (id: PersonalSectionId | AdminSectionId) => {
    const next = adminMode
      ? coerceSettingsSectionId(ADMIN_SECTIONS, id)
      : coerceSettingsSectionId(PERSONAL_SECTIONS, id);
    setSearchParams({ section: next });
  };

  const setActiveMode = (nextMode: "personal" | "admin") => {
    setMode(nextMode);
    setSearchParams({ section: nextMode === "admin" ? categoryAdmin : categoryPersonal });
  };

  return (
    <FeedbackProvider>
      <div className="set2">
        <div className="set2__bar">
          {isAdmin ? (
            <Segmented
              value={mode === "admin" ? "admin" : "personal"}
              options={[
                { value: "personal", label: "Personal" },
                { value: "admin", label: "Admin / Setup" }
              ]}
              ariaLabel="Settings mode"
              onChange={setActiveMode}
            />
          ) : (
            <span />
          )}
        </div>

        <div className="set2__grid">
          <nav className="set2__nav" aria-label="Settings categories">
            {groups.map((group) => (
              <Fragment key={group.label}>
                <div className="set2__navgroup">
                  {group.label === ASSISTANT_NAME_GROUP_LABEL ? assistantName : group.label}
                </div>
                {group.sections.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`set2__navitem${active === item.id ? " is-active" : ""}`}
                      aria-current={active === item.id}
                      onClick={() => setActiveSection(item.id)}
                    >
                      <span className="ic">
                        <Icon size={17} aria-hidden="true" />
                      </span>
                      <span className="lbl">{item.label}</span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
            {adminMode ? (
              <div className="set2__navnote">
                <ShieldCheck size={13} aria-hidden="true" /> You have owner access
              </div>
            ) : null}
          </nav>

          <div className="set2__pane">
            <Suspense fallback={<div className="pane__loading">Loading settings...</div>}>
              <Pane
                me={me}
                onNavigate={(path) => navigate(path)}
                onSelectSection={(id) => setActiveSection(id as PersonalSectionId | AdminSectionId)}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </FeedbackProvider>
  );
}
