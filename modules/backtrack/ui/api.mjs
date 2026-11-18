/** Calls the Backtrack routes and turns every failure into an error with a status. */
export function backtrackApi(client) {
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
      const failure = new Error("Backtrack request failed");
      failure.status = reply.status;
      throw failure;
    }
    return reply.body;
  }
  return {
    status: () => call("GET", "/status"),
    localDay: (offsetDays = 0) => call("GET", `/local-day?offsetDays=${offsetDays}`),
    setPaused: (paused) => call("PUT", "/preferences", { paused }),
    remove: (range) => call("DELETE", "/segments", range)
  };
}
