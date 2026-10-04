import { useEffect, useRef, useState } from "react";

import { Badge, Button, Dialog } from "@moss/ui";

import type { LocaleSettingsDto } from "@moss/shared";

import { formatDate } from "../locale/locale-format.js";
import type { ActivityBadge } from "./settings-activity-line.js";
import { failureSentence } from "./settings-activity-line.js";
import { assistantName } from "../api/use-assistant-name.js";

export interface ActivityDialogStep {
  readonly key: string;
  /** "tool action", "model call", "Jev check" or "answer" (spec 3.3 eyebrow). */
  readonly kindLabel: string;
  readonly title: string;
  readonly result: string;
  readonly meta: string | null;
  readonly failed: boolean;
  readonly failureCode: string | null;
  readonly failureService?: string;
  /** dl rows beyond Asked for / Returned, in display order. */
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly askedFor: string | null;
  readonly returned: string | null;
}

export interface ActivityDialogData {
  readonly title: string;
  readonly statusText: string;
  readonly statusTone: ActivityBadge["tone"];
  readonly badges: readonly ActivityBadge[];
  readonly meta: string;
  readonly quote: string | null;
  readonly steps: readonly ActivityDialogStep[];
  /** ISO expiry of the quoted words; null once expired. The note shows only while set. */
  readonly expiresAt: string | null;
}

function expiryNote(expiresAt: string, locale: LocaleSettingsDto): string {
  const day = formatDate(expiresAt, locale, { day: "numeric", month: "long" });
  return `${assistantName()} deletes the quoted words and step details on ${day}. The line itself stays.`;
}

export function ActivityDialog(props: {
  readonly data: ActivityDialogData;
  readonly locale: LocaleSettingsDto;
  readonly onClose: () => void;
}) {
  const { data, locale, onClose } = props;
  const initialIndex = Math.max(
    data.steps.findIndex((step) => step.failed),
    0
  );
  const [selected, setSelected] = useState(initialIndex);
  const stepRefs = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const step = data.steps[selected];
  const select = (index: number, focus: boolean) => {
    setSelected(index);
    if (focus) stepRefs.current.get(index)?.focus();
  };

  return (
    <Dialog
      className="act-dialog"
      onClose={onClose}
      aria-labelledby="act-dialog-title"
      title={
        <div className="act-dialog__heading">
          <div className="act-dialog__titlerow">
            <Badge tone={data.statusTone}>{data.statusText}</Badge>
            {data.badges.map((badge) => (
              <Badge key={badge.text} tone={badge.tone}>
                {badge.text}
              </Badge>
            ))}
            <span id="act-dialog-title">{data.title}</span>
          </div>
          <div className="act-line__meta">{data.meta}</div>
          {data.quote && <blockquote className="act-quote">{data.quote}</blockquote>}
        </div>
      }
      description={
        <Button variant="quiet" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {data.steps.length === 0 ? (
        <p className="act-pane__empty">No step details recorded.</p>
      ) : (
        <>
          <ol className="act-steps" role="listbox" aria-label="Steps">
            {data.steps.map((item, index) => (
              <li
                key={item.key}
                ref={(node) => {
                  if (node) stepRefs.current.set(index, node);
                  else stepRefs.current.delete(index);
                }}
                className="act-step"
                role="option"
                aria-selected={index === selected}
                tabIndex={index === selected ? 0 : -1}
                style={{ order: index * 2 }}
                onClick={() => select(index, false)}
                onKeyDown={(event) => {
                  const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  if (delta !== 0 && data.steps[index + delta]) {
                    event.preventDefault();
                    select(index + delta, true);
                  }
                }}
              >
                <span className="act-step__n">{index + 1}</span>
                <span className="act-step__text">
                  <span className="act-step__title">{item.title}</span>
                  <span>{item.result}</span>
                  {item.meta && <span className="act-step__meta">{item.meta}</span>}
                </span>
              </li>
            ))}
          </ol>
          {step && (
            <div className="act-pane" style={{ order: selected * 2 + 1 }}>
              <div>
                <span className="jds-eyebrow">
                  Step {selected + 1} of {data.steps.length} - {step.kindLabel}
                </span>
                <h2 className="act-pane__title">{step.title}</h2>
              </div>
              {step.failed && (
                <div className="act-why">
                  <b>Why it did not work</b>
                  <span>{failureSentence(step.failureCode, step.failureService)}</span>
                </div>
              )}
              <dl className="act-facts">
                {step.facts.map(([label, value]) => (
                  <div className="act-facts__row" key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                {step.askedFor !== null && step.askedFor !== undefined && (
                  <div className="act-facts__row">
                    <dt>Asked for</dt>
                    <dd>{step.askedFor}</dd>
                  </div>
                )}
                {step.returned !== null && step.returned !== undefined && (
                  <div className="act-facts__row">
                    <dt>Returned</dt>
                    <dd>{step.returned}</dd>
                  </div>
                )}
              </dl>
              {data.expiresAt && <p className="act-expiry">{expiryNote(data.expiresAt, locale)}</p>}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
