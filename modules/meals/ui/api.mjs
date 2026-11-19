/** Calls the Meals screen route. Every tool answers `{data}`; a refusal is `{data:{error,code}}`. */
export function mealsApi(client) {
  async function post(tool, parameters, confirmed) {
    let reply;
    try {
      reply = await client.request("POST", "/meals/screen/tool", {
        tool,
        parameters,
        ...(confirmed ? { confirmed: true } : {})
      });
    } catch (error) {
      if (!Number.isInteger(error?.status)) throw error;
      reply = { status: error.status, body: error.body };
    }
    if (!(reply && typeof reply.status === "number" && "body" in reply)) {
      reply = { status: 200, body: reply };
    }
    return reply;
  }
  const refused = (data) =>
    data && typeof data === "object" && typeof data.error === "string" && "code" in data;

  return {
    /** Returns the tool's data, or throws when it cannot be read. */
    async read(tool, parameters = {}) {
      const reply = await post(tool, parameters, false);
      const data = reply.body?.data;
      if (reply.status >= 400 || data === undefined || refused(data)) {
        throw new Error("Meals read failed");
      }
      return data;
    },
    /** Never throws. Outcome is `{kind:"succeeded", result}`, `rejected`, `invalid_input` or `failed`. */
    async write(tool, parameters, { confirmed = false } = {}) {
      let reply;
      try {
        reply = await post(tool, parameters, confirmed);
      } catch {
        return { kind: "failed" };
      }
      const data = reply.body?.data;
      if (reply.status >= 400 || data === undefined) return { kind: "failed" };
      if (refused(data)) {
        return data.code === "invalid_input"
          ? { kind: "invalid_input" }
          : { kind: "rejected", code: data.code };
      }
      return { kind: "succeeded", result: data };
    }
  };
}

/** The message for an outcome that needs one. Success returns null. */
export function noticeFor(outcome) {
  switch (outcome.kind) {
    case "succeeded":
      return null;
    case "rejected":
      return "Meals did not accept that change. Check it and try again.";
    case "invalid_input":
      return "That entry was not valid. Check it and try again.";
    default:
      return "Moss could not confirm that change. Refresh the page and check before trying again.";
  }
}
