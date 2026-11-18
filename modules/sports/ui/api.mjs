/** Calls the Sports routes and turns every failure into an error with a status. */
export function sportsApi(client) {
  async function call(method, path, body) {
    let reply;
    try {
      reply = await client.request(method, path, body);
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
      throw failure;
    }
    return reply.body;
  }
  return {
    overview: () => call("GET", "/overview"),
    standings: (competitionKey) =>
      call("GET", `/standings?competitionKey=${encodeURIComponent(competitionKey)}`),
    results: () => call("GET", "/results/latest"),
    catalog: () => call("GET", "/catalog"),
    follows: () => call("GET", "/follows"),
    standingsPreferences: () => call("GET", "/standings-preferences"),
    saveLastViewed: (lastViewed) => call("PUT", "/standings-preferences", { lastViewed }),
    resolveFollowTeam: (followId, sourceTeamId) =>
      call("POST", `/follows/${encodeURIComponent(followId)}/team`, { sourceTeamId })
  };
}
