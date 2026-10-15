import { Button } from "@moss/ui";
import { Plug, ShieldCheck, Terminal } from "lucide-react";

import { FootNote, StepHeader } from "./onboarding-ui";
import { personalize } from "../api/use-assistant-name.js";

export function WelcomeStep(props: { readonly onSkipAll: () => void }) {
  return (
    <section className="onb-step" aria-labelledby="onboarding-welcome-title">
      <StepHeader
        titleId="onboarding-welcome-title"
        eyebrow={personalize("Setting up Moss")}
        title={personalize("Let’s get your Moss set up.")}
        lede={
          <>
            Choose an AI provider and, if you want, connect Google for calendar and email. You can
            finish setup later in Settings.
          </>
        }
      />
      <div className="onb-ahead" aria-label="What setup covers">
        <div className="onb-ahead__row">
          <span className="onb-ahead__ic">
            <Terminal size={19} aria-hidden="true" />
          </span>
          <div className="onb-ahead__main">
            <div className="onb-ahead__label">AI provider</div>
            <div className="onb-ahead__sub">
              Select the AI tool you want to run. We'll check if it's installed.
            </div>
          </div>
          <span className="onb-ahead__n">01</span>
        </div>
        <div className="onb-ahead__row">
          <span className="onb-ahead__ic">
            <Plug size={19} aria-hidden="true" />
          </span>
          <div className="onb-ahead__main">
            <div className="onb-ahead__label">Google integration</div>
            <div className="onb-ahead__sub">
              Optional. Sync calendar events and capture tasks from email.
            </div>
          </div>
          <span className="onb-ahead__n">02</span>
        </div>
      </div>
      <FootNote icon={<ShieldCheck size={15} aria-hidden="true" />}>
        All setup steps are optional. If you skip, you can configure everything later in Settings.
      </FootNote>
      <Button variant="link" onClick={props.onSkipAll}>
        Skip for now
      </Button>
    </section>
  );
}
