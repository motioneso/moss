/** Calls the News routes and turns every failure into an error with a status. */
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
      const failure = new Error("News request failed");
      failure.status = reply.status;
      throw failure;
    }
    return reply.body;
  }

  // The overview hands out pictures as /api/news/... addresses. Only the two picture routes
  // are fetched, and the host returns each one as a data address the frame can show.
  const PICTURE = /^\/api\/news(\/(?:images|favicon)\/[A-Za-z0-9._~%-]+)$/;
  async function picture(url) {
    const match = PICTURE.exec(String(url));
    if (!match) throw new Error("Not a News picture");
    const body = await call("GET", match[1]);
    if (typeof body?.dataUrl !== "string" || !body.dataUrl.startsWith("data:image/"))
      throw new Error("No picture");
    return body.dataUrl;
  }

  return {
    overview: () => call("GET", "/overview"),
    catalog: () => call("GET", "/catalog"),
    feedback: (storyRef, kind, reason) =>
      call("POST", "/story-feedback", reason ? { storyRef, kind, reason } : { storyRef, kind }),
    picture
  };
}
