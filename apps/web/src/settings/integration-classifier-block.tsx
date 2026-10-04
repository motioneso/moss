import { useId, useState } from "react";
import { useNavigate } from "react-router";

import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE as DISCLOSURE,
  type IntegrationDetail
} from "@moss/shared";
import { Button, Card, Eyebrow } from "@moss/ui";

import { formatDate, useUserLocale } from "../locale/locale-format";
import {
  classifierBlockState,
  failureLine,
  failureNeedsModel,
  sortingLine,
  toolCount,
  type ClassifierBlockState
} from "./integration-classifier-state";
import { Badge, Row, Switch } from "./settings-ui";

/* The Connection panel's sorting line and the Classifier panel beside the tools (#2984 R2.5b). */

const DISCLOSURE_ITEMS: readonly (readonly [string, string])[] = [
  ["What is sent", DISCLOSURE.sent],
  ["Who reads it", DISCLOSURE.provider],
  ["What it costs", DISCLOSURE.cost],
  ["Not sent", DISCLOSURE.excluded]
];

/** Where the owner changes their default chat model. */
export const DEFAULT_MODEL_PATH = "/settings?section=assistant";

function Disclosure(props: { readonly id?: string }) {
  return (
    <ul className="jds-caption intg-clsf__disclosure" id={props.id}>
      {DISCLOSURE_ITEMS.map(([label, text]) => (
        <li key={label}>
          <b>{label}.</b> {text}
        </li>
      ))}
    </ul>
  );
}

export function IntegrationSortingLine(props: {
  readonly detail: IntegrationDetail;
  readonly onRetry: () => void;
}) {
  const locale = useUserLocale();
  const line = sortingLine(props.detail, (iso) =>
    formatDate(iso, locale, { day: "numeric", month: "long" })
  );
  if (!line.text && line.failed === 0) return null;
  return (
    <div className="intg-clsf__sorting">
      {line.text ? <p className="jds-caption">{line.text}</p> : null}
      {line.failed > 0 ? (
        <Button variant="link" size="sm" onClick={props.onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function IntegrationClassifierBlock(props: {
  readonly detail: IntegrationDetail;
  readonly onSetEnabled: (on: boolean) => void;
  readonly onRetry: () => void;
}) {
  const { detail } = props;
  const [confirming, setConfirming] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const disclosureId = useId();
  const state = classifierBlockState(detail);
  const on = detail.classifierEnabled;

  const onSwitch = (next: boolean) => {
    if (next) {
      setConfirming(true);
      return;
    }
    setShowDisclosure(false);
    props.onSetEnabled(false);
  };

  const turnOn = () => {
    setConfirming(false);
    props.onSetEnabled(true);
  };

  return (
    <section className="intg-clsf" aria-label="Classifier">
      <Eyebrow>Classifier</Eyebrow>
      <Row
        name="Let the classifier use this connection"
        desc="Quick requests can skip your default model and run a tool directly."
        control={
          <Switch
            ariaLabel="Let the classifier use this connection"
            checked={on || confirming}
            disabled={confirming}
            onChange={onSwitch}
          />
        }
      />
      <div className="intg-clsf__state">
        {confirming && !on ? (
          <Card sunken padding="sm" role="group" aria-label="Turn on the classifier">
            <div className="intg-clsf__state">
              <p className="pane__desc">
                <b>Prepare {toolCount(state.total)} for the classifier?</b>
              </p>
              <p className="pane__desc">
                Moss reads each tool once so quick requests can run it directly. Every tool you have
                on stays on, and risky ones still ask before they run.
              </p>
              <Disclosure />
              <span className="intg__acts">
                <Button size="sm" onClick={turnOn}>
                  Turn on and prepare
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </span>
            </div>
          </Card>
        ) : (
          <ClassifierStateBody detail={detail} state={state} onRetry={props.onRetry} />
        )}
      </div>
      {on ? (
        <div className="intg-clsf__foot">
          <Button
            variant="link"
            size="sm"
            aria-expanded={showDisclosure}
            aria-controls={disclosureId}
            onClick={() => setShowDisclosure(!showDisclosure)}
          >
            What is sent, and what it costs
          </Button>
          {showDisclosure ? <Disclosure id={disclosureId} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function ClassifierStateBody(props: {
  readonly detail: IntegrationDetail;
  readonly state: ClassifierBlockState;
  readonly onRetry: () => void;
}) {
  const { detail, state } = props;
  const locale = useUserLocale();
  const navigate = useNavigate();

  switch (state.kind) {
    case "off":
      return (
        <>
          <p className="pane__desc">
            Off. Quick requests to {detail.name} go through your default model.
          </p>
          <p className="jds-caption">
            Turning it on prepares all {toolCount(state.total)} once. You will see what is sent
            first.
          </p>
        </>
      );
    case "paused":
      return (
        <>
          <span>
            <Badge pill>Paused</Badge>
          </span>
          <p className="pane__desc">
            {detail.name} can't be reached, so the classifier skips it. It picks up again by itself
            when the connection is back.
          </p>
        </>
      );
    case "preparing": {
      const percent = state.total === 0 ? 0 : Math.round((state.ready / state.total) * 100);
      return (
        <>
          <p className="intg-clsf__status">
            <Badge pill dot tone="amber">
              Preparing
            </Badge>
            <span className="pane__desc">
              {state.ready} of {toolCount(state.total)}
            </span>
          </p>
          <div
            className="jds-progress"
            role="progressbar"
            aria-label="Preparing tools"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.ready}
          >
            <div className="jds-progress__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="pane__desc">
            You can leave this page. Until it finishes, quick requests go through your default
            model.
          </p>
        </>
      );
    }
    case "ready":
    case "changed": {
      const asks = state.alwaysAsk === 1 ? "always asks" : "always ask";
      const again = state.preparingAgain;
      return (
        <>
          <span>
            <Badge pill dot tone="forest">
              Ready
            </Badge>
          </span>
          <p className="pane__desc">
            <b>
              {state.ready} of {toolCount(state.total)}
            </b>{" "}
            can answer quick requests.
            {state.alwaysAsk > 0 ? (
              <>
                {" "}
                <b>{state.alwaysAsk}</b> {asks} you before they run.
              </>
            ) : null}
          </p>
          {state.alwaysAsk > 0 ? <p className="jds-caption">YOLO mode skips the asking.</p> : null}
          {state.kind === "changed" ? (
            <p className="pane__desc">
              <b>{toolCount(again)} changed</b>{" "}
              {again === 1
                ? "and is being prepared again. It goes through your default model until then."
                : "and are being prepared again. They go through your default model until then."}
            </p>
          ) : state.preparedAt ? (
            <p className="jds-caption">
              Prepared on {formatDate(state.preparedAt, locale, { day: "numeric", month: "long" })}{" "}
              by your default chat model.
            </p>
          ) : null}
        </>
      );
    }
    case "failed":
      return (
        <>
          <span>
            <Badge pill dot tone="red">
              Couldn't prepare
            </Badge>
          </span>
          <p className="pane__desc">
            {failureLine(state)} Quick requests go through your default model meanwhile.
          </p>
          <span className="intg__acts">
            <Button variant="secondary" size="sm" onClick={props.onRetry}>
              Try again
            </Button>
            {failureNeedsModel(state) ? (
              <Button variant="quiet" size="sm" onClick={() => void navigate(DEFAULT_MODEL_PATH)}>
                Change default model
              </Button>
            ) : null}
          </span>
        </>
      );
    case "none":
      return (
        <p className="pane__desc">
          No tool you have on is left for the classifier, so quick requests go through your default
          model.
        </p>
      );
  }
}
