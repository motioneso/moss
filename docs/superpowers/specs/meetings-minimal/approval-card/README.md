# Approved presentation references from #3089

These three screens and their dependencies are unchanged copies from #3089 head
`259c12703776033cbf1e72dcf9767d42566dc693`, merged as
`dd0aacd232b6fdaacfbc544ac7f0b9f2db0ec7de`. Ben approved these screens in owner chat on 2026-10-06.

- [Record-backed card](02-change-settings.html): compact action, server-read target, exact field
  rows and Approve / Reject actions.
- [Approved result](04-approved.html): one quiet result line.
- [Declined result](05-declined.html): one quiet result line.

They use synthetic Weather settings data. They show ordinary approval presentation, not Meetings
onboarding or a recording-capability prompt. Do not add one of these cards after linking: the
existing browser linking approval grants the exact Mac's recording capability in the same action.
“Approved” is an approval decision, not proof that an action completed.

The rest of the approved #3089 set remains at [approval-card](../../approval-card/index.html).
The included stylesheet bundle embeds Archivo fonts covered by `FONT-LICENSE.txt`. Source generation
lives with that original set; these reference snapshots are intentionally unchanged.
