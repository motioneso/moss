import "../styles/wellness-1.css";
import "../styles/wellness-2.css";
import "../styles/wellness-3.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@moss/ui";
import {
  localDay,
  moodIndex,
  moodBand,
  type CheckinDto,
  type WellnessEmotionCore,
  type UpdateCheckinRequest
} from "@moss/shared";
import {
  createWellnessCheckin,
  getLocaleSettings,
  listWellnessCheckins,
  updateWellnessCheckin
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { MOOD_BAND_LABELS } from "./emotion-taxonomy";
import { WellnessToday } from "./wellness-today";
import { WellnessInsights } from "./wellness-insights";
import { WellnessTrends } from "./wellness-trends";
import { WellnessHistory } from "./wellness-history";
import { WellnessTherapyNotes } from "./wellness-therapy-notes";
import { CheckinModal, type CheckinFormValue } from "./checkin-modal";
import { ManageMedsModal } from "./manage-meds-modal";
import { WellnessExportModal } from "./export-modal";
import { computeStreak } from "./wellness-date-utils";
import { readColorMode } from "../theme/color-mode";

function useTheme(): "light" | "dark" {
  return readColorMode();
}

function FlameIcon({ size = 15 }: { size?: number }) {
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

export function WellnessPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const histRef = useRef<HTMLDivElement>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editCheckin, setEditCheckin] = useState<CheckinDto | null>(null);
  const [seedEmotion, setSeedEmotion] = useState<WellnessEmotionCore | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [histFilter, setHistFilter] = useState<"notes" | null>(null);

  const localeQuery = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: () => getLocaleSettings()
  });
  const localTimezone = localeQuery.data?.locale.timezone;

  const checkinsQuery = useQuery({
    queryKey: queryKeys.wellness.checkins,
    queryFn: () => listWellnessCheckins()
  });

  const checkins = checkinsQuery.data?.checkins ?? [];

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
    }
  });

  const updateCheckinMutation = useMutation({
    mutationFn: (val: CheckinFormValue) =>
      updateWellnessCheckin(editCheckin!.id, {
        feelingCore: val.emotion,
        feelingSecondary: val.feeling || null,
        feelingTertiary: null,
        sensations: val.sensations,
        intensity: val.intensity,
        note: val.note || null
      } satisfies UpdateCheckinRequest),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.checkins });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
    }
  });

  // Hero stats
  const today = localDay(new Date(), localTimezone);

  const last14 = checkins
    .filter((c) => {
      const d = localDay(c.checkedInAt ?? c.createdAt ?? "", localTimezone);
      return d && d < today;
    })
    .slice(0, 14);

  const avgMood = last14.length
    ? Math.round(
        (last14.reduce((s, c) => s + moodIndex(c.feelingCore, c.intensity ?? 3), 0) /
          last14.length) *
          10
      ) / 10
    : 0;

  const avgBand = moodBand(avgMood);
  const streak = computeStreak(checkins, localTimezone);

  const openFresh = () => {
    setEditCheckin(null);
    setSeedEmotion(null);
    setModalOpen(true);
  };

  const openSeeded = (em: WellnessEmotionCore) => {
    setEditCheckin(null);
    setSeedEmotion(em);
    setModalOpen(true);
  };

  const openEdit = (id: string) => {
    const c = checkins.find((x) => x.id === id);
    if (c) {
      setEditCheckin(c);
      setSeedEmotion(null);
      setModalOpen(true);
    }
  };

  const openTodayEdit = () => {
    const todayCks = checkins
      .filter((c) => localDay(c.checkedInAt ?? c.createdAt ?? "", localTimezone) === today)
      .sort((a, b) => {
        const da = a.checkedInAt ?? a.createdAt ?? "";
        const db = b.checkedInAt ?? b.createdAt ?? "";
        return db < da ? -1 : 1;
      });
    const latest = todayCks[0];
    if (latest) {
      setEditCheckin(latest);
      setSeedEmotion(null);
      setModalOpen(true);
    }
  };

  const reviewNotes = () => {
    setHistFilter("notes");
    // Scroll after React re-render
    setTimeout(() => {
      histRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  // IMPORTANT: never call mutation inside a setState updater — StrictMode double-fires → double mutation.
  const handleSave = (val: CheckinFormValue) => {
    if (editCheckin) {
      updateCheckinMutation.mutate(val);
    } else {
      createCheckinMutation.mutate(val);
    }
  };

  const initialCheckinValue: CheckinFormValue | null = editCheckin
    ? {
        emotion: editCheckin.feelingCore,
        feeling: editCheckin.feelingSecondary ?? "",
        sensations: (editCheckin.sensations as string[]) ?? [],
        intensity: editCheckin.intensity ?? 3,
        note: editCheckin.note ?? ""
      }
    : null;

  return (
    <div className="wl-wrap">
      <header className="wl-hero">
        <div className="wl-hero__main">
          <h1 className="wl-title">How you&apos;re really doing.</h1>
          <p className="wl-lede">
            Take your medication, name what you&apos;re feeling, and watch the quiet patterns
            surface over time.
          </p>
        </div>
        <div className="wl-hero__stat">
          <div className="wl-herostat">
            <div className="k">Mood &middot; 14d</div>
            <div className="v">
              {avgMood > 0 ? "+" : ""}
              {avgMood}
              <small> {MOOD_BAND_LABELS[avgBand] ?? avgBand}</small>
            </div>
          </div>
          <div className="wl-herostat wl-herostat--streak">
            <div className="k">Check-in streak</div>
            <div className="v">
              <FlameIcon size={15} />
              {streak}
              <small> {streak === 1 ? "day" : "days"}</small>
            </div>
          </div>
          <Button variant="quiet" size="sm" onClick={() => setExportOpen(true)}>
            Export
          </Button>
          {/* #1759: a way into this module's own settings from the module itself, so the two
              halves of its configuration are not something you have to go hunting for. */}
          <Link
            className="jds-btn jds-btn--quiet jds-btn--sm"
            to="/settings?section=modules&module=wellness"
          >
            Settings
          </Link>
        </div>
      </header>

      <section className="wl-sec">
        <WellnessToday
          checkins={checkins}
          streak={streak}
          theme={theme}
          onManage={() => setManageOpen(true)}
          onModalOpen={(em) => {
            if (em) openSeeded(em);
            else openFresh();
          }}
          onModalEdit={openTodayEdit}
          timeZone={localTimezone}
        />
      </section>

      <section className="wl-sec">
        <WellnessInsights onReviewNotes={reviewNotes} />
      </section>

      <WellnessTrends theme={theme} />

      <div ref={histRef}>
        <WellnessHistory
          checkins={checkins}
          theme={theme}
          filter={histFilter}
          onClearFilter={() => setHistFilter(null)}
          onEdit={openEdit}
          timezone={localTimezone}
        />
      </div>

      <WellnessTherapyNotes theme={theme} />

      <CheckinModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        initial={initialCheckinValue}
        seedEmotion={seedEmotion}
        theme={theme}
      />

      <ManageMedsModal open={manageOpen} onClose={() => setManageOpen(false)} theme={theme} />
      <WellnessExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
