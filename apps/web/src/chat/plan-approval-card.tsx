import { Button, Card, Eyebrow } from "@moss/ui";

/**
 * The plan-approval card (#1756) — the raised card in the chat transcript that lays out what
 * Moss means to build before it builds it. Fixture-shaped for now: `ModuleBuildPlan` mirrors the
 * shape #1754's plan-writing step (`writeModuleBuildPlan`) will produce, so this card wires to
 * the real endpoint unchanged once that lands.
 */

export interface ModuleBuildPlan {
  readonly whatItDoes: string;
  readonly whatItReaches: readonly string[];
  readonly whatItKeeps: string;
  readonly whenItRuns: string;
  readonly roughCost: { readonly time: string; readonly budgetCents: number };
}

export interface PlanApprovalCardProps {
  readonly plan: ModuleBuildPlan;
  readonly onBuildIt: () => void;
  readonly onNotYet: () => void;
  /**
   * Once agreed (or superseded by a reissued plan), the card stops being a decision and becomes
   * ordinary conversation — per the design ruling "a plan is read before it is agreed," it never
   * collapses to a dimmed one-line confirmation, it just stops being a card.
   */
  readonly superseded?: boolean;
}

function planLines(plan: ModuleBuildPlan): ReadonlyArray<{ label: string; value: string }> {
  return [
    { label: "What it does", value: plan.whatItDoes },
    { label: "What it reaches", value: plan.whatItReaches.join(", ") },
    { label: "What it keeps", value: plan.whatItKeeps },
    { label: "When it runs", value: plan.whenItRuns }
  ];
}

export function PlanApprovalCard(props: PlanApprovalCardProps) {
  const lines = planLines(props.plan);

  if (props.superseded) {
    return (
      <div className="plan-card plan-card--superseded jds-caption">
        {lines.map((line) => (
          <p key={line.label} className="plan-card__superseded-line">
            <strong>{line.label}:</strong> {line.value}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="plan-card">
      <Card raised>
        <Eyebrow tone="gold">Agree this plan?</Eyebrow>
        <dl className="plan-card__rows">
          {lines.map((line) => (
            <div className="plan-card__row" key={line.label}>
              <Eyebrow as="dt">{line.label}</Eyebrow>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        <div className="plan-card__actions">
          <Button size="sm" type="button" onClick={props.onBuildIt}>
            Build it
          </Button>
          <Button variant="quiet" size="sm" type="button" onClick={props.onNotYet}>
            Not yet
          </Button>
        </div>
      </Card>
    </div>
  );
}
