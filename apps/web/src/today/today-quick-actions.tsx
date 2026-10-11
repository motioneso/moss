import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { localDay } from "@moss/shared";
import { Button, Dialog, Eyebrow, IconButton } from "@moss/ui";

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
  }

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
            <Eyebrow tone="accent" className="well__eyebrow">
              Quick actions
            </Eyebrow>
            <span className="well__title">Wellness</span>
          </div>
          <div className="well__row">
            <div className="well__rowtext">
              <div className="well__label">
                Medications
                {medCountLine ? <span className="well__count">{medCountLine}</span> : null}
              </div>
            </div>
            <IconButton
              ref={medsOpener}
              size="sm"
              aria-label="Log medication"
              onClick={(event) => openMedsModal(event.currentTarget)}
            >
              +
            </IconButton>
          </div>
          <div className="well__row">
            <div className="well__rowtext">
              <div className="well__label">Check in with yourself</div>
              <div className="well__sub">A moment to notice how you are.</div>
            </div>
            <Button size="sm" onClick={() => setCheckinModalOpen(true)}>
              Check in
            </Button>
          </div>
        </div>
      ) : null}
      <ModuleTodayWidgets slot="quick-actions" disabledModuleIds={props.disabledModuleIds} />
      {props.enabled && medsModalOpen ? (
        <Dialog
          title={<span id="today-meds-title">Medications</span>}
          closeLabel="Close"
          aria-labelledby="today-meds-title"
          description="Today"
          onClose={closeMedsModal}
          initialFocusRef={medsClose}
          returnFocusRef={medsOpener}
          footer={
            <Button ref={medsClose} size="sm" onClick={closeMedsModal}>
              Done
            </Button>
          }
        >
          <MedToday
            theme={props.theme}
            onManage={() => {
              closeMedsModal();
              setManageMedsOpen(true);
            }}
            timeZone={props.timeZone}
          />
        </Dialog>
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
          onSave={(val) => createCheckinMutation.mutateAsync(val)}
          initial={null}
          seedEmotion={null}
          theme={props.theme}
        />
      ) : null}
    </>
  );
}
