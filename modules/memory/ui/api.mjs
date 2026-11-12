/** Calls the Memory routes and turns every failure into an error with a status. */
export function memoryApi(client) {
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
      const failure = new Error("Memory request failed");
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
  return {
    facts: (params) => call("GET", `/dashboard${query(params)}`),
    candidates: (params) => call("GET", `/candidates${query(params)}`),
    decide: (id, action, body = {}) => call("POST", `/candidates/${id}/${action}`, body),
    add: (body) => call("POST", "/memories", body),
    pin: (id, pinned) => call("POST", `/graph/facts/${id}/pin`, { pinned }),
    confirm: (id) => call("POST", `/graph/facts/${id}/confirm`, {}),
    correct: (id, replacementText) =>
      call("POST", `/graph/facts/${id}/correct`, { replacementText }),
    markStale: (id) => call("POST", `/graph/facts/${id}/mark-stale`, {}),
    patch: (id, body) => call("PATCH", `/graph/facts/${id}`, body),
    supersede: (id, validTo) => call("POST", `/graph/facts/${id}/supersede`, { validTo }),
    remember: (body) => call("POST", "/graph/facts", body),
    forget: (id) => call("DELETE", `/graph/facts/${id}`)
  };
}
