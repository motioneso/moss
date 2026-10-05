export const CAPTURE_MODES = [
  {
    value: "computer-audio",
    label: "Microphone and computer audio",
    description: "Other apps and notifications may be included."
  },
  {
    value: "selected-app",
    label: "Microphone and selected app",
    description: "Only the selected app’s output."
  },
  { value: "microphone-only", label: "Microphone only", description: "Your voice or the room." }
] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number]["value"];
