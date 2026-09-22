import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { localDay } from "@moss/shared";

import { createWellnessCheckin, getMedicationSchedule } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import type { ColorMode } from "../theme/color-mode.js";
import { MedToday } from "../wellness/wellness-today.js";
import { ManageMedsModal } from "../wellness/manage-meds-modal.js";
import { CheckinModal, type CheckinFormValue } from "../wellness/checkin-modal.js";
import { ModuleTodayWidgets } from "./module-today-widgets.js";

export interface TodayQuickActionsProps {
  readonly enabled: boolean;
  readonly theme: ColorMode;
  readonly timeZone: string;
  readonly disabledModuleIds: readonly string[];
}

/** Wellness rail block, its dialogs, and the module quick-actions slot. */
export function TodayQuickActions(props: TodayQuickActionsProps) {
  const queryClient = useQueryClient();
  const [medsModalOpen, setMedsModalOpen] = useState(false);
  const [manageMedsOpen, setManageMedsOpen] = useState(false);
  const [checkinModalOpen, setCheckinModalOpen] = useState(false);
  const medsOpener = useRef<HTMLButtonElement | null>(null);
  const medsClose = useRef<HTMLButtonElement | null>(null);
  const medScheduleQuery = useQuery({
    queryKey: queryKeys.wellness.schedule(localDay(new Date(), props.timeZone)),
    queryFn: () => getMedicationSchedule(localDay(new Date(), props.timeZone)),
    enabled: props.enabled
  });
  const medScheduledSlots = (medScheduleQuery.data?.slots ?? []).filter((s) => !s.asNeeded);
  const medTaken = medScheduledSlots.filter((s) => s.status === "taken").length;
  const medTotal = medScheduledSlots.length;
  const medsAllTaken = medTotal > 0 && medTaken === medTotal;
  const medCountLine =
    medTotal === 0
      ? null
      : medsAllTaken
        ? `All ${medTotal} logged`
        : `${medTaken} of ${medTotal} logged`;

  function openMedsModal(opener: HTMLButtonElement | null) {
    medsOpener.current = opener;
    setMedsModalOpen(true);
  }

  function closeMedsModal() {
    setMedsModalOpen(false);
    medsOpener.current?.focus();
  }

  useEffect(() => {
    if (!medsModalOpen) return;
    medsClose.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMedsModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [medsModalOpen]);
  const createCheckinMutation = useMutation({
    mutationFn: (val: CheckinFormValue) =>
      createWellnessCheckin({
        feelingCore: val.emotion,
        feelingSecondary: val.feeling,
        feelingTertiary: null,
        sensations: val.sensations,
        intensity: val.intensity,
        note: val.note || null,
        identifiedVia: "wheel"
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.checkins });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
      setCheckinModalOpen(false);
    }
  });

  return (
    <>
      {props.enabled ? (
        <div className="well">
          <div className="well__head">
            <span className="well__eyebrow">Quick actions</span>
            <span className="well__title">Wellness</span>
          </div>
          <div className="well__row">
            <div className="well__rowtext">
              <div className="well__label">
                Medications
                {medCountLine ? <span className="well__count">{medCountLine}</span> : null}
              </div>
            </div>
            <button
              type="button"
              ref={medsOpener}
              className="well__plus"
              aria-label="Log medication"
              onClick={(event) => openMedsModal(event.currentTarget)}
            >
              +
            </button>
          </div>
          <div className="well__row">
            <div className="well__rowtext">
              <div className="well__label">Check in with yourself</div>
              <div className="well__sub">A moment to notice how you are.</div>
            </div>
            <button
              className="well__btn well__btn--primary"
              onClick={() => setCheckinModalOpen(true)}
            >
              Check in
            </button>
          </div>
        </div>
      ) : null}
      <ModuleTodayWidgets slot="quick-actions" disabledModuleIds={props.disabledModuleIds} />
      {props.enabled && medsModalOpen ? (
        <div
          className="wl-modal-scrim"
          onMouseDown={(ev) => {
            if (ev.target !== ev.currentTarget) return;
            // Cancel the mousedown default so it cannot pull focus off the
            // opener the close function just focused (the scrim is not focusable).
            ev.preventDefault();
            closeMedsModal();
          }}
        >
          <div
            className="wl-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="today-meds-title"
            style={{ maxWidth: 480 }}
          >
            <div className="wl-modal__head">
              <div className="hm">
                <div className="wl-modal__eyebrow">Today</div>
                <div className="wl-modal__title" id="today-meds-title">
                  Medications
                </div>
              </div>
              <button
                type="button"
                ref={medsClose}
                className="wl-modal__x"
                aria-label="Close"
                onClick={() => closeMedsModal()}
              >
                <XIcon />
              </button>
            </div>
            <div className="wl-modal__body" style={{ padding: "0 0 8px" }}>
              <MedToday
                theme={props.theme}
                onManage={() => {
                  closeMedsModal();
                  setManageMedsOpen(true);
                }}
                timeZone={props.timeZone}
              />
            </div>
            <div className="wl-modal__foot">
              <span className="spacer" />
              <button type="button" className="primary-button" onClick={() => closeMedsModal()}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {props.enabled ? (
        <ManageMedsModal
          open={manageMedsOpen}
          onClose={() => setManageMedsOpen(false)}
          theme={props.theme}
        />
      ) : null}

      {props.enabled ? (
        <CheckinModal
          open={checkinModalOpen}
          onClose={() => setCheckinModalOpen(false)}
          onSave={(val) => createCheckinMutation.mutate(val)}
          initial={null}
          seedEmotion={null}
          theme={props.theme}
        />
      ) : null}
    </>
  );
}

function XIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
