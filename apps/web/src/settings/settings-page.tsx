import "../styles/settings.css";
import "../styles/settings-panes.css";
import "../styles/settings-panes-2.css";
import "../styles/settings-panes-3.css";
import "../styles/settings-quiet-hours.css";
import "../styles/settings-activity.css";

import {
  Activity,
  Bell,
  Boxes,
  Brain,
  ChevronDown,
  Command,
  Link2,
  ListChecks,
  Package,
  Palette,
  ScrollText,
  ServerCog,
  ShieldCheck,
  GitCommitHorizontal,
  KeyRound,
  UserRound,
  Users,
  X,
  type LucideIcon
} from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { MODULE_SETTINGS_SURFACES, MODULE_SETTING_KEYWORDS } from "virtual:moss-module-settings";

import { SettingsSearch, type SettingsSearchItem } from "./settings-search";

import { getFamilyKeys, getModules, getMyModules } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name.js";
import { FeedbackProvider } from "./settings-feedback";
import { ProfilePane } from "./settings-personal-panes";
import {
  coerceSettingsSectionId,
  flattenSettingsGroups,
  type SettingsSectionGroup
} from "./settings-navigation";
import { CAT_BY_ID } from "./settings-module-availability";
import { buildModuleSettingsSearchItems, MODULE_SEARCH_ID_PREFIX } from "./settings-module-search";
import {
  browserSettingsStorage,
  readSettingsStorage,
  writeSettingsStorage
} from "./settings-storage";
import type { PaneProps } from "./settings-types";
import { Button } from "@moss/ui";
import { Note, PrioritySettings, Segmented } from "./settings-ui";
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
  | "connections"
  | "modules"
  | "appearance"
  | "activity"
  | "skills"
  | "released"
  | "alerts";

type AdminSectionId =
  | "people"
  | "aiproviders"
  | "shadowreport"
  | "instmods"
  | "audit"
  | "oversight"
  | "host"
  | "enckeys";

function lazyPane(loader: () => Promise<{ default: SettingsPane }>) {
  return lazy(loader);
}

const AssistantPane = lazyPane(() =>
  import("./settings-ai-pane").then((module) => ({ default: module.AssistantPane }))
);
const MemoryPane = lazyPane(() =>
  import("./settings-memory-pane").then((module) => ({ default: module.MemoryPane }))
);
const ConnectionsPane = lazyPane(() =>
  import("./settings-connections-pane").then((module) => ({ default: module.ConnectionsPane }))
);
const ModulesPane = lazyPane(() =>
  import("./settings-personal-data-panes").then((module) => ({ default: module.ModulesPane }))
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
const AlertsPane = lazyPane(() =>
  import("./settings-alerts-pane").then((module) => ({ default: module.AlertsPane }))
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
// Temporary classifier shadow report (#2957). Not a permanent section: do not extend it.
const ShadowReportPane = lazyPane(() =>
  import("./settings-shadow-report-pane").then((module) => ({
    default: module.ShadowReportPane
  }))
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
const EncryptionKeysPane = lazyPane(() =>
  import("./settings-encryption-keys-pane").then((module) => ({
    default: module.EncryptionKeysPane
  }))
);

const LEGACY_CONNECTION_SECTIONS: ReadonlySet<string> = new Set([
  "connected",
  "sources",
  "integrations"
]);

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
        label: "Your assistant",
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
        id: "alerts",
        icon: Bell,
        label: "Alerts & quiet hours",
        description: coreSettingDescription("alerts"),
        Pane: AlertsPane
      },
      {
        id: "released",
        icon: ScrollText,
        label: "What's new",
        description: coreSettingDescription("released"),
        Pane: ReleasedPane
      }
    ]
  },
  {
    label: "Connections",
    sections: [
      {
        id: "connections",
        icon: Link2,
        label: "Connections",
        description: coreSettingDescription("connections"),
        Pane: ConnectionsPane
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
        label: "AI providers",
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
      },
      {
        id: "enckeys",
        icon: KeyRound,
        label: "Encryption keys",
        description: coreSettingDescription("enckeys"),
        Pane: EncryptionKeysPane
      }
    ]
  }
] as const satisfies readonly SettingsSectionGroup<SettingsSection<AdminSectionId>>[];
export const ADMIN_SECTIONS = flattenSettingsGroups<SettingsSection<AdminSectionId>>(ADMIN_GROUPS);

/* Words a user might type into the settings search that the section label and
   description do not already carry. Keep truthful to what each pane shows. */
const SECTION_KEYWORDS: Record<string, readonly string[]> = {
  profile: [
    "display name",
    "name",
    "time zone",
    "timezone",
    "date format",
    "clock",
    "weather",
    "temperature",
    "fahrenheit",
    "celsius",
    "location",
    "sessions",
    "sign out",
    "export",
    "download data",
    "delete account"
  ],
  appearance: ["theme", "dark mode", "light mode", "colours", "colors", "palette"],
  connections: [
    "accounts",
    "email",
    "google",
    "notes folder",
    "data sources",
    "integrations",
    "apps",
    "services",
    "connected accounts"
  ],
  assistant: ["model", "ai", "provider", "assistant name", "personality", "voice"],
  alerts: ["email alerts", "notifications", "digest", "quiet hours", "do not disturb"],
  people: ["users", "invite", "roles", "admin", "members"],
  aiproviders: [
    "api key",
    "openai",
    "anthropic",
    "ollama",
    "model",
    "provider",
    "typesafe",
    "system one"
  ],
  instmods: ["install", "modules", "uninstall", "update"],
  audit: ["log", "history", "who did what"],
  host: ["server", "domain", "url", "backup", "advanced"],
  enckeys: ["encryption", "keys", "secret", "credentials", "setup"]
};

interface SettingsPageProps {
  readonly me: MeResponse;
}

export function SettingsPage({ me }: SettingsPageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = me.user.isInstanceAdmin;
  const storage = browserSettingsStorage();
  const assistantName = useAssistantName();
  const myModulesQuery = useQuery({
    queryKey: queryKeys.myModules,
    queryFn: getMyModules,
    retry: false
  });
  const modulesQuery = useQuery({ queryKey: queryKeys.modules, queryFn: getModules, retry: false });
  const familyKeysQuery = useQuery({
    queryKey: queryKeys.ai.familyKeys,
    queryFn: getFamilyKeys,
    retry: false,
    // Non-admins have no admin surface: never let their browser call an admin endpoint.
    enabled: isAdmin
  });
  const missingFamilyKeys = (familyKeysQuery.data?.keys ?? []).filter(
    (key) => key.source === "missing" || key.source === "broken"
  );

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

  // Old links to the three panes that became Connections keep working.
  useEffect(() => {
    if (requested && LEGACY_CONNECTION_SECTIONS.has(requested)) {
      const next = new URLSearchParams(searchParams);
      next.set("section", "connections");
      setSearchParams(next, { replace: true });
    }
  }, [requested, searchParams, setSearchParams]);
  const requestedPersonal = PERSONAL_SECTIONS.find((section) => section.id === requested);
  const requestedAdmin = isAdmin
    ? ADMIN_SECTIONS.find((section) => section.id === requested)
    : undefined;
  // Temporary shadow report (#2957): reached by direct link from the Classifier row, never
  // from the sidebar, so it stays out of ADMIN_GROUPS while ?section=shadowreport keeps working.
  // It carries the full section shape (the icon is unused) so the pane lookup below typechecks.
  const requestedHiddenAdmin: SettingsSection<AdminSectionId> | undefined =
    isAdmin && requested === "shadowreport"
      ? {
          id: "shadowreport",
          icon: GitCommitHorizontal,
          label: "Shadow report",
          description: coreSettingDescription("shadowreport"),
          Pane: ShadowReportPane
        }
      : undefined;

  useEffect(() => {
    if (requestedPersonal) {
      setMode("personal");
      setCategoryPersonal(requestedPersonal.id);
    } else if (requestedAdmin) {
      setMode("admin");
      setCategoryAdmin(requestedAdmin.id);
    } else if (requestedHiddenAdmin) {
      setMode("admin");
    }
  }, [requestedAdmin, requestedHiddenAdmin, requestedPersonal]);

  const adminMode =
    requestedAdmin || requestedHiddenAdmin
      ? true
      : requestedPersonal
        ? false
        : isAdmin && mode === "admin";
  const groups = adminMode ? ADMIN_GROUPS : PERSONAL_GROUPS;
  const sections = adminMode ? ADMIN_SECTIONS : PERSONAL_SECTIONS;
  const active =
    requestedAdmin?.id ??
    requestedHiddenAdmin?.id ??
    requestedPersonal?.id ??
    (adminMode ? categoryAdmin : categoryPersonal);
  const activeSection =
    sections.find((section) => section.id === active) ?? requestedHiddenAdmin ?? sections[0]!;
  const Pane = activeSection.Pane;

  const [sheetOpen, setSheetOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Phone: no ?section= means the person has not chosen yet, so show the whole list.
  const nothingChosen = !requested;
  // One open connection takes the full width: no section list, its own Back link instead.
  const openIntegration = searchParams.get("integration");
  const wide = activeSection.id === "connections" && !!openIntegration && openIntegration !== "new";

  // The open sheet behaves like a dialog: focus moves in, Tab stays in, Escape closes, the page
  // behind is inert, and focus returns to the picker bar.
  useEffect(() => {
    if (!sheetOpen) return;
    const nav = navRef.current;
    // Everything outside the sheet goes inert (the whole app, not just Settings), except the
    // scrim, which must stay clickable.
    const behind: HTMLElement[] = [];
    for (let node: HTMLElement | null = nav; node && node !== document.body; ) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (
          sibling !== node &&
          sibling instanceof HTMLElement &&
          !sibling.classList.contains("set2__scrim") &&
          !sibling.inert
        ) {
          sibling.inert = true;
          behind.push(sibling);
        }
      }
      node = parent;
    }
    nav?.querySelector<HTMLElement>(".set2__navitem.is-active, .set2__navitem")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSheetOpen(false);
        return;
      }
      if (event.key !== "Tab" || !nav) return;
      const focusable = [...nav.querySelectorAll<HTMLElement>("button")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      behind.forEach((el) => (el.inert = false));
      pickerRef.current?.focus();
    };
  }, [sheetOpen]);

  const setActiveSection = (id: PersonalSectionId | AdminSectionId) => {
    setSheetOpen(false);
    // A link from a personal pane may target an admin section (Chat settings' "Set up" points at
    // AI providers). Resolve across both lists so the URL carries the real id and the mode follows
    // it; coercing against the current mode's list silently landed on its first entry.
    const personal = PERSONAL_SECTIONS.find((section) => section.id === id)?.id;
    const admin = isAdmin ? ADMIN_SECTIONS.find((section) => section.id === id)?.id : undefined;
    const next =
      personal ??
      admin ??
      (adminMode
        ? coerceSettingsSectionId(ADMIN_SECTIONS, id)
        : coerceSettingsSectionId(PERSONAL_SECTIONS, id));
    setSearchParams({ section: next });
  };

  const setActiveMode = (nextMode: "personal" | "admin") => {
    setMode(nextMode);
    setSearchParams({ section: nextMode === "admin" ? categoryAdmin : categoryPersonal });
  };

  const sectionSearchItems: SettingsSearchItem[] = [
    ...PERSONAL_GROUPS,
    ...(isAdmin ? ADMIN_GROUPS : [])
  ].flatMap((group) =>
    group.sections.map((section) => ({
      id: section.id,
      label: section.label,
      description: section.description,
      group: group.label === ASSISTANT_NAME_GROUP_LABEL ? assistantName : group.label,
      keywords: SECTION_KEYWORDS[section.id] ?? []
    }))
  );
  const ownSettingsPathById = new Map(
    (modulesQuery.data?.modules ?? []).flatMap((module) =>
      module.settingsPath ? [[module.id, module.settingsPath] as const] : []
    )
  );
  const moduleSearchItems = buildModuleSettingsSearchItems(
    myModulesQuery.data?.modules ?? [],
    MODULE_SETTINGS_SURFACES,
    assistantName,
    MODULE_SETTING_KEYWORDS,
    new Set(ownSettingsPathById.keys())
  );
  const searchItems: SettingsSearchItem[] = [...sectionSearchItems, ...moduleSearchItems];

  const pickSearchResult = (id: string) => {
    if (id.startsWith(MODULE_SEARCH_ID_PREFIX)) {
      const moduleId = id.slice(MODULE_SEARCH_ID_PREFIX.length);
      const ownPath = ownSettingsPathById.get(moduleId);
      if (ownPath) {
        navigate(ownPath);
        return;
      }
      const category = CAT_BY_ID[moduleId];
      setSearchParams(category ? { section: category } : { section: "modules", module: moduleId });
      return;
    }
    setSearchParams({ section: id });
  };

  return (
    <FeedbackProvider>
      <div className={`set2${nothingChosen ? " set2--nolist" : ""}${wide ? " set2--wide" : ""}`}>
        <div className="set2__mast">
          <h1 className="set2__masttitle">Settings</h1>
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
            <SettingsSearch items={searchItems} onSelect={pickSearchResult} />
          </div>
        </div>

        <button
          type="button"
          ref={pickerRef}
          className="set2__picker"
          aria-controls="settings-sections"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <span className="set2__pickerlbl">Section</span>
          <span className="set2__pickername">{activeSection.label}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {sheetOpen ? (
          <button
            type="button"
            className="set2__scrim"
            aria-label="Close section list"
            onClick={() => setSheetOpen(false)}
          />
        ) : null}

        <div className="set2__grid">
          <nav
            id="settings-sections"
            ref={navRef}
            className={`set2__nav${sheetOpen ? " is-open" : ""}`}
            aria-label={sheetOpen ? undefined : "Settings categories"}
            role={sheetOpen ? "dialog" : undefined}
            aria-modal={sheetOpen ? true : undefined}
            aria-labelledby={sheetOpen ? "settings-sections-title" : undefined}
          >
            <div className="set2__sheethead">
              <span id="settings-sections-title" className="set2__sheettitle">
                Settings sections
              </span>
              <button
                type="button"
                className="set2__sheetclose"
                aria-label="Close section list"
                onClick={() => setSheetOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
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
            {adminMode && missingFamilyKeys.length > 0 ? (
              <Note icon={<KeyRound size={13} />}>
                Encryption needs attention:{" "}
                {missingFamilyKeys.length === 1
                  ? "one key is"
                  : `${missingFamilyKeys.length} keys are`}{" "}
                not set up. Some features are paused.{" "}
                <Button variant="secondary" size="sm" onClick={() => setActiveSection("enckeys")}>
                  Review
                </Button>
              </Note>
            ) : null}
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
