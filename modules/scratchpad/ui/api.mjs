/** Module-scoped requests. Keep the error body so revision conflicts reach the editor. */
export function scratchpadApi(client) {
  async function call(method, path, body) {
    const reply = await client.request(method, path, body);
    if (reply && Number.isInteger(reply.status) && "body" in reply) {
      if (reply.status >= 400) throw Object.assign(new Error("Request failed"), reply);
      return reply.body;
    }
    return reply;
  }
  return {
    read: () => call("GET", "/note"),
    save: (body, revision) => call("PUT", "/note", { body, revision }),
    settings: (settings) => call("PATCH", "/settings", settings)
  };
}
