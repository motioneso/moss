# Chat send-to-reply conventions (primary sources only)

**Date:** 2026-09-07
**Scope:** How mainstream chat interfaces handle the send-to-reply cycle: optimistic display, delivery states, typing indicators, failure/retry, grouping and timestamps.
**Method:** Official support pages, help centers, platform developer docs, and first-party API references only. No secondary write-ups. One citation per claim; source list at the end.

---

## 1. Optimistic display on send

- Every surveyed client renders the outgoing message in the thread immediately, carrying a pending affordance until the send resolves, rather than waiting for confirmation before showing it.
  - Signal shows a **Sending** state on the in-thread message meaning "in the process of being sent," and advises checking the internet connection if it persists. ([S1](#sources))
  - Messenger shows an unfilled **blue circle** ("sending") on the right side of the in-thread message. ([M1](#sources))
  - iMessage keeps an unconfirmed message in the thread; only on failure does it annotate it with a red exclamation mark and "Not Delivered." ([A1](#sources))

## 2. Sending / sent / delivered / read states and their visuals

- Signal uses four icon states: **Sending** (in progress); **Sent** (reached the Signal service, which rules out a problem with the sender's connectivity); **Delivered** (reached the recipient's device); **Read** (recipient read it, only if both sides have read receipts on). ([S1](#sources), [S2](#sources))
- Messenger uses four visuals, all on the right side of the message: unfilled **blue circle** = sending; blue circle **with a check** = sent; **filled-in** blue circle with a check = delivered; a small version of the **recipient's profile picture** below the message = seen. ([M1](#sources))
- WhatsApp's official status vocabulary is: `sent` = left WhatsApp servers (UI: **one checkmark**); `delivered` = reached the user's device (UI: **two checkmarks**); `read` = displayed in an open chat thread on the user's device (UI: **two blue checkmarks**); `failed` (UI: **red error triangle**); plus `played` for voice messages (UI: **blue microphone**). A message counts as read only if it was delivered, and when both happen at once the delivered event is skipped as implied. ([W1](#sources), [W2](#sources))
- Telegram uses two states with different semantics: **one check** = delivered to the Telegram cloud and the friend notified (if they allow notifications); **two checks** = read (friend opened the conversation). Telegram explicitly has **no "delivered to device"** state, because an account can run on any number of devices. ([T1](#sources))
- Teams collapses to two confirmations: **sent** vs **Seen** (checkmark icon). A Seen receipt is issued only if the recipient is **active in the chat window**; viewing from a notification, the Activity feed, a banner, or a profile preview does not trigger it, and receipts require both sides (same org) to have the feature on. It is on by default but admin-gated. ([MS1](#sources))
- Google Messages (RCS) gates read receipts ("let others know you've read their messages") and typing indicators behind per-feature toggles under RCS-chats settings, and the compose-bar send icon always shows which channel the message will use (Wi-Fi/mobile data vs SMS vs MMS). ([G1](#sources))
- Read receipts are mutual or opt-in everywhere surveyed: both sides must enable them in Signal; everyone in the chat must have them on in Teams; both sides must turn them on in Google Messages. ([S2](#sources), [MS1](#sources), [G1](#sources))
- WhatsApp read state is set by explicitly marking a message as read, which produces the two blue checkmarks ("read receipts"). ([W2](#sources))

## 3. Typing / thinking indicators and their animation

- Signal's typing indicator is **animated dots**, optional, and symmetric: turning it off both hides your typing from contacts and hides theirs from you; both sides must have it enabled for either to see it. ([S3](#sources))
- Google Messages exposes typing visibility as a single "Show typing indicators" toggle. ([G1](#sources))
- Telegram models correspondent activity as a typed event vocabulary (`SendMessageAction`): typing, recording audio/video/round video, uploading photo/video/audio/document/round video, sharing location, choosing a contact, plus an explicit **cancel** action. Clients render these as status text such as "typing…", "uploading a photo…", "recording a voice message…". ([T2](#sources), [T3](#sources))
- Messenger's platform treats typing and read-receipt indicators as programmatically controlled **sender actions**; the documented pattern is to set the read-receipt indicator when processing begins and the typing indicator while a response is in progress, so the other side sees that a reply is coming. ([M2](#sources))
- WhatsApp's Business API offers a typing indicator for the case where "it may take you a few seconds or more to respond," i.e. an explicit hold-on signal while preparing a response. ([W2](#sources))
- None of the surveyed human-chat primaries specifies a distinct "thinking/working" indicator or any animation spec beyond Signal's animated dots; "thinking" as a separate state was not found in these sources.

## 4. Failure states and retry affordances

- iMessage marks a failed send with a **red exclamation mark** plus a "Not Delivered" alert; tapping it offers **Try Again**, and if that still fails, **Send as Text Message** over a fallback channel (rates may apply). ([A1](#sources))
- Signal's stuck-Sending checklist is: confirm internet, re-enable phone permissions, disable interfering VPN/firewall apps, delete a large attachment stuck ahead of it in the queue, complete any captcha. Messages sent but undelivered before a safety-number change **never deliver** and must be written and sent again. ([S4](#sources))
- Messenger attributes unsendable messages to rate limits, Community Standards restrictions (temporary send block), or app/device/internet problems, surfacing a **"No internet connection"** error; its remedies are restart, update the app, check connectivity and storage, and check block/deactivation status. ([M3](#sources))
- Google Messages offers a **Resend messages** setting choosing how a failed RCS-over-data send is retried, including an SMS-with-link option (with a warning that the media link is public and not Google-controlled). ([G1](#sources))
- WhatsApp failures arrive as a `failed` status carrying a structured `errors[]` entry (code, title, message); the client equivalent is the red error triangle. ([W1](#sources))

## 5. Message grouping and timestamps

- Receipt visuals attach to individual messages, and "seen" annotates the **latest** message: Messenger puts the recipient's profile picture **below the message** they have seen, with status icons on the right side of each message. ([M1](#sources))
- Teams resolves group reads per message: in groups of **20 people or fewer**, a **Read by** list on the message names who has seen it, and the Seen confirmation appears only once everyone has read it. ([MS1](#sources))
- Signal keeps exact times one gesture away: tap-and-hold a bubble then **info** on mobile (or hover inside the bubble and click info on desktop) to see the timestamp it was sent or delivered. ([S5](#sources))
- WhatsApp records time per state transition: every status webhook carries its own trigger **timestamp**, so sent, delivered, read, and played each have an independent time. ([W1](#sources))
- Gap: none of the surveyed primaries normatively specifies bubble grouping (collapsing tails/avatars across consecutive messages from one sender). Grouping appears to be client-rendering behavior, not documented platform contract; only the receipt-attachment patterns above are specified.

---

## Sources

- <a id="sources"></a>[S1] Signal Support, "How do I know if my message was delivered or read?" — https://support.signal.org/hc/en-us/articles/360007320751
- [S2] Signal Support, "Read Receipts" — https://support.signal.org/hc/en-us/articles/360007059812-Read-Receipts
- [S3] Signal Support, "Typing Indicators" — https://support.signal.org/hc/en-us/articles/360020798451-Typing-Indicators
- [S4] Signal Support, "Troubleshooting sending messages" — https://support.signal.org/hc/en-us/articles/360009303072-Troubleshooting-sending-messages
- [S5] Signal Support, "View Message Details" — https://support.signal.org/hc/en-us/articles/360054649071-View-Message-Details
- [M1] Messenger Help Center, "How to know if your message was sent, delivered or seen on Messenger" — https://www.facebook.com/help/messenger-app/926389207386625
- [M2] Messenger Platform docs, "Conversation Components" (Sender Actions) — https://developers.facebook.com/documentation/business-messaging/messenger-platform/introduction/conversation-components
- [M3] Messenger Help Center, "Unable to send or see messages on Messenger" — https://www.facebook.com/help/messenger-app/1723537124537415/
- [W1] WhatsApp Business Platform docs, "Status messages webhook reference" — https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status
- [W2] WhatsApp Business Platform docs, "Service messages" (Read receipts; Typing indicators) — https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- [T1] Telegram FAQ, "What do the check marks mean?" — https://telegram.org/faq
- [T2] Telegram API schema, `messages.setTyping` — https://core.telegram.org/method/messages.setTyping
- [T3] Telegram API schema, `SendMessageAction` — https://core.telegram.org/type/SendMessageAction
- [MS1] Microsoft Support, "Use read receipts for messages in Microsoft Teams" — https://support.microsoft.com/en-gb/office/use-read-receipts-for-messages-in-microsoft-teams-533f2334-32ef-424b-8d56-ed30e019f856
- [G1] Google Messages Help, "Turn on RCS chats in Google Messages" — https://support.google.com/messages/answer/7189714?hl=en
- [A1] Apple Support, "If you can't send or receive messages on your iPhone or iPad" — https://support.apple.com/en-us/118433
