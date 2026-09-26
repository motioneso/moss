/* Persona draft state shared by the guided-dial and write-it-yourself editors. Neither mode
   shows a made-up sample reply: both show PERSONA_PREVIEW_HINT until the user runs a real
   preview against their actual persona text. */

export type ToneDial = "Warm" | "Neutral" | "Crisp";
export type DirectnessDial = "Gentle" | "Balanced" | "Direct";
export type HumorDial = "None" | "Dry" | "Playful";
export type RecoveryDial = "Encouraging" | "Matter-of-fact" | "Firm";

export interface PersonaDials {
  readonly tone: ToneDial;
  readonly directness: DirectnessDial;
  readonly humor: HumorDial;
  readonly recovery: RecoveryDial;
}

export interface PersonaSnapshot {
  readonly assistantName: string;
  readonly personaText: string;
}

export interface PersonaDraft extends PersonaSnapshot, PersonaDials {}

// Shown in place of a made-up sample, in both persona-editing modes, since there is no
// reliable stand-in for what the model would actually say.
export const PERSONA_PREVIEW_HINT = "Press Preview to hear how this sounds.";

export function personaSeedText(p: PersonaDials): string {
  const tone: Record<ToneDial, string> = {
    Warm: "Keep responses warm and steady",
    Neutral: "Keep responses clear and neutral",
    Crisp: "Keep responses crisp and economical"
  };
  const directness: Record<DirectnessDial, string> = {
    Gentle: "nudge me without pressure",
    Balanced: "be direct when priorities are clear",
    Direct: "lead with what matters and skip throat-clearing"
  };
  const humor: Record<HumorDial, string> = {
    None: "avoid jokes",
    Dry: "use dry humor sparingly",
    Playful: "allow light playful asides"
  };
  const recovery: Record<RecoveryDial, string> = {
    Encouraging: "when I fall behind, make it easy to restart",
    "Matter-of-fact": "when I fall behind, state the miss plainly and suggest the next step",
    Firm: "when I fall behind, push me to clear the slipped item first"
  };

  return `${tone[p.tone]}; ${directness[p.directness]}; ${humor[p.humor]}; ${recovery[p.recovery]}.`;
}

export function createPersonaDraft(
  saved: PersonaSnapshot,
  dials: PersonaDials = {
    tone: "Warm",
    directness: "Balanced",
    humor: "Dry",
    recovery: "Encouraging"
  }
): PersonaDraft {
  return { ...saved, ...dials };
}

export function applyGuidedPersonaText(draft: PersonaDraft, dials: PersonaDials): PersonaDraft {
  return { ...draft, ...dials, personaText: personaSeedText(dials) };
}

export function discardPersonaDraft(saved: PersonaSnapshot, dials?: PersonaDials): PersonaDraft {
  return createPersonaDraft(
    saved,
    dials
      ? {
          tone: dials.tone,
          directness: dials.directness,
          humor: dials.humor,
          recovery: dials.recovery
        }
      : undefined
  );
}

export function personaDraftIsDirty(draft: PersonaSnapshot, saved: PersonaSnapshot): boolean {
  return (
    draft.assistantName !== saved.assistantName ||
    draft.personaText.trim() !== saved.personaText.trim()
  );
}
