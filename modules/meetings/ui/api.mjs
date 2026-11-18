/** Calls the Meetings routes and turns every failure into an error with a status and code. */
export function meetingsApi(client) {
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
      const failure = new Error("Meetings request failed");
      failure.status = reply.status;
      failure.code = reply.body && typeof reply.body === "object" ? reply.body.code : undefined;
      throw failure;
    }
    return reply.body;
  }
  const id = encodeURIComponent;
  return {
    search: (body) => call("POST", "/history/search", body),
    devices: () => call("GET", "/capture/devices"),
    recordingTypes: () => call("GET", "/recording-types"),
    record: (meetingId) => call("GET", `/records/${id(meetingId)}`),
    putTitle: (meetingId, body) => call("PUT", `/records/${id(meetingId)}/title`, body),
    putNotes: (meetingId, body) => call("PUT", `/records/${id(meetingId)}/notes`, body),
    remove: (meetingId) => call("DELETE", `/records/${id(meetingId)}`),
    transcript: (meetingId) =>
      call("GET", `/records/${id(meetingId)}/transcript?maxSegments=500&maxCharacters=100000`),
    evidence: (meetingId, query) =>
      call("GET", `/records/${id(meetingId)}/transcript/evidence?${query}`),
    recording: (meetingId) => call("GET", `/records/${id(meetingId)}/recording`),
    putRecordingType: (meetingId, body) =>
      call("PUT", `/records/${id(meetingId)}/recording/type`, body),
    manual: (body) => call("POST", "/manual-transcripts", body),
    outputs: (meetingId) => call("GET", `/records/${id(meetingId)}/outputs`),
    output: (meetingId, version) => call("GET", `/records/${id(meetingId)}/outputs/${version}`),
    generate: (meetingId, body) => call("POST", `/records/${id(meetingId)}/outputs`, body),
    editOutput: (meetingId, body) => call("PUT", `/records/${id(meetingId)}/outputs`, body),
    review: (meetingId, candidateId, body) =>
      call("POST", `/records/${id(meetingId)}/actions/${id(candidateId)}/review`, body),
    exports: (meetingId) => call("GET", `/records/${id(meetingId)}/exports`),
    saveExport: (meetingId, body) => call("POST", `/records/${id(meetingId)}/exports`, body)
  };
}
