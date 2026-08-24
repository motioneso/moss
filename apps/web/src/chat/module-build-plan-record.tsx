import { useState, type ReactElement } from "react";

import { approveModuleBuild } from "../api/module-builds-client";
import { PlanApprovalCard, type ModuleBuildPlan } from "./plan-approval-card";

/**
 * #1888 — the plan Moss hands back when you ask it in chat for a new module.
 *
 * The plan arrives on the live chat stream as the `workshop.buildModule` tool's structured
 * result. Everything here is defensive: the record is data off a stream, so a missing or
 * mis-shaped plan renders nothing at all rather than a half-drawn card.
 */
export function parseModuleBuildPlanResult(
  result: Record<string, unknown> | undefined
): { readonly buildId: string; readonly plan: ModuleBuildPlan; readonly awaitingApproval: boolean } | null {
  if (!result) return null;
  const buildId = result.buildId;
  const raw = result.plan;
  if (typeof buildId !== "string" || buildId.length === 0) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const plan = raw as Record<string, unknown>;
  const reaches = plan.whatItReaches;
  const cost = plan.roughCost as Record<string, unknown> | undefined;
  if (
    typeof plan.whatItDoes !== "string" ||
    !Array.isArray(reaches) ||
    !reaches.every((entry) => typeof entry === "string") ||
    typeof plan.whatItKeeps !== "string" ||
    typeof plan.whenItRuns !== "string" ||
    typeof cost !== "object" ||
    cost === null ||
    typeof cost.time !== "string" ||
    typeof cost.budgetCents !== "number"
  ) {
    return null;
  }
  return {
    buildId,
    awaitingApproval: result.awaitingApproval === true,
    plan: {
      whatItDoes: plan.whatItDoes,
      whatItReaches: reaches as readonly string[],
      whatItKeeps: plan.whatItKeeps,
      whenItRuns: plan.whenItRuns,
      roughCost: { time: cost.time, budgetCents: cost.budgetCents }
    }
  };
}

export function ModuleBuildPlanRecord(props: {
  readonly buildId: string;
  readonly plan: ModuleBuildPlan;
  /** False when the build already started (auto-approved), so the card renders as history. */
  readonly awaitingApproval: boolean;
}): ReactElement {
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <PlanApprovalCard
        plan={props.plan}
        superseded={decided || !props.awaitingApproval}
        onBuildIt={() => {
          setError(null);
          setDecided(true);
          approveModuleBuild(props.buildId).catch(() => {
            setDecided(false);
            setError("Could not start the build. Try Build it again.");
          });
        }}
        onNotYet={() => {
          setError(null);
          setDecided(true);
        }}
      />
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
