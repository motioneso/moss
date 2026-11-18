/** Calls the Sports routes the settings screen needs. Every failure carries its status. */
export function settingsApi(client) {
  async function call(method, path, body) {
    let reply;
    try {
      reply = await client.request(method, path, body ?? null);
    } catch (error) {
      if (!Number.isInteger(error?.status)) throw error;
      reply = { status: error.status, body: error.body };
    }
    if (!(reply && typeof reply.status === "number" && "body" in reply)) {
      reply = { status: 200, body: reply };
    }
    if (reply.status >= 400) {
      const failure = new Error("Sports request failed");
      failure.status = reply.status;
      const message = reply.body?.error;
      if (typeof message === "string") failure.detail = message;
      throw failure;
    }
    return reply.body;
  }
  const id = (value) => encodeURIComponent(value);
  return {
    catalog: () => call("GET", "/catalog"),
    follows: () => call("GET", "/follows"),
    follow: (body) => call("POST", "/follows", body),
    unfollow: (followId) => call("DELETE", `/follows/${id(followId)}`),
    leagueTeams: (key) => call("GET", `/leagues/${id(key)}/teams`),
    searchTeams: (q) => call("GET", `/teams/search?q=${id(q)}`),
    standingsPreferences: () => call("GET", "/standings-preferences"),
    saveStandingsLeagues: (keys) =>
      call("PUT", "/standings-preferences", { selectedCompetitionKeys: keys }),
    sources: () => call("GET", "/sources"),
    saveEspnCoverage: (assignments) => call("PUT", "/sources/espn/coverage", { assignments }),
    previewSource: (body) => call("POST", "/sources/preview", body),
    confirmSource: (body) => call("POST", "/sources", body),
    previewAssignments: (sourceId, targets) =>
      call("POST", `/sources/${id(sourceId)}/assignments/preview`, {
        assignments: targets.map((target) => ({ target }))
      }),
    confirmAssignments: (sourceId, body) =>
      call("PATCH", `/sources/${id(sourceId)}/assignments`, body),
    retrySource: (sourceId) => call("POST", `/sources/${id(sourceId)}/retry`),
    previewRecipe: (sourceId) => call("POST", `/sources/${id(sourceId)}/rebuild/preview`),
    confirmRecipe: (sourceId, body) => call("PATCH", `/sources/${id(sourceId)}/rebuild`, body),
    stopPhotos: (sourceId) => call("DELETE", `/sources/${id(sourceId)}/photos`),
    removeSource: (sourceId) => call("DELETE", `/sources/${id(sourceId)}`)
  };
}
