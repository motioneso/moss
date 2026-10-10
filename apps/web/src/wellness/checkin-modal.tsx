import { useEffect, useMemo, useState } from "react";
import { EMOTIONS } from "@moss/shared";
import { emVars, coreLabel, type WellnessEmotionCore, type Theme } from "./emotion-taxonomy";
import { CheckinDetailFields } from "./checkin-detail-fields";
import { RadialDial } from "./radial-dial";

export interface CheckinFormValue {
  emotion: WellnessEmotionCore;
  feeling: string;
  sensations: string[];
  intensity: number;
  note: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Resolves once the save is stored; a rejection keeps the modal open with the draft. */
  onSave: (value: CheckinFormValue) => Promise<unknown>;
  initial?: CheckinFormValue | null;
  seedEmotion?: WellnessEmotionCore | null;
  theme?: Theme;
}

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

export function CheckinModal({
  open,
  onClose,
  onSave,
  initial,
  seedEmotion,
  theme = "light"
}: Props) {
  const [emotion, setEmotion] = useState<WellnessEmotionCore | null>(null);
  const [feeling, setFeeling] = useState<string | null>(null);
  const [sensations, setSensations] = useState<string[]>([]);
  const [intensity, setIntensity] = useState(3);
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setEmotion(initial.emotion);
      setFeeling(initial.feeling);
      setSensations(initial.sensations.slice());
      setIntensity(initial.intensity);
      setNote(initial.note);
    } else if (seedEmotion) {
      setEmotion(seedEmotion);
      setFeeling(null);
      setSensations([]);
      setIntensity(3);
      setNote("");
    } else {
      setEmotion(null);
      setFeeling(null);
      setSensations([]);
      setIntensity(3);
      setNote("");
    }
    setSearch("");
    setSaveFailed(false);
  }, [open, initial, seedEmotion]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const hits: Array<{ core: WellnessEmotionCore; label: string; isCore: boolean }> = [];
    for (const e of EMOTIONS) {
      if (coreLabel(e.core).toLowerCase().includes(q)) {
        hits.push({ core: e.core, label: coreLabel(e.core), isCore: true });
      }
      for (const f of e.feelings) {
        if (f.label.toLowerCase().includes(q)) {
          hits.push({ core: e.core, label: f.label, isCore: false });
        }
      }
    }
    return hits.slice(0, 8);
  }, [search]);

  if (!open) return null;

  const e = emotion ? EMOTIONS.find((x) => x.core === emotion) : null;
  const canSave = emotion != null && feeling != null;

  const pickEmotion = (k: WellnessEmotionCore) => {
    setEmotion(k);
    setFeeling(null);
    setSensations([]);
  };

  const pickFromSearch = (hit: { core: WellnessEmotionCore; label: string; isCore: boolean }) => {
    setEmotion(hit.core);
    setFeeling(hit.isCore ? null : hit.label);
    setSensations([]);
    setSearch("");
  };

  const toggleSensation = (s: string) => {
    setSensations((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const save = async () => {
    if (!emotion || !feeling || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onSave({ emotion, feeling, sensations, intensity, note: note.trim() });
      onClose();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const FeelingChips = () => {
    if (!e) return null;
    return (
      <div className="wl-chipwrap" style={emVars(emotion, theme)}>
        {e.feelings.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`wl-fchip${feeling === f.label ? " is-on" : ""}`}
            onClick={() => setFeeling(f.label)}
          >
            {f.label}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div
      className="wl-modal-scrim"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="wl-modal" role="dialog" aria-modal="true" aria-labelledby="wl-modal-title">
        <div className="wl-modal__head">
          <div className="hm">
            <div className="wl-modal__eyebrow">
              {initial ? "Edit check-in" : "Mental-health check-in"}
            </div>
            <div className="wl-modal__title" id="wl-modal-title">
              How are you feeling right now?
            </div>
          </div>
          <button type="button" className="wl-modal__x" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <div className="wl-modal__body">
          <div>
            <div className="wl-q">What are you feeling?</div>
            <div className="wl-qsub">Search by name or tap your core emotion on the wheel.</div>
            <div className="wl-search">
              <input
                type="text"
                className="wl-search__input"
                placeholder="Search feelings…"
                value={search}
                autoComplete="off"
                onChange={(ev) => setSearch(ev.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              />
              {searchFocused && searchResults.length > 0 && (
                <div className="wl-search__results">
                  {searchResults.map((hit, i) => (
                    <button
                      key={i}
                      type="button"
                      className="wl-search__item"
                      onClick={() => pickFromSearch(hit)}
                    >
                      <span className="wl-search__core">
                        {hit.isCore ? hit.label : coreLabel(hit.core)}
                      </span>
                      {!hit.isCore && <span className="wl-search__arrow">›</span>}
                      {!hit.isCore && <span className="wl-search__label">{hit.label}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="wl-dial-wrap">
              <RadialDial value={emotion} onPick={pickEmotion} theme={theme} />
            </div>
            {emotion && feeling ? (
              <div
                style={{
                  marginTop: 22,
                  paddingTop: 20,
                  borderTop: "1px solid var(--border-subtle)",
                  ...emVars(emotion, theme)
                }}
              >
                <CheckinDetailFields
                  emotion={emotion}
                  feeling={feeling}
                  sensations={sensations}
                  intensity={intensity}
                  note={note}
                  onSensation={toggleSensation}
                  onIntensity={setIntensity}
                  onNote={setNote}
                  theme={theme}
                />
              </div>
            ) : emotion ? (
              <div style={{ marginTop: 18 }}>
                <div className="wl-q wl-q--sub">Which shade of {coreLabel(emotion)}?</div>
                <FeelingChips />
              </div>
            ) : null}
          </div>
        </div>
        <div className="wl-modal__foot">
          {saveFailed ? (
            <span className="wl-modal__note wl-modal__note--error" role="alert">
              Couldn&apos;t save your check-in. Your note is still here, so try again.
            </span>
          ) : null}
          <span className="spacer" />
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {initial ? "Update check-in" : "Save check-in"}
          </button>
        </div>
      </div>
    </div>
  );
}
