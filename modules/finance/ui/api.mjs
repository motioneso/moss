/** Calls the Finance routes and turns every failure into an error with a status. */
export function financeApi(client) {
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
      const failure = new Error("Finance request failed");
      failure.status = reply.status;
      const b = reply.body;
      failure.code = typeof b?.code === "string" ? b.code : typeof b?.error === "string" ? b.error : "";
      failure.detail = typeof b?.message === "string" ? b.message : failure.code;
      throw failure;
    }
    return reply.body;
  }
  const query = (params) => {
    const text = new URLSearchParams(
      Object.entries(params).filter(
        ([, v]) => v !== undefined && v !== "" && v !== null && v !== false
      )
    ).toString();
    return text ? `?${text}` : "";
  };
  return {
    call,
    accounts: () => call("GET", "/finance/accounts"),
    budget: (month) => call("GET", `/finance/budget/status${query({ month })}`),
    apply: (body) => call("POST", "/finance/budget/apply", body),
    assignFlex: (body) => call("POST", "/finance/flex/assign", body),
    configure: (body) => call("POST", "/finance/budget/configure", body),
    transactions: (params) => call("GET", `/finance/transactions${query(params)}`),
    setCategory: (body) => call("POST", "/finance/transactions/category", body),
    review: (body) => call("POST", "/finance/transactions/review", body),
    bulkConfirm: (body) => call("POST", "/finance/transactions/bulk-confirm", body)
  };
}
