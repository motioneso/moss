/** Lucide icon bodies (the set the current app ships), keyed by name. */
const p = (d) => `<path d="${d}"></path>`;
const RAIN_CLOUD = p("M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242");
export const ICONS = {
  sun: `<circle cx="12" cy="12" r="4"></circle>${["M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"].map(p).join("")}`,
  cloud: p("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"),
  "cloud-sun": ["M12 2v2", "m4.93 4.93 1.41 1.41", "M20 12h2", "m19.07 4.93-1.41 1.41", "M15.947 12.65a4 4 0 0 0-5.925-4.128", "M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"].map(p).join(""),
  "cloud-rain": RAIN_CLOUD + ["M16 14v6", "M8 14v6", "M12 16v6"].map(p).join(""),
  "cloud-snow": RAIN_CLOUD + ["M8 15h.01", "M8 19h.01", "M12 17h.01", "M12 21h.01", "M16 15h.01", "M16 19h.01"].map(p).join(""),
  wind: ["M12.8 19.6A2 2 0 1 0 14 16H2", "M17.5 8a2.5 2.5 0 1 1 2 4H2", "M9.8 4.4A2 2 0 1 1 11 8H2"].map(p).join(""),
  droplets: [
    "M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z",
    "M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"
  ].map(p).join(""),
  "cloud-fog": ["M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "M16 17H7", "M17 21H9"].map(p).join(""),
  "cloud-moon": ["M10.188 8.5A6 6 0 0 1 16 4a1 1 0 0 0 6 6 6 6 0 0 1-3 5.197", "M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z"].map(p).join(""),
  "cloud-lightning": ["M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973", "m13 12-3 5h4l-3 5"].map(p).join(""),
  moon: p("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"),
  "circle-help": `<circle cx="12" cy="12" r="10"></circle>${["M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"].map(p).join("")}`
};
export const icon = (name, size = 20) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS["circle-help"]}</svg>`;
