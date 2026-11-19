# Email package

## 0.5.0

- Add public calls `getBriefingSource` and `setBriefingSource` so Briefings can read and change the signed-in person's Include in briefings switch. They share storage with the Email settings screen and touch only the caller's own preference.

## 0.1.0

- Add the Email package: the cached mail messages of the signed-in person (and messages shared with them), and the Email settings.
- Read and write the same table and preferences as the original server, with the same defaults when a choice was never saved.
- Add the Settings, Email screen for briefings, task capture mode and drafted replies.
- Add a public interface so Connectors can add and update cached messages.
- Sync, sending mail and reading mail with a model are not included. This package never contacts a mail service.
