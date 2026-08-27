import {
  Bell,
  Boxes,
  Briefcase,
  CalendarDays,
  CheckSquare,
  Database,
  FileText,
  HeartPulse,
  House,
  Landmark,
  Link2,
  Mail,
  MessageSquare,
  Newspaper,
  Palette,
  Plus,
  Settings,
  Trophy,
  Utensils,
  Wrench
} from "lucide-react";
import type { ComponentType } from "react";

// Single source of truth for nav-entry icon slugs -> lucide components, shared by the
// sidebar (app-shell.tsx) and the command palette (command-palette.tsx) so the two
// can't drift out of sync with each other or with module manifests' `icon` fields.
export const NAV_ICON_MAP: Record<string, ComponentType<{ readonly size?: number }>> = {
  bell: Bell,
  boxes: Boxes,
  briefcase: Briefcase,
  "calendar-days": CalendarDays,
  "check-square": CheckSquare,
  database: Database,
  "file-text": FileText,
  "heart-pulse": HeartPulse,
  house: House,
  landmark: Landmark,
  "link-2": Link2,
  mail: Mail,
  "message-square": MessageSquare,
  newspaper: Newspaper,
  palette: Palette,
  plus: Plus,
  settings: Settings,
  trophy: Trophy,
  utensils: Utensils,
  wrench: Wrench
};
