import type { IntegrationClassifierRisk, IntegrationToolDescriptor } from "@moss/shared";

import {
  sha256Of,
  toolDefinitionFields,
  type ToolDefinitionFields
} from "./classifier-fingerprint.js";

/**
 * The inputs that decide a connected tool's risk (spec 8.2, #2984).
 *
 * The record holds the definition fields the definition fingerprint covers, plus the web
 * service's HTTP method from the tool's call recipe. The code risk rule reads only this record,
 * and the sort fingerprint hashes it, so any change to a risk input makes the sort stale. That
 * includes a `PUT` becoming `DELETE` under the same name, summary and schema. The definition
 * fingerprint still excludes the call recipe and governs preparation.
 */
export interface ToolRiskInputs extends ToolDefinitionFields {
  /** Upper-case HTTP method for a web-service tool; `null` for an MCP tool. */
  readonly httpMethod: string | null;
}

/** A discovered tool, with the call recipe a web-service tool carries. */
export interface RiskInputSource extends IntegrationToolDescriptor {
  readonly invoke?: { readonly method: string };
}

export function toolRiskInputs(tool: RiskInputSource): ToolRiskInputs {
  const method = tool.invoke?.method;
  return {
    ...toolDefinitionFields(tool),
    httpMethod: typeof method === "string" && method !== "" ? method.toUpperCase() : null
  };
}

/** The token a stored sort is compared against. A mismatch means the sort is stale. */
export function toolSortFingerprint(inputs: ToolRiskInputs): string {
  return sha256Of(inputs);
}

/** Risks from lowest to highest. A sorted group maps to one of these. */
export const CLASSIFIER_RISK_ORDER: readonly IntegrationClassifierRisk[] = [
  "read",
  "write",
  "outbound",
  "destructive"
];

/** The higher of two risks. `null` stands for no opinion and never lowers the other. */
export function higherRisk(
  a: IntegrationClassifierRisk,
  b: IntegrationClassifierRisk | null
): IntegrationClassifierRisk {
  if (b === null) return a;
  return CLASSIFIER_RISK_ORDER.indexOf(b) > CLASSIFIER_RISK_ORDER.indexOf(a) ? b : a;
}
