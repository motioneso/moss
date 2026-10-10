import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Flag, LogIn, Minus, Play } from "lucide-react";

import type { OnboardingStatusResponse, OnboardingStepsDto } from "@moss/shared";

import { completeOnboarding, getOnboardingStatus, skipOnboarding } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { ApiKeyOptOutStep } from "./api-key-opt-out-step";
import { CliAuthStep } from "./cli-auth-step";
import { ConnectorStep } from "./connector-step";
import { MemberConnectorStep } from "./member-connector-step";
import { MemberWelcomeStep } from "./member-welcome-step";
import { SectionTourStep } from "./section-tour-step";
import { WelcomeStep } from "./welcome-step";
import { firstIncompleteStepIndex } from "./resume";
import { useChatAvailable } from "./chat-availability";
import { SkipConfirmDialog, needsSkipConfirm } from "./skip-confirm";
import { personalize, assistantName } from "../api/use-assistant-name.js";

const FOUNDER_ORDER = ["welcome", "cliAuth", "connectors", "finish"] as const;
const MEMBER_ORDER = ["welcome", "assistant", "accounts", "tour", "finish"] as const;

interface RailStep {
  readonly key: string;
  readonly label: string;
  readonly mono: string;
  readonly optional?: boolean;
}

const FOUNDER_RAIL: readonly RailStep[] = [
  { key: "welcome", label: "Welcome", mono: "Start" },
  { key: "cliAuth", label: "Assistant", mono: "01" },
  { key: "connectors", label: "Google", mono: "02", optional: true },
  { key: "finish", label: "Finish", mono: "Done" }
];

const MEMBER_RAIL: readonly RailStep[] = [
  { key: "welcome", label: "Welcome", mono: "Start" },
  { key: "assistant", label: "Your assistant", mono: "01" },
  { key: "accounts", label: "Accounts", mono: "02", optional: true },
  { key: "tour", label: "A look around", mono: "03" },
  { key: "finish", label: "Finish", mono: "Done" }
];

/**
 * Resume index. Founders resume at their first not-done spine step. Members always start at the
 * welcome step (0): member step "done" flags are derived client-side per step, not from the
 * server status, so there is nothing to resume against — the whole member flow is skippable.
 */
function resumeStepIndex(status: OnboardingStatusResponse): number {
  return status.role === "member" ? 0 : firstIncompleteStepIndex(status);
}

function dotContent(step: RailStep, state: string): ReactNode {
  if (state === "done") return <Check size={13} strokeWidth={2.5} />;
  if (state === "skipped") return <Minus size={13} strokeWidth={2.5} />;
  if (step.mono === "Start") return <Play size={11} />;
  if (step.mono === "Done") return <Flag size={12} />;
  return step.mono;
}

export function OnboardingWizard(props: {
  readonly onDone: () => void;
  /** The status app.tsx already fetched — seeds the query so the wizard shows NO second loader. */
  readonly initialStatus: OnboardingStatusResponse;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: queryKeys.onboarding.status,
    queryFn: getOnboardingStatus,
    retry: false,
    initialData: props.initialStatus // never a fresh-load spinner inside the wizard
  });

  const [stepIndex, setStepIndex] = useState(() => resumeStepIndex(props.initialStatus));
  const [resumed, setResumed] = useState(false);
  const [skippedSteps, setSkippedSteps] = useState<ReadonlySet<string>>(() => new Set());
  // #369: when no provider is connected, "Skip setup" must confirm the consequence first.
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  const chatAvailable = useChatAvailable();

  useEffect(() => {
    document.body.classList.add("onboarding-active");
    return () => document.body.classList.remove("onboarding-active");
  }, []);

  // If the first server refresh arrives, resume once at the first not-done step.
  useEffect(() => {
    if (statusQuery.isSuccess && !resumed) {
      setStepIndex(resumeStepIndex(statusQuery.data));
      setResumed(true);
    }
  }, [statusQuery.isSuccess, statusQuery.data, resumed]);

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.status });

  const finish = useMutation({
    mutationFn: completeOnboarding,
    onSuccess: async () => {
      await invalidateStatus();
    },
    onSettled: (_data, error) => {
      if (error) return;
      window.location.replace("/today");
    }
  });
  const skip = useMutation({
    mutationFn: skipOnboarding,
    onSuccess: async () => {
      await invalidateStatus();
      props.onDone();
    }
  });
  // #369: every "Skip setup" affordance routes through here. If chat would dead-end (no provider
  // connected), open the consequence dialog instead of skipping; otherwise skip immediately. The
  // skip mutation is NEVER fired from inside a setState updater (StrictMode double-fire trap) —
  // requestSkip is an event handler and the dialog's confirm calls confirmSkip directly.
  const requestSkip = () => {
    if (needsSkipConfirm(statusQuery.data, chatAvailable)) {
      setSkipConfirmOpen(true);
    } else {
      skip.mutate();
    }
  };
  const confirmSkip = () => {
    setSkipConfirmOpen(false);
    skip.mutate();
  };
  // No isLoading branch: initialData guarantees data is present from the first render
  // (app.tsx already waited). A background refetch error never blanks the wizard.
  // Phase 4: the status is a role union — narrow to the founder variant for the founder steps;
  // the member step array is selected below (Task 8). One wizard, parameterized by role.
  const founderSteps = statusQuery.data.role === "founder" ? statusQuery.data.steps : undefined;
  const isMember = statusQuery.data.role === "member";

  // Phase 4: the member wizard mounts its OWN step array (no multiplexer/CLI-auth — ADR 0007 §4
  // members inherit the shared host CLI). Every step is optional/skippable; Finish and "Skip
  // setup" both POST to /complete and /skip, which Task-5 routes to setMemberOnboardingComplete.
  const stepCount = isMember ? MEMBER_ORDER.length : FOUNDER_ORDER.length;
  const activeOrder = isMember ? MEMBER_ORDER : FOUNDER_ORDER;
  const rail = isMember ? MEMBER_RAIL : FOUNDER_RAIL;
  const roleLabel = isMember ? "Member" : "Owner";
  const progressLabel = isMember ? "Getting started" : personalize("Moss setup");
  const goNext = () => setStepIndex((i) => Math.min(stepCount - 1, i + 1));
  const currentRailKey = rail[Math.min(stepIndex, stepCount - 1)]?.key ?? "welcome";
  const currentKey = activeOrder[Math.min(stepIndex, stepCount - 1)];
  const isLast = currentKey === "finish";
  const optionalKeys = new Set(rail.filter((step) => step.optional).map((step) => step.key));
  const skipCurrentStep = () => {
    setSkippedSteps((current) => new Set(current).add(currentRailKey));
    if (isLast) {
      finish.mutate();
    } else {
      goNext();
    }
  };
  const continueStep = () => {
    setSkippedSteps((current) => {
      const next = new Set(current);
      next.delete(currentRailKey);
      return next;
    });
    goNext();
  };
  const progressTotal = stepCount - 1;
  const completedCount = Math.min(stepIndex + (isLast ? 0 : 1), progressTotal);
  const railState = (index: number, step: RailStep) => {
    if (step.key === "finish") return isLast ? "current" : "locked";
    if (skippedSteps.has(step.key)) return "skipped";
    if (index === stepIndex) return "current";
    if (index < stepIndex) return "done";
    return "locked";
  };
  const memberSteps = isMember
    ? [
        <MemberWelcomeStep key="welcome" onSkipAll={requestSkip} />,
        <ApiKeyOptOutStep key="apikey" onSkipStep={goNext} />,
        <MemberConnectorStep key="connector" />,
        <SectionTourStep key="tour" onDone={goNext} />,
        <FinishStep
          key="finish"
          role="member"
          skippedSteps={skippedSteps}
          onFinish={() => finish.mutate()}
          pending={finish.isPending}
        />
      ]
    : [];

  return (
    <main className="onb" data-onb-role={isMember ? "member" : "founder"}>
      <aside className="onb__rail" aria-label="Onboarding progress">
        <div className="onb__brand">
          <span className="onb__mark" aria-hidden="true">
            J
          </span>
          <span className="onb__wordmark">{assistantName()}</span>
          <span className="onb__role">{roleLabel}</span>
        </div>
        <div className="onb__progresshd">
          <span className="lbl">{progressLabel}</span>
          <span className="ct">{isLast ? "Done" : `${completedCount} / ${progressTotal}`}</span>
        </div>
        <ul className="onb__steps">
          {rail.map((step, index) => {
            const state = railState(index, step);
            return (
              <li key={step.key}>
                <button
                  className={`onb__step is-${state}`}
                  disabled={state === "locked" || step.key === "finish"}
                  type="button"
                  onClick={() => setStepIndex(Math.min(index, stepCount - 1))}
                >
                  <span className="onb__step__dot">{dotContent(step, state)}</span>
                  <span className="onb__step__main">
                    <span className="onb__step__label">{step.label}</span>
                    {state === "current" ? (
                      <span className="onb__step__state">In progress</span>
                    ) : null}
                    {state === "skipped" ? (
                      <span className="onb__step__state is-skip">Skipped · set up later</span>
                    ) : null}
                  </span>
                  {step.optional && state !== "skipped" ? (
                    <span className="onb__step__opt">Optional</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="onb__rail-foot">
          {!isLast ? (
            <div className="onb__rail-actions">
              <button
                className="onb__rail-back"
                type="button"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              >
                <ArrowLeft size={15} /> Back
              </button>
              <button className="primary-button" type="button" onClick={continueStep}>
                {currentRailKey === "welcome" ? "Start setup" : "Continue"} <ArrowRight size={16} />
              </button>
              {optionalKeys.has(currentRailKey) ? (
                <button className="onb__rail-skipstep" type="button" onClick={skipCurrentStep}>
                  Skip this step
                </button>
              ) : null}
            </div>
          ) : null}
          <button className="onb__skipall" type="button" onClick={requestSkip}>
            <LogIn size={15} /> Skip setup
          </button>
          <p className="onb__skiphint">
            Skip setup and open the app. You can complete the configuration later in Settings.
          </p>
        </div>
      </aside>

      <section className="onb__stage" aria-label="Onboarding step">
        <div className="onb__mobilebar">
          <span className="onb__wordmark">{assistantName()}</span>
          <span className="onb__role">{roleLabel}</span>
          <span className="onb__mbar-prog">
            {isLast ? "Done" : `${completedCount} / ${progressTotal}`}
          </span>
          <button className="onb__mbar-skip" type="button" onClick={requestSkip}>
            Skip
          </button>
        </div>

        {statusQuery.isError ? (
          <p className="form-error">
            Couldn&apos;t refresh setup status. You can still skip and configure later.
          </p>
        ) : null}

        <div className="onb__content">
          {isMember ? (
            memberSteps[stepIndex]
          ) : (
            <>
              {currentKey === "welcome" ? <WelcomeStep onSkipAll={requestSkip} /> : null}
              {currentKey === "cliAuth" && founderSteps ? (
                <CliAuthStep step={founderSteps.cliAuth} onRecheck={invalidateStatus} />
              ) : null}
              {currentKey === "connectors" && founderSteps ? (
                <ConnectorStep done={founderSteps.connectors.done} />
              ) : null}
              {currentKey === "finish" ? (
                <FinishStep
                  role="founder"
                  skippedSteps={skippedSteps}
                  founderSteps={founderSteps}
                  onFinish={() => finish.mutate()}
                  pending={finish.isPending}
                />
              ) : null}
            </>
          )}
        </div>

        {!isLast ? (
          <footer className="onb-nav">
            <div className="onb-nav__inner">
              <button
                className="onb-nav__back"
                type="button"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              >
                <ArrowLeft size={15} /> Back
              </button>
              <span className="onb-nav__spacer" />
              {optionalKeys.has(currentRailKey) ? (
                <button className="onb-nav__skipstep" type="button" onClick={skipCurrentStep}>
                  Skip this step <span className="sub">· set up later</span>
                </button>
              ) : null}
              <button className="primary-button" type="button" onClick={continueStep}>
                {currentRailKey === "welcome" ? "Start setup" : "Continue"} <ArrowRight size={16} />
              </button>
            </div>
          </footer>
        ) : null}
      </section>

      {skipConfirmOpen ? (
        <SkipConfirmDialog
          onConfirm={confirmSkip}
          onCancel={() => setSkipConfirmOpen(false)}
          pending={skip.isPending}
        />
      ) : null}
    </main>
  );
}

export function FinishStep(props: {
  readonly role: "founder" | "member";
  readonly skippedSteps: ReadonlySet<string>;
  readonly founderSteps?: OnboardingStepsDto;
  readonly pending: boolean;
  readonly onFinish: () => void;
}) {
  const isMember = props.role === "member";
  const recap = isMember
    ? [
        { k: "Assistant", v: "Shared setup", mono: "ready" },
        props.skippedSteps.has("accounts")
          ? { k: "Accounts", v: "Skipped for now", skip: true }
          : { k: "Accounts", v: "Google integration", mono: "private" },
        { k: "Tour", v: "Tour finished" }
      ]
    : [
        {
          k: "Provider",
          v: "CLI provider",
          mono: props.founderSteps?.cliAuth.done ? "signed in" : "test later",
          skip: !props.founderSteps?.cliAuth.done
        },
        props.skippedSteps.has("connectors") || !props.founderSteps?.connectors.done
          ? { k: "Google", v: "Skipped for now", skip: true }
          : { k: "Google", v: "Connected", mono: "calendar · email" }
      ];

  return (
    <div className="onb-finish">
      <span className="onb-finish__mark">
        <Check size={30} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <div className="onb-eyebrow">{isMember ? "You’re set" : "You’re set up"}</div>
      <h1 className="onb-finish__title">
        {isMember ? "You’re all set." : personalize("Moss is ready.")}
      </h1>
      <p className="onb-finish__lede">
        {isMember
          ? personalize("Setup complete. You are ready to start using Moss.")
          : "Here is your setup summary. You can change any of these configurations later in Settings."}
      </p>
      <div className="onb-recap">
        {recap.map((item) => (
          <div className="onb-recap__row" key={item.k}>
            <span className={`onb-recap__ic ${item.skip ? "skip" : "ok"}`}>
              {item.skip ? (
                <Minus size={15} aria-hidden="true" />
              ) : (
                <Check size={15} aria-hidden="true" />
              )}
            </span>
            <span className="onb-recap__k">{item.k}</span>
            <span className="onb-recap__v">
              {item.v}
              {item.mono ? <span className="mono"> · {item.mono}</span> : null}
            </span>
          </div>
        ))}
      </div>
      <div className="onb-finish__cta">
        <button
          className="primary-button"
          type="button"
          disabled={props.pending}
          onClick={props.onFinish}
        >
          Finish setup <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="onb-signoff">
        {isMember ? personalize("Welcome to Moss.") : "Your setup is complete."}
      </div>
    </div>
  );
}
