import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  EMOTIONS,
  localDay,
  moodIndex,
  moodBand,
  type CheckinDto,
  type ScheduleSlotDto
} from "@moss/shared";
import { formatClockTime, useUserLocale } from "../locale/locale-format.js";
import { getMedicationSchedule, logMedicationDose } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { emoColor, coreLabel, type WellnessEmotionCore, type Theme } from "./emotion-taxonomy.js";

// Common quick-pick reasons for an as-needed dose. The user can pick one or type their own;
// the chosen text is what gets stored (no placeholder is ever submitted).
const PRN_REASONS = ["Pain", "Anxiety", "Nausea", "Headache", "Trouble sleeping"] as const;

/* ─── Icons ─── */
function PillIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </svg>
  );
}
function HeartPulseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function SunriseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2v8" />
      <path d="m4.93 10.93 1.41 1.41" />
      <path d="M2 18h2" />
      <path d="M20 18h2" />
      <path d="m19.07 10.93-1.41 1.41" />
      <path d="M22 22H2" />
      <path d="m16 6-4 4-4-4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}
function FlameIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}
function Settings2Icon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  );
}
function ClipboardCheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}

/* ─── MedToday card ─── */
interface MedTodayProps {
  theme: Theme;
  onManage: () => void;
  timeZone?: string;
}

/** The dose's clock time ("HH:MM") in the medication's own zone; older payloads fall back to the UTC clock. */
export function slotClock(slot: Pick<ScheduleSlotDto, "scheduledFor" | "localTime">): string {
  return slot.localTime ?? (slot.scheduledFor ? slot.scheduledFor.slice(11, 16) : "");
}

function MedToday({ theme: _theme, onManage, timeZone }: MedTodayProps) {
  const date = localDay(new Date(), timeZone);
  const locale = useUserLocale();
  const queryClient = useQueryClient();

  const scheduleQuery = useQuery({
    queryKey: queryKeys.wellness.schedule(date),
    queryFn: () => getMedicationSchedule(date)
  });

  const logMutation = useMutation({
    mutationFn: (input: {
      medicationId: string;
      status: "taken" | "skipped" | "prn";
      scheduledFor: string | null;
      prnReason?: string | null;
    }) =>
      logMedicationDose(input.medicationId, {
        status: input.status,
        scheduledFor: input.scheduledFor,
        prnReason: input.prnReason ?? null
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.schedule(date) });
      void queryClient.invalidateQueries({ queryKey: ["wellness", "adherence-summary"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
    }
  });

  // PRN ("as needed") dose entry. Reason is optional — the user may log a dose without
  // a reason (persists as null). PRN doses are repeatable: each submit inserts a new log.
  const [prnOpenFor, setPrnOpenFor] = useState<string | null>(null);
  const [prnReason, setPrnReason] = useState("");

  function logPrnDose(medicationId: string) {
    const reason = prnReason.trim() || null;
    logMutation.mutate(
      { medicationId, status: "prn", scheduledFor: null, prnReason: reason },
      {
        onSuccess: () => {
          setPrnOpenFor(null);
          setPrnReason("");
        }
      }
    );
  }

  const slots = scheduleQuery.data?.slots ?? [];
  const scheduledSlots = slots.filter((s) => !s.asNeeded);
  const takenCount = scheduledSlots.filter((s) => s.status === "taken").length;
  const totalSched = scheduledSlots.length;
  const pct = totalSched > 0 ? Math.round((takenCount / totalSched) * 100) : 0;

  const morningSlots = slots.filter((s) => {
    const t = slotClock(s);
    if (!t) return false;
    return parseInt(t.slice(0, 2), 10) < 12;
  });
  const eveningSlots = slots.filter((s) => {
    const t = slotClock(s);
    if (!t) return s.asNeeded;
    return parseInt(t.slice(0, 2), 10) >= 12;
  });

  const groups = [
    { key: "Morning", label: "Morning", icon: <SunriseIcon />, rows: morningSlots },
    { key: "Evening", label: "Evening", icon: <MoonIcon />, rows: eveningSlots }
  ];

  return (
    <div className="wl-card">
      <div className="wl-card__hd">
        <span className="ic">
          <PillIcon />
        </span>
        <span className="t">Today&apos;s medication</span>
        <span className="r">
          <button
            type="button"
            className="ghost-button wl-fs12"
            style={{ padding: "4px 10px", minHeight: "unset", gap: 5 }}
            onClick={onManage}
          >
            <Settings2Icon />
            Manage
          </button>
        </span>
      </div>
      <div className="wl-medlist">
        {scheduleQuery.isError ? (
          <p className="wl-subtle-text" style={{ padding: "4px 0" }}>
            Couldn&apos;t load schedule — try refreshing.
          </p>
        ) : null}
        {!scheduleQuery.isError &&
          groups.map((g) => {
            if (!g.rows.length) return null;
            return (
              <div key={g.key} className="wl-medgrp">
                <div className="wl-medgrp__lbl">
                  <span className="ic">{g.icon}</span>
                  {g.label}
                </div>
                {g.rows.map((slot, i) => {
                  if (slot.asNeeded) {
                    const open = prnOpenFor === slot.medicationId;
                    return (
                      <div key={`prn-${slot.medicationId}-${i}`} className="wl-prn">
                        <div className="wl-prn__row">
                          <span className="wl-medrow__name">
                            {slot.name}
                            <span className="wl-medrow__prn">as needed</span>
                          </span>
                          {(slot.prnCount ?? 0) > 0 ? (
                            <span className="wl-prn__count">{slot.prnCount} logged today</span>
                          ) : null}
                          <button
                            type="button"
                            className="wl-prn__log"
                            aria-expanded={open}
                            onClick={() => {
                              setPrnOpenFor(open ? null : slot.medicationId);
                              setPrnReason("");
                            }}
                          >
                            <PlusIcon />
                            Log a dose
                          </button>
                        </div>
                        {open ? (
                          <div className="wl-prn__panel">
                            <div className="wl-prn__chips">
                              {PRN_REASONS.map((r) => (
                                <button
                                  key={r}
                                  type="button"
                                  className={`wl-prn__chip${prnReason === r ? " is-on" : ""}`}
                                  onClick={() => setPrnReason(r)}
                                >
                                  {r}
                                </button>
                              ))}
                            </div>
                            <input
                              className="wl-prn__input"
                              type="text"
                              value={prnReason}
                              placeholder="Reason for this dose (optional)"
                              aria-label="Reason for this dose"
                              maxLength={120}
                              onChange={(ev) => setPrnReason(ev.target.value)}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") {
                                  ev.preventDefault();
                                  logPrnDose(slot.medicationId);
                                }
                              }}
                            />
                            <div className="wl-prn__actions">
                              <button
                                type="button"
                                className="ghost-button wl-fs12"
                                style={{ padding: "5px 12px", minHeight: "unset" }}
                                onClick={() => {
                                  setPrnOpenFor(null);
                                  setPrnReason("");
                                }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="primary-button wl-fs12"
                                style={{ padding: "5px 12px", minHeight: "unset" }}
                                disabled={logMutation.isPending}
                                onClick={() => logPrnDose(slot.medicationId)}
                              >
                                Log dose
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                  const on = slot.status === "taken";
                  return (
                    <div
                      key={`${slot.medicationId}-${i}`}
                      className={`wl-medrow wl-medrow--tight${on ? " is-on" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        logMutation.mutate({
                          medicationId: slot.medicationId,
                          status: on ? "skipped" : "taken",
                          scheduledFor: slot.scheduledFor ?? null
                        });
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          logMutation.mutate({
                            medicationId: slot.medicationId,
                            status: on ? "skipped" : "taken",
                            scheduledFor: slot.scheduledFor ?? null
                          });
                        }
                      }}
                    >
                      <span className="wl-medrow__box">{on ? <CheckIcon size={14} /> : null}</span>
                      <span className="wl-medrow__main">
                        <span className="wl-medrow__name">{slot.name}</span>
                      </span>
                      {on ? (
                        <span className="wl-medrow__taken">
                          <CheckIcon size={12} />
                          Taken
                        </span>
                      ) : (
                        <span className="wl-medrow__time">
                          {formatClockTime(slotClock(slot), locale)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        {!scheduleQuery.isError && slots.length === 0 ? (
          <p className="wl-subtle-text" style={{ padding: "4px 0" }}>
            No medications scheduled.
          </p>
        ) : null}
      </div>
      <div className="wl-medfoot">
        <span className="wl-medfoot__bar">
          <span className="wl-medfoot__track">
            <span className="wl-medfoot__fill" style={{ width: `${pct}%` }} />
          </span>
        </span>
        <span className="wl-medfoot__ct">
          <b>{takenCount}</b> of {totalSched} taken
        </span>
      </div>
    </div>
  );
}

/* ─── CheckinToday card ─── */
interface CheckinTodayProps {
  todayCheckins: readonly CheckinDto[];
  theme: Theme;
  streak: number;
  onStart: () => void;
  onSeed: (em: WellnessEmotionCore) => void;
  onEdit: () => void;
}

function CheckinToday({
  todayCheckins,
  theme,
  streak,
  onStart,
  onSeed,
  onEdit
}: CheckinTodayProps) {
  const latestCheckin = todayCheckins.length > 0 ? todayCheckins[0] : null;

  const StreakChip =
    streak > 0 ? (
      <span className="wl-streakchip" title={`${streak}-day check-in streak`}>
        <FlameIcon size={13} />
        {streak}
      </span>
    ) : null;

  if (!latestCheckin) {
    return (
      <div className="wl-card wl-checkin">
        <div className="wl-card__hd">
          <span className="ic">
            <HeartPulseIcon />
          </span>
          <span className="t">Today&apos;s mood</span>
          {StreakChip ? <span className="r">{StreakChip}</span> : null}
        </div>
        <div className="wl-checkin__prompt">
          <div className="wl-checkin__q">You haven&apos;t checked in yet today.</div>
          <div className="wl-checkin__hint">
            {streak > 0 ? (
              <>
                You&apos;re on a <strong>{streak}-day streak</strong> — check in to keep it going.
              </>
            ) : (
              "A 20-second read on how you're feeling — it shapes your trend."
            )}
          </div>
          <div className="wl-emostrip">
            {EMOTIONS.map((em) => {
              const c = emoColor(em.core, theme);
              return (
                <button
                  key={em.core}
                  type="button"
                  className="wl-emostrip__b"
                  title={`Start with ${coreLabel(em.core)}`}
                  style={
                    {
                      "--em-tint": c.tint,
                      "--em-soft": c.soft
                    } as React.CSSProperties
                  }
                  onClick={() => onSeed(em.core)}
                >
                  <span className="wl-emostrip__dot" />
                  <span className="wl-emostrip__name">{coreLabel(em.core)}</span>
                </button>
              );
            })}
          </div>
          <div className="wl-checkin__cta">
            <button
              type="button"
              className="primary-button"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8
              }}
              onClick={onStart}
            >
              <ClipboardCheckIcon />
              Start check-in
            </button>
          </div>
        </div>
      </div>
    );
  }

  const core = latestCheckin.feelingCore;
  const c = emoColor(core, theme);
  const v = moodIndex(core, latestCheckin.intensity ?? 3);
  const avgV =
    todayCheckins.length > 1
      ? Math.round(
          (todayCheckins.reduce(
            (sum, ck) => sum + moodIndex(ck.feelingCore, ck.intensity ?? 3),
            0
          ) /
            todayCheckins.length) *
            10
        ) / 10
      : v;
  const avgBandLabel = moodBand(avgV);

  return (
    <div
      className="wl-card wl-checkin"
      style={
        {
          "--em-tint": c.tint,
          "--em-soft": c.soft,
          "--em-ink": c.ink
        } as React.CSSProperties
      }
    >
      <div className="wl-card__hd">
        <span className="ic">
          <HeartPulseIcon />
        </span>
        <span className="t">Today&apos;s mood</span>
        <span className="r" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {StreakChip}
          <button
            type="button"
            className="ghost-button wl-fs12"
            style={{ padding: "4px 10px", minHeight: "unset", gap: 5 }}
            onClick={onStart}
          >
            <PlusIcon />
            Check in again
          </button>
          <button
            type="button"
            className="ghost-button wl-fs12"
            style={{ padding: "4px 10px", minHeight: "unset", gap: 5 }}
            onClick={onEdit}
          >
            <PencilIcon />
            Edit
          </button>
        </span>
      </div>
      <div className="wl-done">
        <div className="wl-done__top">
          <span className="wl-done__chip">
            <span className="d" />
            {coreLabel(core)}
          </span>
          <span className="wl-done__feeling">{latestCheckin.feelingSecondary}</span>
          <span className="wl-done__mood">
            <span className="k">{todayCheckins.length > 1 ? "Now" : "Mood"}</span>
            <span className="v">
              {v > 0 ? "+" : ""}
              {v}
            </span>
          </span>
          {todayCheckins.length > 1 ? (
            <span className="wl-done__mood">
              <span className="k">Avg</span>
              <span className="v">
                {avgV > 0 ? "+" : ""}
                {avgV}
              </span>
              <span className="k">{avgBandLabel}</span>
            </span>
          ) : null}
        </div>
        {latestCheckin.sensations && latestCheckin.sensations.length > 0 ? (
          <div className="wl-senrow">
            {(latestCheckin.sensations as string[]).map((s) => (
              <span key={s} className="wl-sentag">
                {s}
              </span>
            ))}
          </div>
        ) : null}
        <div className="wl-intens">
          <span className="wl-intens__lbl">Intensity</span>
          <span className="wl-intens__track">
            {[1, 2, 3, 4, 5].map((n) => (
              <span
                key={n}
                className={`wl-intens__pip${n <= (latestCheckin.intensity ?? 0) ? " wl-intens__pip--filled" : ""}`}
              />
            ))}
          </span>
        </div>
        {latestCheckin.note ? (
          <div className="wl-hdetail__note" style={{ "--em-tint": c.tint } as React.CSSProperties}>
            {latestCheckin.note}
          </div>
        ) : null}
      </div>
      {todayCheckins.length > 1 ? (
        <div className="wl-fs12 wl-text-subtle" style={{ padding: "4px 16px 12px" }}>
          {todayCheckins.length} check-ins today
        </div>
      ) : null}
    </div>
  );
}

/* ─── Public component ─── */
export interface WellnessTodayProps {
  checkins: readonly CheckinDto[];
  streak: number;
  theme: Theme;
  onManage: () => void;
  onModalOpen: (seedEmotion?: WellnessEmotionCore | null) => void;
  onModalEdit: () => void;
  /** IANA timezone from user locale settings. Defaults to browser timezone when absent. */
  timeZone?: string;
}

/**
 * Today's check-ins, day-bucketed in the user's persisted timezone (#636) rather than
 * the UTC day embedded in the stored ISO timestamp. Exported for unit coverage of the
 * todays-checkins bucketing fix.
 */
export function todaysCheckins(checkins: readonly CheckinDto[], timeZone?: string): CheckinDto[] {
  const todayStr = localDay(new Date(), timeZone);
  return checkins
    .filter((c) => {
      const ts = c.checkedInAt ?? c.createdAt ?? "";
      return ts && localDay(ts, timeZone) === todayStr;
    })
    .sort((a, b) => {
      const da = a.checkedInAt ?? a.createdAt ?? "";
      const db = b.checkedInAt ?? b.createdAt ?? "";
      return db < da ? -1 : 1;
    });
}

export function WellnessToday({
  checkins,
  streak,
  theme,
  onManage,
  onModalOpen,
  onModalEdit,
  timeZone
}: WellnessTodayProps) {
  const todayCheckins = todaysCheckins(checkins, timeZone);

  return (
    <div className="wl-today">
      <MedToday theme={theme} onManage={onManage} timeZone={timeZone} />
      <CheckinToday
        todayCheckins={todayCheckins}
        theme={theme}
        streak={streak}
        onStart={() => onModalOpen(null)}
        onSeed={(em) => onModalOpen(em)}
        onEdit={onModalEdit}
      />
    </div>
  );
}

export { MedToday };
