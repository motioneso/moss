import { Button, RadioCardGroup } from "@moss/ui";
import { EMOTIONS, moodIndex, moodBand } from "@moss/shared";
import { emVars, MOOD_BAND_LABELS, type WellnessEmotionCore, type Theme } from "./emotion-taxonomy";

interface Props {
  emotion: WellnessEmotionCore;
  feeling: string;
  sensations: string[];
  intensity: number;
  note: string;
  onSensation: (s: string) => void;
  onIntensity: (n: number) => void;
  onNote: (t: string) => void;
  theme?: Theme;
}

export function CheckinDetailFields({
  emotion,
  feeling,
  sensations,
  intensity,
  note,
  onSensation,
  onIntensity,
  onNote,
  theme = "light"
}: Props) {
  const e = EMOTIONS.find((x) => x.core === emotion);
  if (!e) return null;
  const fObj = e.feelings.find((f) => f.label === feeling);

  // Build ordered sensation list: current feeling's sensations first, then rest of family
  const ordered: string[] = [];
  if (fObj) fObj.sensations.forEach((s) => ordered.push(s));
  e.feelings.forEach((f) =>
    f.sensations.forEach((s) => {
      if (!ordered.includes(s)) ordered.push(s);
    })
  );

  const v = moodIndex(emotion, intensity);
  const band = moodBand(v);

  return (
    <div style={emVars(emotion, theme)}>
      <div className="wl-q" style={{ marginTop: 4 }}>
        Where do you feel it?
      </div>
      <div className="wl-qsub">
        Body sensations that come with &ldquo;{feeling}.&rdquo; Pick any that fit — or none.
      </div>
      <div className="wl-chipwrap">
        {ordered.map((s) => {
          const on = sensations.includes(s);
          return (
            <Button
              key={s}
              variant="chip"
              size="sm"
              active={on}
              aria-pressed={on}
              onClick={() => onSensation(s)}
            >
              {s}
            </Button>
          );
        })}
      </div>

      <div className="wl-q" style={{ marginTop: 22 }}>
        How strong is it?
      </div>
      <div className="wl-qsub">This sets where the day lands on your mood trend.</div>
      <RadioCardGroup
        name="checkin-intensity"
        ariaLabel="Intensity"
        value={String(intensity)}
        options={[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))}
        onChange={(value) => onIntensity(Number(value))}
      />
      <div className="wl-intends">
        <span>Barely there</span>
        <span>Overwhelming</span>
      </div>

      <div className="wl-moodpreview">
        <span className="wl-moodpreview__k">Logs to your mood trend as</span>
        <span className="wl-moodpreview__v">
          <span className="wl-moodpreview__num">
            {v > 0 ? "+" : ""}
            {v}
          </span>
          <span className="wl-moodpreview__band">{MOOD_BAND_LABELS[band] ?? band}</span>
        </span>
      </div>

      <textarea
        aria-label="Check-in note (optional)"
        className="wl-note-field"
        placeholder="Anything you want to remember about this — a trigger, a thought? Optional."
        value={note}
        onChange={(ev) => onNote(ev.target.value)}
      />
    </div>
  );
}
