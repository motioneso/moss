# Connectors package

## 0.1.0

- Add the Connectors package: the list of connection providers, the signed-in person's connection accounts, and the Email and Calendar switches for each account.
- Read and write the same tables as the original server. Secrets are sealed in the original format and never returned, logged or sent through jobs.
- Add the connection health labels for mail and for Outlook calendar, and the Settings, Connections screen.
- Google, IMAP and Outlook sign-in and sync are not included. Revoking an account does not stop any sync job, because this package starts none.
