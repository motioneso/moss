/** Calls the Weather routes and turns every failure into an error with a status and message. */
export function weatherApi(client) {
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
      const failure = new Error(
        typeof reply.body?.message === "string" ? reply.body.message : "Weather request failed"
      );
      failure.status = reply.status;
      throw failure;
    }
    return reply.body;
  }
  return {
    location: () => call("GET", "/location"),
    saveLocation: (place) => call("PUT", "/location", place),
    search: (query) => call("GET", `/location/search?query=${encodeURIComponent(query)}`),
    reverse: (lat, lon) =>
      call(
        "GET",
        `/location/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
      ),
    unit: () => call("GET", "/unit"),
    saveUnit: (unit) => call("PUT", "/unit", { unit }),
    forecast: (params) => {
      const text = new URLSearchParams(params).toString();
      return call("GET", `/forecast${text ? `?${text}` : ""}`);
    }
  };
}
