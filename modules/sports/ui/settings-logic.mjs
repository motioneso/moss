/** Pure rules for the Sports settings screen. No browser access, so node can test them. */

export const SPORT_LABELS = {
  football: "Football",
  basketball: "Basketball",
  hockey: "Hockey",
  baseball: "Baseball",
  soccer: "Soccer"
};

export const SPORT_OPTIONS = Object.entries(SPORT_LABELS).map(([key, label]) => ({ key, label }));

const CONFEDERATION_ORDER = ["INTL", "UEFA", "CONCACAF", "CONMEBOL", "AFC", "CAF", "OFC"];

export const CONFEDERATION_LABELS = {
  INTL: "US majors & global",
  UEFA: "Europe · UEFA",
  CONCACAF: "North & Central America · CONCACAF",
  CONMEBOL: "South America · CONMEBOL",
  AFC: "Asia · AFC",
  CAF: "Africa · CAF",
  OFC: "Oceania · OFC"
};

export const PREVIEW_REJECTION_COPY = {
  policy:
    "That site redirects somewhere else, so we can't add it. Try the address it sends you to.",
  invalid_input: "That doesn't look like a publication we can check — try a homepage link.",
  unreachable: "We couldn't reach that site. Check the address and try again.",
  not_https: "Only HTTPS links or bare domains are accepted.",
  not_found: "That subreddit doesn't exist.",
  auth_required: "That subreddit is private or restricted, so Moss can't read it.",
  rate_limited: "Reddit is rate limiting Moss. Try again in a few minutes.",
  stale_source: "That publication has changed since it was added. Remove it and add it again."
};

export const HEALTH_BADGE = {
  pending: { tone: "steel", label: "Awaiting first check" },
  healthy: { tone: "forest", label: "Healthy" },
  failing: { tone: "amber", label: "Having trouble" },
  unsupported: { tone: "red", label: "Unsupported" },
  auth_required: { tone: "red", label: "Needs login" },
  disabled: { tone: "neutral", label: "Disabled" }
};

export const PHOTO_STATUS_TEXT = {
  working: "Photos: working",
  none: "Photos: none found",
  previewing: "Photos: preview ready",
  stopped_working: "Photos: stopped working",
  pending: "Photos: checking"
};

export function initials(name, shortName) {
  if (shortName && shortName.trim().length > 0) return shortName.slice(0, 3).toUpperCase();
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const last = parts[parts.length - 1] ?? name;
  const letters = parts.length >= 2 ? (first[0] ?? "") + (last[0] ?? "") : name.slice(0, 2);
  return letters.toUpperCase();
}

export function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function followKey(competitionKey, teamKey) {
  return `${competitionKey}::${teamKey ?? ""}`;
}

/** Follows are matched on the provider's permanent team id when there is one, else on the key. */
export function indexFollows(follows) {
  const index = new Map();
  for (const follow of follows) {
    index.set(followKey(follow.competitionKey, follow.teamKey), follow);
    if (follow.sourceTeamId !== null && follow.sourceTeamId !== undefined) {
      index.set(followKey(follow.competitionKey, `id:${follow.sourceTeamId}`), follow);
    }
  }
  return index;
}

export function wholeLeagueFollow(index, competitionKey) {
  return index.get(followKey(competitionKey, null));
}

/** The saved follow a team tile stands for. A different permanent id never matches by key. */
export function followFor(index, competitionKey, teamKey, sourceTeamId) {
  if (sourceTeamId !== null && sourceTeamId !== undefined) {
    const byId = index.get(followKey(competitionKey, `id:${sourceTeamId}`));
    if (byId !== undefined) return byId;
  }
  const byKey = index.get(followKey(competitionKey, teamKey));
  if (byKey === undefined) return undefined;
  if (sourceTeamId !== null && sourceTeamId !== undefined) {
    if (byKey.sourceTeamId !== null && byKey.sourceTeamId !== undefined) return undefined;
  }
  return byKey;
}

/** One source of truth for the visible label and the accessible name of a follow control. */
export function followControlState(variant, subjectLabel, active, pending) {
  if (pending === "follow") return { visible: "Following…", ariaLabel: "Following…" };
  if (pending === "unfollow") return { visible: "Unfollowing…", ariaLabel: "Unfollowing…" };
  const followLabel =
    variant === "league" ? `Follow all of ${subjectLabel}` : `Follow ${subjectLabel}`;
  if (!active) return { visible: variant === "team" ? "" : followLabel, ariaLabel: followLabel };
  if (variant === "team") return { visible: "Following", ariaLabel: `Unfollow ${subjectLabel}` };
  return {
    visible: `Following all of ${subjectLabel}`,
    ariaLabel: `Unfollow all of ${subjectLabel}`
  };
}

export function leagueMatches(query, competitions) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return competitions.filter((c) => c.label.toLowerCase().includes(q));
}

/** League rows for search results: name matches plus the parent league of every team result. */
export function searchLeagueRows(query, resultTeams, competitions) {
  const byKey = new Map();
  for (const competition of leagueMatches(query, competitions)) {
    byKey.set(competition.competitionKey, competition);
  }
  const all = new Map(competitions.map((c) => [c.competitionKey, c]));
  for (const team of resultTeams) {
    const competition = all.get(team.competitionKey);
    if (competition) byKey.set(competition.competitionKey, competition);
  }
  return [...byKey.values()];
}

export function groupByConfederation(competitions) {
  const groups = new Map();
  for (const competition of competitions) {
    const list = groups.get(competition.confederation) ?? [];
    list.push(competition);
    groups.set(competition.confederation, list);
  }
  return CONFEDERATION_ORDER.filter((conf) => (groups.get(conf)?.length ?? 0) > 0).map((conf) => ({
    confederation: conf,
    label: CONFEDERATION_LABELS[conf],
    competitions: groups.get(conf)
  }));
}

/** Standings tree: leagues with no region sit under the sport, the rest under their country. */
export function groupCompetitions(competitions) {
  const sports = new Map();
  for (const competition of competitions) {
    const sport = sports.get(competition.sportLabel) ?? {
      label: competition.sportLabel,
      leagues: [],
      regions: []
    };
    if (competition.regionLabel === null || competition.regionLabel === undefined) {
      sport.leagues.push(competition);
    } else {
      const region = sport.regions.find((entry) => entry.label === competition.regionLabel);
      if (region) region.competitions.push(competition);
      else sport.regions.push({ label: competition.regionLabel, competitions: [competition] });
    }
    sports.set(competition.sportLabel, sport);
  }
  return [...sports.values()];
}

export function targetKey(target) {
  return target.kind === "sport" ? `sport:${target.sportKey}` : `follow:${target.followId}`;
}

export function assignmentTarget(assignment) {
  if (assignment.sportKey) return { kind: "sport", sportKey: assignment.sportKey };
  if (assignment.followId) return { kind: "follow", followId: assignment.followId };
  return null;
}

export function followDisplayLabel(follow, competitionsByKey, teamsByCompetition) {
  const competition = competitionsByKey.get(follow.competitionKey);
  if (follow.teamKey === null) {
    return competition
      ? `All ${competition.label}`
      : `Unrecognized league (${follow.competitionKey})`;
  }
  const team = teamsByCompetition
    .get(follow.competitionKey)
    ?.find((candidate) => candidate.teamKey === follow.teamKey);
  return team?.shortName || team?.name || follow.teamKey || follow.competitionKey;
}

export function targetDisplayLabel(target, follows, competitionsByKey, teamsByCompetition) {
  if (target.kind === "sport") return SPORT_LABELS[target.sportKey] ?? target.sportKey;
  const follow = follows.find((candidate) => candidate.id === target.followId);
  return follow
    ? followDisplayLabel(follow, competitionsByKey, teamsByCompetition)
    : "Unavailable team or league";
}

/** The request body that confirms a stored preview. */
export function confirmBody(result) {
  return {
    confirmationId: result.confirmationId,
    authorizationAcknowledgement: result.authorizationAcknowledgement,
    canonicalDomain: result.candidate.canonicalDomain,
    confirmedFetchHosts: result.candidate.confirmedFetchHosts,
    targets: result.candidate.targets.map((t) => ({ target: t.target, targetUrl: t.targetUrl }))
  };
}

export function assignmentFailureCopy(result) {
  if (result.status === "rejected") {
    return (
      (result.reason ? PREVIEW_REJECTION_COPY[result.reason] : undefined) ??
      "Those assignments could not be verified."
    );
  }
  if (result.status === "unavailable") {
    return "Updating coverage needs a configured JSON-capable AI model.";
  }
  return "Those assignments could not be verified.";
}

export function showRebuild(source) {
  return (
    source.retrievalMethod === "scrape" &&
    (source.recipeStatus === "missing" ||
      source.recipeStatus === "drift" ||
      source.healthReasonCode === "recipe_drift")
  );
}
