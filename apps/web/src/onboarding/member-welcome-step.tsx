import { Button } from "@moss/ui";
import { CircleCheck, Compass, Lock } from "lucide-react";

import { FootNote, StepHeader } from "./onboarding-ui";
import { personalize, assistantName } from "../api/use-assistant-name.js";

export function MemberWelcomeStep(props: { readonly onSkipAll: () => void }) {
  return (
    <section className="onb-step" aria-labelledby="member-welcome-title">
      <StepHeader
        titleId="member-welcome-title"
        eyebrow="Welcome"
        title={personalize("You’ve got your own Moss.")}
        lede={
          <>
            Your team or administrator has set up {assistantName()} and added your account. The
            shared environment is ready, so you can start using {assistantName()} right away. Your
            tasks, calendar, wellness data, and preferences are private to you.
          </>
        }
      />
      <div className="onb-ahead" aria-label="What getting started covers">
        <div className="onb-ahead__row">
          <span className="onb-ahead__ic">
            <CircleCheck size={19} aria-hidden="true" />
          </span>
          <div className="onb-ahead__main">
            <div className="onb-ahead__label">Already working</div>
            <div className="onb-ahead__sub">
              No installation required. {assistantName()} runs on the shared host.
            </div>
          </div>
          <span className="onb-ahead__n">01</span>
        </div>
        <div className="onb-ahead__row">
          <span className="onb-ahead__ic">
            <Lock size={19} aria-hidden="true" />
          </span>
          <div className="onb-ahead__main">
            <div className="onb-ahead__label">Private to you</div>
            <div className="onb-ahead__sub">Your tasks and account connections remain private.</div>
          </div>
          <span className="onb-ahead__n">02</span>
        </div>
        <div className="onb-ahead__row">
          <span className="onb-ahead__ic">
            <Compass size={19} aria-hidden="true" />
          </span>
          <div className="onb-ahead__main">
            <div className="onb-ahead__label">A quick look around</div>
            <div className="onb-ahead__sub">Get oriented with a quick tour of the features.</div>
          </div>
          <span className="onb-ahead__n">03</span>
        </div>
      </div>
      <FootNote>
        You can skip the tour and explore the app directly. None of these steps are required.
      </FootNote>
      <Button variant="link" onClick={props.onSkipAll}>
        Skip for now
      </Button>
    </section>
  );
}
