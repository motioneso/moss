export const recordingNoticeFeature = {
  id: "meetings.side_review_notices",
  description:
    "Below 80% personal/work confidence, Main gets the chosen side, reason and recording link once. Title/type edits keep pending notices. Pending notices survive delivery retries and recover on a Main refresh.",
  errors: [
    {
      code: "no_main",
      class: "prerequisite",
      description: "The current recording notice is waiting for a Main chat.",
      remediationRef: "meetings.open_main_for_side_review"
    }
  ],
  remediations: [
    {
      id: "meetings.open_main_for_side_review",
      path: "/chat",
      description:
        "Open Main and send a message if it is empty, then reload. Refreshing Main recovers pending recording notices after background retries stop."
    }
  ]
} as const;
