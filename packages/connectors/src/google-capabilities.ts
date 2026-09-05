import type { ConnectorCapabilityMap } from "@moss/shared";

/**
 * What a Google connector account feeds the rest of the product, and how stale each
 * ability is allowed to get before we tell the user it stopped working. Declared here
 * (not hard-coded in a screen) so the status code and the Moss status tool both derive
 * the same "what is not working" list from one place.
 */
export const GOOGLE_CAPABILITIES: ConnectorCapabilityMap = [
  {
    ability: "Calendar on the Calendar screen and Today is current",
    notWorkingLabel: "Calendar is out of date",
    dependsOn: "calendar",
    requiresAiStep: false,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  },
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
