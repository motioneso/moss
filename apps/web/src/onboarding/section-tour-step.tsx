import { Button } from "@moss/ui";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Compass, HeartPulse, House, ListChecks, Settings } from "lucide-react";

import { getModules, getMyModules } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName, personalize } from "../api/use-assistant-name.js";
import { buildTourSections, type TourSection } from "./section-tour-model";
import { FootNote, StepHeader } from "./onboarding-ui";

const ICONS: Record<TourSection["icon"], typeof House> = {
  House,
  ListChecks,
  CalendarDays,
  HeartPulse,
  Settings
};

export function SectionTourStep(props: { readonly onDone: () => void }) {
  const assistantName = useAssistantName();
  const modulesQuery = useQuery({
    queryKey: queryKeys.modules,
    queryFn: () => getModules(),
    retry: false
  });
  // Per-user enablement: a module the actor has disabled must NOT appear in the tour even
  // though it is instance-enabled. /api/modules carries navigation but not the actor's
  // per-user state; /api/me/modules carries the actor's `active` flag (Phase-2 disable seam).
  // We combine them the same way the app shell does (readNavigation): drop nav for any
  // module the actor has turned off — otherwise the tour would link a route the route guard
  // 404s for this member.
  const myModulesQuery = useQuery({
    queryKey: queryKeys.myModules,
    queryFn: () => getMyModules(),
    retry: false
  });

  // Build the set of enabled nav paths from the modules registry, gated on per-user state.
  // Settings is always present (core); a section whose route is not in the enabled nav set
  // is omitted — this is how "Wellness" disappears when it's uninstalled OR the actor disabled it.
  const disabledModuleIds = (myModulesQuery.data?.modules ?? [])
    .filter((m) => !m.active)
    .map((m) => m.id);
  const sections = buildTourSections(
    modulesQuery.data?.modules ?? [],
    disabledModuleIds,
    assistantName
  );

  return (
    <section className="onb-step" aria-labelledby="member-tour-title">
      <StepHeader
        titleId="member-tour-title"
        eyebrow="Step 3 · Where to go"
        title="Here’s where to start."
        lede={personalize("A brief orientation to help you find your way around Moss.")}
      />
      <div className="onb-tour">
        {sections.map((section) => {
          const Icon = ICONS[section.icon];
          return (
            <div key={section.path} className="onb-tour__row">
              <span className="onb-tour__ic">
                <Icon size={19} aria-hidden="true" />
              </span>
              <div className="onb-tour__main">
                <div className="onb-tour__name">{section.label}</div>
                <div className="onb-tour__job">{section.blurb}</div>
              </div>
            </div>
          );
        })}
      </div>
      <FootNote icon={<Compass size={15} aria-hidden="true" />}>
        Only the modules enabled for your account are shown. Others will appear as they are turned
        on.
      </FootNote>
      <Button variant="link" onClick={props.onDone}>
        Continue
      </Button>
    </section>
  );
}
