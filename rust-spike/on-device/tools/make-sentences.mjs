// Writes the fixed sentence set used to compare on-device vectors with the legacy app's.
import { writeFileSync } from "node:fs";

const paragraph =
  "The quarterly planning meeting covered hiring, budget, the launch schedule and the vendor contract. " +
  "Everyone agreed the migration should finish before the holidays, and that testing needs two extra weeks. ";
const items = [
  ["document", "Sam prefers dark roast coffee in the morning."],
  ["document", "The dentist appointment moved to Thursday at 3:30 pm."],
  ["document", "Meeting notes: agreed to ship the beta on 2026-03-14 after the security review."],
  ["document", "My sister Alice lives in Lisbon and works as a marine biologist."],
  ["document", "Remember to renew the passport before the trip to Japan in April."],
  ["document", "Café menu: crème brûlée, naïve rye bread, jalapeño 🌶️ cornbread."],
  ["document", "日本語のメモ: 来週の会議は午後二時から始まります。"],
  ["document", "def add(a, b):\n    return a + b  # simple helper"],
  ["document", "x"],
  ["query", "what does Sam drink in the morning"],
  ["query", "when is the dentist"],
  ["query", "who lives in Portugal"],
  ["query", "trip planning"],
  ["document", paragraph.repeat(60)],
];
writeFileSync(
  new URL("../fixtures/sentences.json", import.meta.url),
  JSON.stringify(items.map(([kind, text]) => ({ kind, text })), null, 1) + "\n"
);
