// Explicit example data; production snapshots need the authorized turn registry.
export const exampleFacts = {
  hours: { label: "Available time", value: "6 hours" },
  projects: { label: "Projects", value: "5" },
  budget: { label: "Hypothetical budget", value: "$420" }
} as const;

export const fallbackText =
  Object.values(exampleFacts)
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join(". ") + ". Example data.";
