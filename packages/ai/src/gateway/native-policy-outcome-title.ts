import { lookupAcpToolFamily, type AcpToolFamily } from "@moss/acp";

import { approvalOutcomeTitle } from "./approval-outcome-title.js";

const POLICY_ACTION_LABELS: Readonly<Record<AcpToolFamily | "unknown", string>> = {
  read: "Read files",
  write: "Change files",
  web: "Read web content",
  shell: "Run a command",
  harmless: "Perform action",
  mode: "Perform action",
  "not-offered": "Perform action",
  moss: "Perform action",
  unknown: "Perform action"
};

/** Fixed family labels only: native descriptions, commands, paths and inputs are never read. */
export function nativePolicyOutcomeTitle(toolName: string | null): string {
  const actionLabel = POLICY_ACTION_LABELS[lookupAcpToolFamily(toolName ?? "")];
  return (
    approvalOutcomeTitle({ name: "native.permission", actionLabel }, actionLabel) ??
    "Perform action"
  );
}
