// external-modules/meals/src/web/screens/household.tsx
//
// Everyone at the table: what each person eats, never eats, likes and aims for. Remove shows only
// with the host's write handle and never for the self member.
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Eyebrow,
  SectionHead,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { KitchenView, MemberView } from "../../contracts";
import { dailyTarget, joinTitled, sharingRule, slotsEaten, titleCase } from "../format";
import type { KitchenState } from "../kitchen";
import type { MealsWrites } from "../writes";
import type { HostActions } from "../root";

export function HouseholdScreen(props: {
  state: KitchenState;
  reload: () => void;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state } = props;
  if (state.kind === "loading") {
    return (
      <p className="jds-caption" role="status">
        Loading the household
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <EmptyState title="Couldn't load the household">
        <Button variant="secondary" onClick={props.reload}>
          Try again
        </Button>
      </EmptyState>
    );
  }
  return <Household {...props} kitchen={state.kitchen} />;
}

function Household(props: {
  kitchen: KitchenView;
  reload: () => void;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { kitchen, writes } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const count = kitchen.members.length;

  async function remove(member: MemberView) {
    if (writes === null) return;
    setBusy(member.memberId);
    setFailed(false);
    const outcome = await writes.invoke("meals.household.remove", { memberId: member.memberId });
    setBusy(null);
    if (outcome.kind === "succeeded") props.reload();
    else if (outcome.kind !== "cancelled") setFailed(true);
  }

  return (
    <div className="mls-grid">
      <div className="mls-stack">
        <section className="mls-stack">
          <SectionHead title="People" meta={count === 1 ? "1 person" : `${count} people`} rule />
          {failed ? (
            <p className="jds-caption" role="alert">
              Couldn't remove that person
            </p>
          ) : null}
          <ul className="mls-members">
            {kitchen.members.map((member) => (
              <li className="mls-member" key={member.memberId}>
                <Avatar name={member.name} />
                <div className="mls-stack mls-stack--tight">
                  <div className="mls-row">
                    <h3 className="jds-card-title">{member.name}</h3>
                    {member.isSelf && member.name !== "You" ? <Badge>You</Badge> : null}
                  </div>
                  <Facts member={member} />
                </div>
                {writes !== null && !member.isSelf ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove ${member.name}`}
                    disabled={busy !== null}
                    onClick={() => void remove(member)}
                  >
                    Remove
                  </Button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </section>
        {count > 1 ? <Together kitchen={kitchen} /> : null}
      </div>
      <aside className="mls-rail">
        <div className="mls-stack mls-stack--tight">
          <Eyebrow>At the table</Eyebrow>
          <ul className="mls-table">
            {kitchen.members.map((member) => (
              <li key={member.memberId}>
                <span>{member.name}</span>
                <span className="jds-caption">
                  {member.mealPattern.length === 1
                    ? "1 meal a day"
                    : `${member.mealPattern.length} meals a day`}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            props.hostActions.openAssistant({ starterPrompt: "Add someone to my household: " })
          }
        >
          Ask Moss
        </Button>
      </aside>
    </div>
  );
}

function Facts(props: { member: MemberView }): ReactNodeLike {
  const { member } = props;
  const target = dailyTarget(member);
  return (
    <dl className="mls-facts">
      <dt className="jds-caption">Meals</dt>
      <dd>{member.mealPattern.length > 0 ? joinTitled(member.mealPattern) : "None"}</dd>
      <dt className="jds-caption">Never serve</dt>
      <dd>
        {member.restrictions.length > 0 ? (
          <span className="mls-chips">
            {member.restrictions.map((item) => (
              <Badge key={item} tone="red">
                {item}
              </Badge>
            ))}
          </span>
        ) : (
          "Nothing"
        )}
      </dd>
      <dt className="jds-caption">Preferences</dt>
      <dd>{member.preferences.length > 0 ? member.preferences.join(", ") : "None yet"}</dd>
      <dt className="jds-caption">Daily target</dt>
      <dd>{target ?? "None"}</dd>
      <dt className="jds-caption">Moss account</dt>
      <dd>{member.isSelf ? "You" : (member.linkedAccountEmail ?? "Not linked")}</dd>
    </dl>
  );
}

function Together(props: { kitchen: KitchenView }): ReactNodeLike {
  const { kitchen } = props;
  return (
    <section className="mls-stack">
      <SectionHead title="Who eats together" rule />
      <dl className="mls-facts">
        {slotsEaten(kitchen.members).flatMap((slot) => {
          const eaters = kitchen.members.filter((member) => member.mealPattern.includes(slot));
          const rule = kitchen.slotRules.find((entry) => entry.slotName === slot);
          return [
            <dt className="jds-caption" key={`${slot}-t`}>
              {titleCase(slot)}
            </dt>,
            <dd key={`${slot}-d`}>
              {eaters.length === 1 ? `Only ${eaters[0]!.name}` : sharingRule(rule)}
            </dd>
          ];
        })}
      </dl>
    </section>
  );
}
