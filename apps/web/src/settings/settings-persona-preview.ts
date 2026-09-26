/* Deterministic persona voice preview for guided-dial mode. No model call — turns the four
   dials into a concrete sample of how the configured assistant would sound, so the abstract
   controls have a visible effect. Ported verbatim from the design kit (personaSample).
   Write-it-yourself mode has no dial values to sample from, so it shows PERSONA_PREVIEW_HINT
   instead until the user runs a real preview. */

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

export interface PersonaPreview {
  readonly greeting: string;
  readonly recovery: string;
}

// Shown in write-it-yourself mode in place of a made-up sample, since there are no dial
// values to build one from.
export const PERSONA_PREVIEW_HINT = "Press Preview to hear how this sounds.";

export function personaSample(p: PersonaDials, who: string): PersonaPreview {
  const open: Record<ToneDial, string> = {
    Warm: `Morning, ${who}.`,
    Neutral: "Good morning.",
    Crisp: "Morning."
  };
  const body: Record<DirectnessDial, string> = {
    Gentle: "Whenever you're ready — here's the shape of your day.",
    Balanced: "Here's the shape of your day.",
    Direct: "Three things actually matter today."
  };
  const aside: Record<HumorDial, string> = {
    None: "",
    Dry: " Two meetings — one of which could've been an email.",
    Playful: " It's a full one, but nothing we can't handle."
  };
  const recovery: Record<RecoveryDial, string> = {
    Encouraging: "And yesterday's two open items? No drama — want them on today?",
    "Matter-of-fact": "Two items from yesterday are still open. Move them to today?",
    Firm: "Two items slipped yesterday. Let's clear those first."
  };
  return {
    greeting: `${open[p.tone]} ${body[p.directness]}${aside[p.humor]}`,
    recovery: recovery[p.recovery]
  };
}

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
