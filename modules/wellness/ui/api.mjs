/** Calls the Wellness routes and turns every failure into an error with a status. */
export function wellnessApi(client) {
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
      const failure = new Error("Wellness request failed");
      failure.status = reply.status;
      failure.detail = typeof reply.body?.error === "string" ? reply.body.error : "";
      throw failure;
    }
    return reply.body;
  }
  const query = (params) => {
    const text = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)
    ).toString();
    return text ? `?${text}` : "";
  };
  const PAGE = 500;
  const MAX_PAGES = 20;
  return {
    call,
    localDay: () => call("GET", "/wellness/local-day"),
    checkinsPage: (params) => call("GET", `/wellness/checkins${query(params)}`),
    /** Every check-in since a moment, following the cursor, newest first. */
    async checkinWindow(since) {
      const items = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await call(
          "GET",
          `/wellness/checkins${query({ since, limit: PAGE, cursor })}`
        );
        items.push(...(body.checkins ?? []));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      return items;
    },
    schedule: (date) => call("GET", `/wellness/medications/schedule${query({ date })}`),
    adherence: (sinceDays) => call("GET", `/wellness/medications/logs${query({ sinceDays })}`),
    logDose: (id, body) => call("POST", `/wellness/medications/${id}/logs`, body),
    medications: () => call("GET", "/wellness/medications"),
    createMedication: (body) => call("POST", "/wellness/medications", body),
    changeMedication: (id, body) => call("PATCH", `/wellness/medications/${id}`, body),
    createCheckin: (body) => call("POST", "/wellness/checkins", body),
    changeCheckin: (id, body) => call("PATCH", `/wellness/checkins/${id}`, body)
  };
}
