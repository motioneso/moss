import { useState, type RefObject } from "react";

import { Button, Dialog, DisclosureToggle, InfoTip, RadioCardGroup, Segmented } from "@moss/ui";
import {
  CLASSIFIER_GATE_MODES,
  type AiConfiguredModelDto,
  type ClassifierGateMode
} from "@moss/shared";

export const GATE_LABELS: Readonly<Record<ClassifierGateMode, string>> = {
  off: "Off",
  shadow: "Watch only",
  on: "On"
};

/**
 * Pick the decision model. Nothing is preselected and no model is recommended. The Use in chat
 * setting sits in a fold and shows once a model is selected.
 */
export function DecisionModelDialog(props: {
  readonly models: readonly AiConfiguredModelDto[];
  readonly initialModelId: string | null;
  readonly initialGateMode: ClassifierGateMode;
  readonly gateTip: React.ReactNode;
  readonly saving: boolean;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onSave: (modelId: string, gateMode: ClassifierGateMode) => void;
  readonly onAskMoss: () => void;
  readonly onClose: () => void;
}) {
  const [modelId, setModelId] = useState<string | null>(props.initialModelId);
  const [gateMode, setGateMode] = useState<ClassifierGateMode>(props.initialGateMode);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <Dialog
      className="provdlg"
      title="Choose a decision model"
      onClose={props.onClose}
      closeLabel="Close"
      returnFocusRef={props.returnFocusRef}
      footer={
        <>
          <Button variant="link" onClick={props.onAskMoss}>
            Ask Moss to help me decide
          </Button>
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={modelId == null || props.saving}
            onClick={() => modelId && props.onSave(modelId, gateMode)}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="provdlg__body">
        <p className="rt__desc">
          Handles quick sorting and checking jobs. Every connected model is listed.
        </p>
        {props.models.length === 0 ? (
          <p className="rt__desc">No connected model can do this yet.</p>
        ) : (
          <RadioCardGroup
            name="decision-model"
            ariaLabel="Decision model"
            value={modelId}
            onChange={setModelId}
            options={props.models.map((model) => ({
              value: model.id,
              label: model.displayName,
              description: model.providerDisplayName
            }))}
          />
        )}
        {modelId ? (
          <div className="provdlg__group">
            <DisclosureToggle
              expanded={advancedOpen}
              controls="decision-advanced"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              Advanced: use in chat
            </DisclosureToggle>
            {advancedOpen ? (
              <div id="decision-advanced" className="provdlg__group">
                <span className="jds-label">
                  Use in chat <InfoTip label="What Use in chat does">{props.gateTip}</InfoTip>
                </span>
                <Segmented
                  value={gateMode}
                  ariaLabel="Use in chat"
                  onChange={setGateMode}
                  options={CLASSIFIER_GATE_MODES.map((mode) => ({
                    value: mode,
                    label: GATE_LABELS[mode]
                  }))}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
