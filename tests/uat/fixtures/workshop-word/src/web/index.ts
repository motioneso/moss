import { h, useEffect, useState, type ReactNodeLike } from "@moss/module-web-sdk";

const MODULE_ID = "uat-workshop-word";
const WORD_ID = "quasar";

type Invocation = { invocation?: { status?: string; result?: { savedWords?: unknown } } };

async function readSaved(): Promise<boolean> {
  const response = await fetch(`/api/ai/assistant-tools/${MODULE_ID}.word.list/invoke`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: {} })
  });
  if (!response.ok) throw new Error(`Read failed (${response.status})`);
  const body = (await response.json()) as Invocation;
  const words = body.invocation?.result?.savedWords;
  if (
    body.invocation?.status !== "succeeded" ||
    !Array.isArray(words) ||
    words.some(
      (word: unknown) =>
        typeof word !== "object" || word === null || !("wordId" in word) || word.wordId !== WORD_ID
    )
  )
    throw new Error("The worker did not return a valid saved-word list");
  return words.length > 0;
}

async function runQueue(queue: "word-save" | "word-remove") {
  const response = await fetch(`/api/modules/${MODULE_ID}/queues/${MODULE_ID}.${queue}/run`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobKind: `${MODULE_ID}.${queue}`, params: { wordId: WORD_ID } })
  });
  if (response.status === 429)
    return { accepted: false, message: "Too many requests — try again later." };
  if (response.status !== 202)
    return { accepted: false, message: `Couldn't queue the change (${response.status}).` };
  const body = (await response.json()) as { jobId?: string | null };
  if (body.jobId !== null && typeof body.jobId !== "string")
    throw new Error("Invalid queue acknowledgement");
  return {
    accepted: true,
    message: body.jobId
      ? "Queued — waiting for confirmation."
      : "Already queued — waiting for confirmation."
  };
}

async function waitForSaved(expected: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await readSaved()) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function Root(): ReactNodeLike {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("Loading saved words…");

  const refresh = () => {
    void readSaved()
      .then((value) => {
        setSaved(value);
        setMessage(value ? "Saved in your private list." : "Not saved yet.");
      })
      .catch(() => setMessage("Couldn't read saved words."));
  };
  useEffect(refresh, []);

  const mutate = (queue: "word-save" | "word-remove", expected: boolean) => {
    setPending(true);
    void runQueue(queue)
      .then(async (status) => {
        setMessage(status.message);
        if (!status.accepted) return;
        if (await waitForSaved(expected)) {
          setSaved(expected);
          setMessage(expected ? "Saved in your private list." : "Removed from your private list.");
        } else {
          setMessage("The worker did not confirm this change yet. Try again.");
        }
      })
      .catch(() => setMessage("Couldn't queue the change. Try again."))
      .finally(() => setPending(false));
  };

  return h(
    "main",
    { "aria-label": "Workshop Word" },
    h("p", null, "Daily word"),
    h("h1", null, WORD_ID === "quasar" ? "Quasar" : "Word"),
    h("p", { role: "status" }, message),
    h(
      "button",
      {
        type: "button",
        disabled: pending || saved !== false,
        onClick: () => mutate("word-save", true)
      },
      "Save word"
    ),
    h(
      "button",
      {
        type: "button",
        disabled: pending || saved !== true,
        onClick: () => mutate("word-remove", false)
      },
      "Remove saved word"
    )
  );
}

export default { contractVersion: 2, Root };
