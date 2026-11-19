// Pure helpers for the Finance settings screen.
const TIERS = {
  ask_each_time: "Asks you each time",
  trusted_auto: "Does it alone",
  deny: "Never does it"
};
export const tierLabel = (tier) => (tier === null || tier === undefined ? "Unavailable" : (TIERS[tier] ?? String(tier).replace(/_/g, " ")));

/** The activity window is the last seven days, as UTC timestamps. */
export function weekWindow(now = new Date()) {
  return {
    from: new Date(now.getTime() - 7 * 86400000).toISOString(),
    to: new Date(now.getTime() + 60000).toISOString()
  };
}

export const actorLabel = (actor) => (actor === "user" ? "You" : "Moss");
