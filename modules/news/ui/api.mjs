/** Calls the News routes. A failure becomes an error with the status and the server's own message. */
export function newsApi(client) {
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
      const failure = new Error(
        typeof reply.body?.error === "string" ? reply.body.error : "News request failed"
      );
      failure.status = reply.status;
      throw failure;
    }
    return reply.body;
  }
  const id = encodeURIComponent;
  return {
    catalog: () => call("GET", "/catalog"),
    prefs: () => call("GET", "/prefs"),
    createPref: (kind, key) => call("POST", "/prefs", { kind, key }),
    deletePref: (prefId) => call("DELETE", `/prefs/${id(prefId)}`),
    personalization: () => call("GET", "/personalization"),
    addExclusion: (source) => call("POST", "/source-exclusions", { source }),
    removeExclusion: (exId) => call("DELETE", `/source-exclusions/${id(exId)}`),
    createTopic: (input) => call("POST", "/topics", input),
    updateTopic: (topicId, input) => call("PATCH", `/topics/${id(topicId)}`, input),
    removeTopic: (topicId) => call("DELETE", `/topics/${id(topicId)}`),
    previewSource: (input) => call("POST", "/sources/preview", { input }),
    confirmSource: (input) => call("POST", "/sources", input),
    removeSource: (sourceId) => call("DELETE", `/sources/${id(sourceId)}`),
    revalidate: () => call("POST", "/revalidation", {}),
    feedback: () => call("GET", "/story-feedback"),
    updateFeedback: (fbId, reason) => call("PATCH", `/story-feedback/${id(fbId)}`, { reason }),
    removeFeedback: (fbId) => call("POST", `/story-feedback/${id(fbId)}/undo`, {})
  };
}
