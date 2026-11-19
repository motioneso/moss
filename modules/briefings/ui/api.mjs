/** Calls the Briefings routes and turns every failure into an error with a status and message. */
export function briefingsApi(client) {
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
        typeof reply.body?.error === "string" ? reply.body.error : "Briefings request failed"
      );
      failure.status = reply.status;
      failure.code = reply.body?.code;
      throw failure;
    }
    return reply.body;
  }
  const id = (value) => encodeURIComponent(value);
  return {
    definitions: () => call("GET", "/definitions"),
    create: (body) => call("POST", "/definitions", body),
    update: (definitionId, body) => call("PATCH", `/definitions/${id(definitionId)}`, body),
    runs: (definitionId) => call("GET", `/definitions/${id(definitionId)}/runs`),
    run: (definitionId, runId, jobId) =>
      call(
        "GET",
        `/definitions/${id(definitionId)}/runs/${id(runId)}${jobId ? `?jobId=${id(jobId)}` : ""}`
      ),
    today: () => call("GET", "/today"),
    triage: (taskId, action) =>
      call("POST", `/today/rows/${id(taskId)}`, { action }),
    start: (definitionId, idempotencyKey) =>
      call("POST", `/definitions/${id(definitionId)}/run`, { idempotencyKey })
  };
}
