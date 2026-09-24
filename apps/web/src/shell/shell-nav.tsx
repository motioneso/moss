import {
  Bell,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Layers3,
  LogOut,
  Settings
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { NavLink } from "react-router";

import type { MeResponse, ModuleNavigationEntryDto } from "@moss/shared";
import { BrandMark } from "@moss/ui";
import type { NavSection } from "../app-route-metadata.js";
import { NAV_ICON_MAP } from "./nav-icons.js";
import type { ShellNavMode } from "./nav-storage.js";

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

  useEffect(() => {
    if (!props.mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      props.closeMobileNav();
      props.openNavButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.mobileNavOpen, props.closeMobileNav, props.openNavButtonRef]);

  const closeAndRefocus = () => {
    props.closeMobileNav();
    props.openNavButtonRef.current?.focus();
  };

  return (
    <>
      <aside className={`sidebar ${props.mobileNavOpen ? "open" : ""}`}>
        <div className="brand-row">
          <div className="brand-lockup">
            <span className="brand-mark">
              <BrandMark />
            </span>
            <span className="brand-wordmark">Moss</span>
          </div>

          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            className="nav-collapse"
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            type="button"
            onClick={props.onToggleNav}
          >
            {collapsed ? (
              <ChevronsRight size={20} aria-hidden="true" />
            ) : (
              <ChevronsLeft size={20} aria-hidden="true" />
            )}
          </button>
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
        <button
          aria-label="Close navigation"
          className="sidebar-scrim"
          type="button"
          onClick={closeAndRefocus}
        />
      ) : null}
    </>
  );
}

function formatUnreadCount(unreadCount: number): string {
  return unreadCount > 99 ? "99+" : String(unreadCount);
}

function initialOf(value: string): string {
  return (value.trim()[0] ?? "?").toUpperCase();
}

/** Account quick-menu at the rail foot: click the profile to open Notifications,
    Settings, the dark-mode toggle, and Log out in a popover. */
function RailUserMenu(props: {
  readonly me: MeResponse;
  readonly unreadCount: number;
  readonly signOutPending: boolean;
  readonly onSignOut: () => void;
  readonly onNavigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const name = props.me.user.name.trim() || props.me.user.email;

  return (
    <div className={`jds-usermenu ${open ? "is-open" : ""}`} ref={ref}>
      <button
        className={`jds-usermenu__trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label={
          props.unreadCount > 0
            ? `Account menu, ${formatUnreadCount(props.unreadCount)} unread notification${props.unreadCount === 1 ? "" : "s"}`
            : "Account menu"
        }
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jds-usermenu__av">
          <span className="jds-avatar jds-avatar--sm">{initialOf(name)}</span>
        </span>
        <span className="jds-usermenu__id">
          <span className="jds-usermenu__nm">{name}</span>
          <span className="jds-usermenu__sub">{props.me.user.email}</span>
        </span>
        {!open && props.unreadCount > 0 ? (
          <span className="jds-badge-count" aria-hidden="true">
            {formatUnreadCount(props.unreadCount)}
          </span>
        ) : null}
        <span className="jds-usermenu__chev">
          <ChevronUp size={16} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="jds-usermenu__pop">
          <div className="jds-usermenu__list">
            <button
              className="jds-usermenu__item"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onNavigate("/notifications");
              }}
            >
              <span className="jds-usermenu__ic">
                <Bell size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Notifications</span>
              {props.unreadCount > 0 ? (
                <span className="jds-usermenu__tr">
                  <span className="jds-badge-count">{formatUnreadCount(props.unreadCount)}</span>
                </span>
              ) : null}
            </button>
            <button
              className="jds-usermenu__item"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onNavigate("/settings");
              }}
            >
              <span className="jds-usermenu__ic">
                <Settings size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Settings</span>
            </button>
            <div className="jds-usermenu__div" />
            <button
              className="jds-usermenu__item is-danger"
              type="button"
              disabled={props.signOutPending}
              onClick={props.onSignOut}
            >
              <span className="jds-usermenu__ic">
                <LogOut size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Log out</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
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
      <span>{props.entry.label}</span>
      {unreadCount > 0 ? (
        // #1285: a module can only ever select WHICH core-owned count to display
        // (badge.source is a closed enum), never supply its own number — this renders
        // exactly `unreadByModule`, never anything module-authored. Inline flex override
        // is needed because `.module-link span` (styles.css) sets flex:1 on every span
        // descendant, including this one, and styles.css is outside this task's file
        // boundary to edit.
        <span className="jds-badge-count" style={{ flex: "0 0 auto" }}>
          {formatUnreadCount(unreadCount)}
        </span>
      ) : null}
    </NavLink>
  );
}
