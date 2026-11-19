export function commitmentsApi(client) {
  async function call(method, path, body) {
    const result = await client.request(method, path, body);
    if (result && Number.isInteger(result.status) && "body" in result) {
      if (result.status >= 400)
        throw Object.assign(new Error("Commitments request failed"), { status: result.status });
      return result.body;
    }
    return result;
  }
  return {
    async pending() {
      const rows = await call("GET", "/candidates?status=pending_review");
      if (!Array.isArray(rows)) throw new Error("Invalid commitments reply");
      const details = [];
      for (let start = 0; start < rows.length; start += 8) {
        details.push(
          ...(await Promise.all(
            rows.slice(start, start + 8).map(async (row) => {
              try {
                const detail = await call("GET", `/candidates/${encodeURIComponent(row.id)}`);
                return detail.status && detail.status !== "pending_review" ? null : detail;
              } catch (error) {
                if (error.status === 404) return null;
                throw error;
              }
            })
          ))
        );
      }
      return details.filter(Boolean);
    },
    change: (id, status, snoozedUntil) =>
      call("PATCH", `/candidates/${encodeURIComponent(id)}/status`, {
        status,
        ...(snoozedUntil ? { snoozedUntil } : {})
      })
  };
}
