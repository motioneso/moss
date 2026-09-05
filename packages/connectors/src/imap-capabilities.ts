import type { ConnectorCapabilityMap } from "@moss/shared";

/**
 * An IMAP account has no calendar, so it declares only the two email abilities — nothing
 * about calendars is ever shown for it.
 */
export const IMAP_CAPABILITIES: ConnectorCapabilityMap = [
  {
    ability: "Tasks and follow-ups are created from new email",
    notWorkingLabel: "Tasks are not being created from email",
    dependsOn: "email",
    requiresAiStep: true,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  },
  {
    ability: "Moss can answer about recent email",
    notWorkingLabel: "Moss cannot see recent email",
    dependsOn: "email",
    requiresAiStep: false,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  }
];
