import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { localDay, type MedicationDto } from "@moss/shared";
import { Switch } from "@moss/ui";
import { describeSchedule, nextDoses } from "@moss/wellness/schedule-summary";
import { formatDateTime, useUserLocale } from "../locale/locale-format";
import { createMedication, listMedications, updateMedication } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { medColor, type Theme } from "./emotion-taxonomy";
import {
  MAX_DOSES_PER_DAY,
  MONTH_POSITION_LABELS,
  SCHEDULE_CHOICES,
  WEEKDAY_LABELS,
  buildCreateRequest,
  describeFormProblems,
  emptyMedForm,
  isValidClockTime,
  medFormFromMedication,
  previewMedication,
  startDateRequired,
  supportsReminders,
  usesClockTimes,
  usesWeekdays,
  withChoice,
  type IntervalUnit,
  type MedFormState,
  type MonthKind
} from "./medication-schedule-form";

function XIcon() {
  return (
    <svg
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
function Trash2Icon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Options for one upcoming dose, written the way it reads in the preview: "Mon 1 Sep, 08:00". */
const DOSE_TIME_OPTS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
};

interface Props {
  open: boolean;
  onClose: () => void;
  theme?: Theme;
}

export function ManageMedsModal({ open, onClose, theme = "light" }: Props) {
  const queryClient = useQueryClient();
  // #579: dates render and bucket in the user's *persisted* zone, never the browser's ambient one.
  const locale = useUserLocale();
  const timeZone = locale.timezone;
  const [form, setForm] = useState<MedFormState>(() =>
    emptyMedForm(localDay(new Date(), timeZone))
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  const patch = (changes: Partial<MedFormState>) =>
    setForm((current) => ({ ...current, ...changes }));

  const startEdit = (m: MedicationDto) => {
    setEditingId(m.id);
    setForm(medFormFromMedication(m));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyMedForm(localDay(new Date(), timeZone)));
  };

  const problems = describeFormProblems(form);

  // The preview is computed from form state alone — no network, no debounce — so the sentence
  // and the next three doses always match what the add button would send.
  const preview = useMemo(() => {
    // The sentence describes the schedule, which does not depend on the name, so a not-yet-named
    // medication still gets a preview. Everything else has to be answerable before we can show it.
    const named = { ...form, name: form.name.trim() ? form.name : "Medication" };
    if (describeFormProblems(named).length > 0) return null;
    const medication = previewMedication(named, timeZone);
    return { sentence: describeSchedule(medication), doses: nextDoses(medication, new Date(), 3) };
  }, [form, timeZone]);

  const setTimeAt = (index: number, value: string) =>
    setForm((current) => {
      const times = [...current.times];
      times[index] = value;
      return { ...current, times };
    });

  const addTime = () =>
    setForm((current) =>
      current.times.length >= MAX_DOSES_PER_DAY
        ? current
        : { ...current, times: [...current.times, "12:00"] }
    );

  const removeTime = (index: number) =>
    setForm((current) =>
      current.times.length <= 1
        ? current
        : { ...current, times: current.times.filter((_, i) => i !== index) }
    );

  const toggleWeekday = (day: number) =>
    setForm((current) => ({
      ...current,
      weekdays: current.weekdays.includes(day)
        ? current.weekdays.filter((d) => d !== day)
        : [...current.weekdays, day].sort((a, b) => a - b)
    }));

  const medsQuery = useQuery({
    queryKey: queryKeys.wellness.medications,
    queryFn: listMedications,
    enabled: open
  });

  const addMutation = useMutation({
    mutationFn: () => createMedication(buildCreateRequest(form)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.medications });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "schedule"] });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "adherence-summary"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
      setForm(emptyMedForm(localDay(new Date(), timeZone)));
    }
  });
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => updateMedication(id, { active: false }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.medications });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "schedule"] });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "adherence-summary"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
      if (id === editingId) cancelEdit();
    }
  });
  const updateScheduleMutation = useMutation({
    mutationFn: (id: string) => updateMedication(id, buildCreateRequest(form)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.medications });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "schedule"] });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "adherence-summary"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
      cancelEdit();
    }
  });

  if (!open) return null;

  const meds = (medsQuery.data?.medications ?? []).filter((m) => m.active);

  return (
    <div
      className="wl-modal-scrim"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="wl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meds-modal-title"
        style={{ maxWidth: 540 }}
      >
        <div className="wl-modal__head">
          <div className="hm">
            <div className="wl-modal__eyebrow">Settings</div>
            <div className="wl-modal__title" id="meds-modal-title">
              Manage medications
            </div>
          </div>
          <button type="button" className="wl-modal__x" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <div className="wl-modal__body">
          <div className="wl-medlist" style={{ marginBottom: 8 }}>
            {meds.map((m, i) => {
              const c = medColor(i, theme);
              return (
                <div
                  key={m.id}
                  className="wl-medrow"
                  style={{ "--em-tint": c.tint, cursor: "default" } as React.CSSProperties}
                >
                  <span className="wl-medrow__dot" />
                  <span className="wl-medrow__main">
                    <span className="wl-medrow__name">{m.name}</span>
                    <span className="wl-medrow__sub">
                      {m.dosage ? <span className="dose">{m.dosage}</span> : null}
                      {m.dosage ? " · " : ""}
                      {m.frequencyType === "as_needed"
                        ? "as needed"
                        : m.frequencyType.replace(/_/g, " ")}
                    </span>
                  </span>
                  {m.frequencyType !== "every_n_hours" ? (
                    <button
                      type="button"
                      className="wl-tnote__x"
                      style={{ opacity: 1 }}
                      aria-label={`Edit ${m.name}`}
                      onClick={() => startEdit(m)}
                    >
                      <PencilIcon />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="wl-tnote__x"
                    style={{ opacity: 1 }}
                    aria-label={`Remove ${m.name}`}
                    onClick={() => deactivateMutation.mutate(m.id)}
                  >
                    <Trash2Icon />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="wl-medmodal__addsection" style={{ paddingTop: 14, marginTop: 4 }}>
            <div className="wl-hdetail__lbl" style={{ marginBottom: 10 }}>
              {editingId ? "Edit medication" : "Add a medication"}
            </div>

            <div className="wl-medform__row2">
              <input
                placeholder="Name (e.g. Bupropion)"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                aria-label="Medication name"
                className="wl-medmodal__input"
              />
              <input
                placeholder="Dose (e.g. 50 mg)"
                value={form.dose}
                onChange={(e) => patch({ dose: e.target.value })}
                aria-label="Dose"
                className="wl-medmodal__input"
              />
            </div>

            <div className="wl-medform__field">
              <div className="wl-hdetail__lbl">Schedule</div>
              <div className="wl-medform__choices">
                {SCHEDULE_CHOICES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={form.choice === option.value}
                    onClick={() =>
                      setForm((current) =>
                        withChoice(current, option.value, localDay(new Date(), timeZone))
                      )
                    }
                    className={`wl-freqbtn${form.choice === option.value ? " wl-freqbtn--active" : ""}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="wl-medform__hint">
                {SCHEDULE_CHOICES.find((option) => option.value === form.choice)?.hint}
              </div>
            </div>

            {form.choice === "every_interval" ? (
              <div className="wl-medform__field">
                <div className="wl-hdetail__lbl">How often it repeats</div>
                <div className="wl-medform__inline">
                  <span className="wl-fs13">Every</span>
                  <input
                    type="number"
                    min={1}
                    aria-label="How many days, weeks or months between doses"
                    className="wl-medmodal__input wl-medform__num"
                    value={Number.isInteger(form.intervalCount) ? form.intervalCount : ""}
                    onChange={(e) => patch({ intervalCount: Number.parseInt(e.target.value, 10) })}
                  />
                  <div className="wl-medform__choices">
                    {(["days", "weeks", "months"] as const).map((unit) => (
                      <button
                        key={unit}
                        type="button"
                        aria-pressed={form.intervalUnit === unit}
                        onClick={() => patch({ intervalUnit: unit as IntervalUnit })}
                        className={`wl-freqbtn${form.intervalUnit === unit ? " wl-freqbtn--active" : ""}`}
                      >
                        {unit}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {form.choice === "monthly" ? (
              <div className="wl-medform__field">
                <div className="wl-hdetail__lbl">Which day of the month</div>
                <div className="wl-medform__choices">
                  {(
                    [
                      ["date", "On a date"],
                      ["weekdayPosition", "On a weekday"]
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={form.monthKind === kind}
                      onClick={() => patch({ monthKind: kind as MonthKind })}
                      className={`wl-freqbtn${form.monthKind === kind ? " wl-freqbtn--active" : ""}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {form.monthKind === "date" ? (
                  <div className="wl-medform__inline">
                    <input
                      type="number"
                      min={1}
                      max={31}
                      disabled={form.monthDayIsLast}
                      aria-label="Day of the month"
                      className="wl-medmodal__input wl-medform__num"
                      value={Number.isInteger(form.monthDay) ? form.monthDay : ""}
                      onChange={(e) => patch({ monthDay: Number.parseInt(e.target.value, 10) })}
                    />
                    <label className="wl-medform__check">
                      <input
                        type="checkbox"
                        aria-label="Last day of the month"
                        checked={form.monthDayIsLast}
                        onChange={(e) => patch({ monthDayIsLast: e.target.checked })}
                      />
                      <span className="wl-fs13">Last day of the month</span>
                    </label>
                  </div>
                ) : (
                  <div className="wl-medform__stack">
                    <div className="wl-medform__choices">
                      {MONTH_POSITION_LABELS.map((position) => (
                        <button
                          key={position.value}
                          type="button"
                          aria-pressed={form.monthWeekdayPosition === position.value}
                          onClick={() => patch({ monthWeekdayPosition: position.value })}
                          className={`wl-freqbtn${form.monthWeekdayPosition === position.value ? " wl-freqbtn--active" : ""}`}
                        >
                          {position.label}
                        </button>
                      ))}
                    </div>
                    <div className="wl-medform__choices">
                      {WEEKDAY_LABELS.map((day) => (
                        <button
                          key={day.value}
                          type="button"
                          aria-label={day.long}
                          aria-pressed={form.monthWeekday === day.value}
                          onClick={() => patch({ monthWeekday: day.value })}
                          className={`wl-freqbtn${form.monthWeekday === day.value ? " wl-freqbtn--active" : ""}`}
                        >
                          {day.short}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {form.choice === "cycle" ? (
              <div className="wl-medform__field">
                <div className="wl-hdetail__lbl">Days on, then days off</div>
                <div className="wl-medform__inline">
                  <input
                    type="number"
                    min={1}
                    aria-label="Days on"
                    className="wl-medmodal__input wl-medform__num"
                    value={Number.isInteger(form.cycleDaysOn) ? form.cycleDaysOn : ""}
                    onChange={(e) => patch({ cycleDaysOn: Number.parseInt(e.target.value, 10) })}
                  />
                  <span className="wl-fs13">days on, then</span>
                  <input
                    type="number"
                    min={0}
                    aria-label="Days off"
                    className="wl-medmodal__input wl-medform__num"
                    value={Number.isInteger(form.cycleDaysOff) ? form.cycleDaysOff : ""}
                    onChange={(e) => patch({ cycleDaysOff: Number.parseInt(e.target.value, 10) })}
                  />
                  <span className="wl-fs13">days off</span>
                </div>
              </div>
            ) : null}

            {usesWeekdays(form) ? (
              <div className="wl-medform__field">
                <div className="wl-hdetail__lbl">Days of the week</div>
                <div className="wl-medform__choices">
                  {WEEKDAY_LABELS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      aria-label={day.long}
                      aria-pressed={form.weekdays.includes(day.value)}
                      onClick={() => toggleWeekday(day.value)}
                      className={`wl-freqbtn${form.weekdays.includes(day.value) ? " wl-freqbtn--active" : ""}`}
                    >
                      {day.short}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {usesClockTimes(form.choice) ? (
              <div className="wl-medform__field">
                <div className="wl-hdetail__lbl">
                  {form.times.length > 1 ? "Times of day" : "Time of day"}
                </div>
                <div className="wl-medform__times">
                  {form.times.map((time, index) => (
                    <div key={index} className="wl-medform__timerow">
                      <input
                        type="time"
                        value={time}
                        onChange={(e) => setTimeAt(index, e.target.value)}
                        aria-label={`Dose time ${index + 1}`}
                        className={`wl-medmodal__timeinput${
                          !isValidClockTime(time) && time !== ""
                            ? " wl-medmodal__timeinput--invalid"
                            : ""
                        }`}
                      />
                      {form.times.length > 1 ? (
                        <button
                          type="button"
                          className="wl-tnote__x"
                          style={{ opacity: 1 }}
                          aria-label={`Remove dose time ${index + 1}`}
                          onClick={() => removeTime(index)}
                        >
                          <Trash2Icon />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
                {form.times.length < MAX_DOSES_PER_DAY ? (
                  <button
                    type="button"
                    className="ghost-button wl-fs13"
                    style={{ gap: 6, padding: "4px 12px", minHeight: "unset" }}
                    onClick={addTime}
                  >
                    <PlusIcon />
                    Add another time
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="wl-subtle-text" style={{ marginTop: 10, fontStyle: "italic" }}>
                As-needed medications have no fixed schedule.
              </div>
            )}

            <div className="wl-medform__field">
              <div className="wl-hdetail__lbl">
                {startDateRequired(form.choice) ? "Starts on" : "Starts on (optional)"}
              </div>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => patch({ startDate: e.target.value })}
                aria-label="Start date"
                className="wl-medmodal__input wl-medform__date"
              />
            </div>

            {supportsReminders(form.choice) ? (
              <div className="wl-medform__field wl-medform__switchrow">
                <span className="wl-hdetail__lbl">Remind me when a dose is due</span>
                <Switch
                  ariaLabel="Remind me when a dose is due"
                  checked={form.remindersEnabled}
                  onChange={(checked) => patch({ remindersEnabled: checked })}
                />
              </div>
            ) : null}

            <div className="wl-medform__preview">
              <div className="wl-hdetail__lbl">What this means</div>
              {preview ? (
                <>
                  <div className="wl-medform__previewline">{preview.sentence}</div>
                  {preview.doses.length > 0 ? (
                    <div className="wl-medform__previewdoses">
                      {`Next: ${preview.doses.map((dose) => formatDateTime(dose, locale, DOSE_TIME_OPTS)).join(" · ")}`}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="wl-subtle-text">
                  Finish filling this in to see what the schedule works out to.
                </div>
              )}
            </div>

            <div className="wl-medform__actions">
              <button
                type="button"
                className="secondary-button wl-fs13"
                style={{ gap: 6, padding: "6px 14px", minHeight: "unset" }}
                disabled={
                  problems.length > 0 || addMutation.isPending || updateScheduleMutation.isPending
                }
                onClick={() =>
                  editingId ? updateScheduleMutation.mutate(editingId) : addMutation.mutate()
                }
              >
                <PlusIcon />
                {editingId ? "Save changes" : "Add medication"}
              </button>
              {editingId ? (
                <button
                  type="button"
                  className="ghost-button wl-fs13"
                  style={{ padding: "6px 14px", minHeight: "unset" }}
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
              ) : null}
              {problems.length > 0 ? (
                <span className="wl-medmodal__error">{problems[0]}</span>
              ) : addMutation.isError || updateScheduleMutation.isError ? (
                // Without this a rejected request looks like a dead button: the modal stays put,
                // the form keeps its values, and nothing on screen says the save did not happen.
                <span className="wl-medmodal__error">
                  That did not save. Check the details and try again.
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="wl-modal__foot">
          <span className="spacer" />
          <button type="button" className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
