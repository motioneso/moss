import {
  Bell,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Layers3,
  LogOut,
  Settings,
  X
} from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { NavLink } from "react-router";

import type { MeResponse, ModuleNavigationEntryDto } from "@moss/shared";
import { Avatar, BrandMark, IconButton, Menu, useDialogLifecycle } from "@moss/ui";
import type { NavSection } from "../app-route-metadata.js";
import { ModulePersistentControls } from "./module-persistent-controls.js";
import { NAV_ICON_MAP } from "./nav-icons.js";
import type { ShellNavMode } from "./nav-storage.js";
import { assistantName } from "../api/use-assistant-name.js";

export interface ShellNavProps {
  readonly navMode: ShellNavMode;
  readonly onToggleNav: () => void;
  readonly mobileNavOpen: boolean;
  readonly closeMobileNav: () => void;
  readonly openNavButtonRef: RefObject<HTMLButtonElement | null>;
  readonly me: MeResponse;
  readonly modulesLoading: boolean;
  readonly navSections: readonly NavSection[];
  readonly unreadByModule: Readonly<Record<string, number>>;
  readonly unreadCount: number;
  readonly signOutPending: boolean;
  readonly onSignOut: () => void;
  readonly onNavigate: (to: string) => void;
}

export function ShellNav(props: ShellNavProps) {
  const collapsed = props.navMode === "rail";

  const sidebarRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onDialogKeyDown = useDialogLifecycle({
    ref: sidebarRef,
    backdropRef: scrimRef,
    enabled: props.mobileNavOpen,
    onClose: props.closeMobileNav,
    returnFocusRef: props.openNavButtonRef
  });

  useEffect(() => {
    if (!props.mobileNavOpen) return;
    const media = window.matchMedia("(max-width: 920px)");
    const closeOnDesktop = () => {
      if (!media.matches) props.closeMobileNav();
    };
    closeOnDesktop();
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, [props.mobileNavOpen, props.closeMobileNav]);

  const closeAndRefocus = () => props.closeMobileNav();

  return (
    <>
      <aside
        id="moss-main-navigation"
        ref={sidebarRef}
        className={`sidebar ${props.mobileNavOpen ? "open" : ""}`}
        role={props.mobileNavOpen ? "dialog" : undefined}
        aria-modal={props.mobileNavOpen ? true : undefined}
        aria-label={props.mobileNavOpen ? "Navigation" : undefined}
        tabIndex={props.mobileNavOpen ? -1 : undefined}
        onKeyDown={onDialogKeyDown}
      >
        <div className="brand-row">
          <div className="brand-lockup">
            <span className="brand-mark">
              <BrandMark />
            </span>
            <span className="brand-wordmark">{assistantName()}</span>
          </div>

          {props.mobileNavOpen ? (
            <span className="sidebar-mobile-close">
              <IconButton aria-label="Close navigation" onClick={closeAndRefocus}>
                <X aria-hidden="true" />
              </IconButton>
            </span>
          ) : null}
          <span className="nav-collapse">
            <IconButton
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
              onClick={props.onToggleNav}
            >
              {collapsed ? (
                <ChevronsRight aria-hidden="true" />
              ) : (
                <ChevronsLeft aria-hidden="true" />
              )}
            </IconButton>
          </span>
        </div>

        {/* #1734: the accessible name is what a screen reader announces on entering this
          landmark, so "Modules" leaked our packaging word to exactly the users least able to
          ignore it. "Main" names what the list is for. */}
        <nav className="module-nav" aria-label="Main">
          {props.navSections.map((section) => (
            <div className="nav-group" key={section.key}>
              {section.label ? <p className="nav-group__label">{section.label}</p> : null}
              {section.items.map((entry) => (
                <NavItem
                  key={entry.id}
                  entry={entry}
                  unreadByModule={props.unreadByModule}
                  onClick={props.closeMobileNav}
                  rail={collapsed}
                />
              ))}
            </div>
          ))}
          {/* #1734: "Loading modules" named our packaging; the user is just waiting for the list. */}
          {props.modulesLoading ? <span className="nav-loading">Loading</span> : null}
        </nav>

        <div className="rail-foot">
          <RailUserMenu
            me={props.me}
            unreadCount={props.unreadCount}
            signOutPending={props.signOutPending}
            onSignOut={props.onSignOut}
            onNavigate={(to) => {
              props.closeMobileNav();
              props.onNavigate(to);
            }}
          />
        </div>
      </aside>

      {props.mobileNavOpen ? (
        <div
          aria-hidden="true"
          ref={scrimRef}
          className="sidebar-scrim"
          onClick={closeAndRefocus}
        />
      ) : null}
    </>
  );
}

function formatUnreadCount(unreadCount: number): string {
  return unreadCount > 99 ? "99+" : String(unreadCount);
}

/** Account actions share the menu's keyboard and focus behavior. */
function RailUserMenu(props: {
  readonly me: MeResponse;
  readonly unreadCount: number;
  readonly signOutPending: boolean;
  readonly onSignOut: () => void;
  readonly onNavigate: (to: string) => void;
}) {
  const name = props.me.user.name.trim() || props.me.user.email;
  return (
    <Menu
      className="shell-account-menu"
      placement="top"
      triggerVariant="content"
      triggerLabel={
        props.unreadCount > 0
          ? `Account menu, ${formatUnreadCount(props.unreadCount)} unread notification${props.unreadCount === 1 ? "" : "s"}`
          : "Account menu"
      }
      triggerContent={
        <>
          <Avatar name={name} size="sm" />
          <span className="jds-usermenu__id">
            <span className="jds-usermenu__nm">{name}</span>
          </span>
          {props.unreadCount > 0 ? (
            <span className="jds-badge-count" aria-hidden="true">
              {formatUnreadCount(props.unreadCount)}
            </span>
          ) : null}
          <ChevronUp size={16} aria-hidden="true" />
        </>
      }
      items={[
        {
          id: "notifications",
          label:
            props.unreadCount > 0
              ? `Notifications (${formatUnreadCount(props.unreadCount)})`
              : "Notifications",
          icon: <Bell size={16} aria-hidden="true" />
        },
        { id: "settings", label: "Settings", icon: <Settings size={16} aria-hidden="true" /> },
        {
          id: "sign-out",
          label: "Log out",
          icon: <LogOut size={16} aria-hidden="true" />,
          disabled: props.signOutPending
        }
      ]}
      onSelect={(id) => {
        if (id === "sign-out") props.onSignOut();
        else props.onNavigate(id === "notifications" ? "/notifications" : "/settings");
      }}
    />
  );
}

/**
 * #1285: `ModuleNavigationEntryDto` (packages/shared/src/platform-api.ts) does not yet declare
 * a `badge` field — extending it there, and re-emitting it from `serializeExternalModule` in
 * apps/api/src/server.ts, is outside this task's file boundary pending a scope decision from
 * team-lead. This local extension keeps NavItem forward-compatible without touching that DTO:
 * `badge` is simply always `undefined` until the DTO gains the field, so this is inert, not a
 * behavior change. The manifest-facing counterpart (`ExternalModuleNavigationEntry.badge` in
 * module-sdk) is already validated and re-emitted end-to-end by validate.ts.
 */
type NavEntryWithBadge = ModuleNavigationEntryDto & {
  readonly badge?: { readonly source: "notifications" };
};

function NavItem(props: {
  readonly entry: ModuleNavigationEntryDto;
  readonly unreadByModule: Readonly<Record<string, number>>;
  readonly onClick: () => void;
  readonly rail?: boolean;
}) {
  const Icon = props.entry.icon ? (NAV_ICON_MAP[props.entry.icon] ?? Layers3) : Layers3;
  const entry = props.entry as NavEntryWithBadge;
  // #1285: a nav entry id is always exactly the owning module's id, or "<moduleId>.<slug>"
  // (validate.ts's #1019 anti-spoof rule enforces this at manifest-validation time), so
  // splitting on "." reliably recovers the true module id without needing a separate
  // moduleId prop threaded through app-route-metadata.ts's buildShellNavigation.
  const moduleId = entry.id.split(".")[0] ?? entry.id;
  const unreadCount =
    entry.badge?.source === "notifications" ? (props.unreadByModule[moduleId] ?? 0) : 0;

  return (
    <NavLink
      aria-label={props.rail ? props.entry.label : undefined}
      className={({ isActive }) => `module-link ${isActive ? "active" : ""}`}
      title={props.rail ? props.entry.label : undefined}
      to={props.entry.path}
      onClick={props.onClick}
    >
      <Icon size={17} />
      <span className="module-link__label">{props.entry.label}</span>
      <ModulePersistentControls navigationFor={moduleId} />
      {unreadCount > 0 ? (
        // #1285: a module can only ever select WHICH core-owned count to display
        // (badge.source is a closed enum), never supply its own number.
        <span className="jds-badge-count">{formatUnreadCount(unreadCount)}</span>
      ) : null}
    </NavLink>
  );
}
