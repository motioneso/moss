# Microsoft 365 mail access when users cannot register apps

**Research and source access date:** 2026-10-21

**Scope:** Authentication and integration feasibility; no product implementation or live mailbox scraping.

**Status:** Findings for discussion, not an approved connector spec.

## Recommendation

Keep two candidate experiences separate:

1. **Automatic mailbox synchronization:** an operator-registered, publisher-verified multitenant Microsoft Graph application is the strongest supported product path. Users do not create app registrations. Their employer still controls consent and access; some organizations will require IT approval.
2. **User-selected capture:** a local browser extension or Outlook add-in can offer “share this selected email” without a mailbox-wide Graph connector. Installation and data transfer must still be permitted. This is a different product capability from unattended mailbox synchronization.

Browser scraping is technically plausible, but it is not evidence of authorization, freedom from monitoring, or reliable full-mailbox synchronization. Do not treat it as the automatic fallback after an explicit organizational access denial.

| Route                                | Needs a user-created work-tenant app registration?   | Useful scope                               | Remaining constraints                                                                |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Operator-owned multitenant Graph app | No                                                   | Reliable API-based sync                    | Operator needs registration/verification; employer controls consent and access       |
| Outlook Office.js add-in             | No, for current-item APIs                            | User-selected opened message               | Add-in installation, supported client/API, permitted transfer destination            |
| Browser extension or UI automation   | No, for rendered-page extraction                     | Selected-message capture; fragile crawling | Installation/automation policy, running browser/session, DOM changes                 |
| Power Automate Outlook connector     | No custom registration                               | Cloud new-message workflow                 | Connector access, data policies, delivery connector, licensing                       |
| Manual `.eml` export                 | No                                                   | One-message ingestion experiment           | Manual action; permitted export and transfer; no sync                                |
| Classic Outlook Windows COM helper   | No custom registration for local object-model access | Client-specific desktop automation         | Classic Windows only, install/trust settings, security prompts, desktop availability |

These are technical routes, not a prediction that a specific employer permits them. Sources and distinctions follow.

## What the compatibility experiment established

- A Microsoft Graph Explorer request listing one message ID succeeded.
- Its permissions panel showed an existing `Mail.ReadWrite` grant with `AllPrincipals` consent type. This supports the interpretation that Graph Explorer already had organization-wide administrator consent; the experiment did not establish user-consent policy for another app.
- The user could not create a new app registration in the work tenant. This establishes a registration obstacle, not that all third-party app sign-ins are forbidden.
- A disposable loopback-only native-app OAuth/PKCE probe was prepared and checked locally, but no own-app Microsoft sign-in was completed. The probe server was stopped and its reserved port released when the registration obstacle was reported.
- No experiment established whether employer monitoring generated alerts. Graph Explorer success does not prove that a new app, hosted service, background refresh, or off-device AI processing would be allowed.

These are observations from the compatibility experiment, not claims about all Microsoft 365 tenants. No credentials, tokens, account identifiers, message identifiers, or mailbox content belong in this note.

## Registration and consent are separate controls

Microsoft documents a **Register applications** setting that can stop ordinary users creating application registrations. Separately, the tenant controls whether users may grant permissions to applications. Disabling registration does not by itself establish the consent setting. [Default user permissions](https://learn.microsoft.com/en-us/entra/fundamentals/users-default-permissions), [Configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent).

A multitenant app's registration lives in the developer's home tenant. A successful, permitted consent flow creates a local service principal in the customer's tenant. The end user does not need to create the developer's app registration inside the employer's tenant. We still need a tenant we control and permission to register an app there; an ordinary personal Microsoft login is not evidence that those prerequisites exist. [Multitenant app setup and consent](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant), [Application objects and service principals](https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals).

For the intended first mail-reading feature, use **delegated `Mail.Read`**, not application-wide mail permissions or `Mail.ReadWrite`. The permission reference marks delegated `Mail.Read` as not inherently requiring admin consent, but organizational consent rules may still require it. `Mail.Read` permits reading mailbox contents; fetching one identifier does not narrow the permission to that identifier. `Mail.ReadBasic` excludes bodies and attachments and cannot support body-based summarization. [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread).

Publisher verification matters for adoption but is not a security certification or a guarantee of consent. Microsoft says newly registered, unverified multitenant apps asking for permissions beyond basic sign-in/profile can trigger risk-based step-up consent. The resulting event may explicitly record **Risky application detected**. A newly minted unverified app is therefore a poor experiment when avoiding unexpected security alerts is the main objective. [Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview), [Risk-based step-up consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent).

If the employer requires approval, Microsoft offers an admin-consent request workflow, when enabled by the employer. Requesting approval can email designated reviewers; it is not a silent operation. [Admin-consent workflow](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow).

## Browser capture: possible, with a narrower promise

A content script in an installed extension can read a permitted page's DOM. Chrome's `activeTab` capability can grant temporary access following an explicit user gesture, rather than persistent access to every website. The sensible first scope is the rendered message the user deliberately chooses, with a local preview and a separate explicit action before anything is transferred to Moss. [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

A standalone HTML page served by Moss cannot simply read a separately opened Outlook tab: browser same-origin restrictions normally prevent cross-origin document access. Browser capture needs a permitted extension/content script, desktop browser automation, or an explicit copy/export from the user. [Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy).

**Engineering inferences, not live Outlook findings:** DOM extraction only sees what the page has rendered. Loading additional messages and history requires UI interaction; layout, localization, and client changes can break selectors. An unattended scraper also needs a running browser, a valid session, and handling for MFA/session interruptions. Opening messages can affect mailbox state depending on Outlook's read settings, so “the scraper never sends mail” is not proof of zero mailbox side effects.

Avoid extracting cookies, access tokens, or private Outlook API credentials and replaying them elsewhere. Avoid using Graph Explorer's app identity as Moss's identity. Those approaches change the identity/trust boundary and provide no legitimate proof that Moss itself is approved. The technical alternative under consideration is visible, permitted page capture, not reuse of another application's credentials.

Browser extraction avoids a new Graph consent request only if it genuinely operates on the existing rendered page. It does not avoid endpoint controls or rules about transferring work information. Microsoft documents configurable controls that can audit or restrict sensitive-file uploads and browser pastes; these do not prove what controls exist on a particular device or that every DOM extraction is detected. [Microsoft Purview Endpoint DLP](https://learn.microsoft.com/en-us/purview/endpoint-dlp-learn-about).

## Other supported routes

### Outlook Office.js add-in

Microsoft's add-in permission model allows **`ReadItem`** to read properties of the current item, including its body. A small HTML/JavaScript task pane can therefore use documented current-item APIs without first acquiring Graph mailbox permissions. This is an inference from the documented API/permission model, not a tested add-in. It offers a supported alternative to DOM selectors for a deliberate “share this opened email” interaction. [Outlook add-in overview](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/outlook-add-ins-overview), [Add-in permissions](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/understanding-outlook-add-in-permissions).

Add-in installation is separately controlled: user roles such as **My Custom Apps** govern custom installations, so an app-registration denial does not establish whether add-ins are allowed. Microsoft documents test sideloading, but an administrator can restrict it. Event-based activation has specific supported events, deployment requirements, and runtime limits; it is not a general always-on inbox daemon. Legacy Exchange Online add-in identity/callback tokens are retired, so older samples using those tokens do not provide a mailbox-wide access shortcut. [Sideloading](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/sideload-outlook-add-ins-for-testing), [Admin controls](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/office-addins?view=o365-worldwide), [Event-based activation](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/event-based-activation), [Legacy-token status and permissions](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/understanding-outlook-add-in-permissions).

### Browser extension installation

Edge enterprise policy can block all extensions, including unpacked extensions. A user-triggered extension with temporary tab access reduces the requested browser access compared with an all-sites reader, but it does not defeat managed-browser installation policy. [Edge extension blocklist](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensioninstallblocklist), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

### Power Automate

Microsoft's **Office 365 Outlook connector** is classified **Standard** and supports mail triggers/retrieval through the user's connector sign-in. It can provide a cloud workflow without developing a custom Entra app registration; this is an integration inference from the documented connector model. Its own authentication can still be blocked by Conditional Access. Transferring messages onward to Moss requires a delivery mechanism that is actually allowed and licensed. [Office 365 Outlook connector](https://learn.microsoft.com/en-us/connectors/office365/).

Power Platform data policies can prevent combining business and nonbusiness connectors or block connectors. Standard Outlook access does not establish entitlement to arbitrary HTTP/custom-connector delivery: premium/custom connectors have separate licensing, and the documented **HTTP with Microsoft Entra ID** connector is Premium. Microsoft also documents headers admins can use to identify and block Outlook sending/forwarding performed by Power Automate. This is a supported workflow option, not unmonitored forwarding. [Data policies](https://learn.microsoft.com/en-us/power-platform/admin/wp-data-loss-prevention), [Licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs), [HTTP connector classification](https://learn.microsoft.com/en-us/connectors/webcontents/), [Flow forwarding controls](https://learn.microsoft.com/en-us/power-platform/admin/block-forwarded-email-from-power-automate).

### Manual export

Outlook supports saving a selected message to a file, including `.eml` in the documented new-Outlook/web paths. Exporting one synthetic message and parsing it locally would be the smallest content-ingestion experiment without a new app identity or extension. It proves neither account connectivity nor automatic synchronization. File export and onward transfer remain subject to employer controls. No importer was built or tested here. [Save a message as a file](https://support.microsoft.com/en-us/office/save-a-message-as-a-file-4821bcd4-7687-4d6d-a486-b89a291a56e2).

### Classic Outlook desktop automation

Classic Outlook for Windows exposes a local object model. Reading protected properties such as `Body` can cause security prompts or denials depending on trust/configuration. COM/VSTO support does not carry over to new Outlook for Windows, and COM is not a portable Mac integration. Microsoft warns against unattended, noninteractive Office automation because of stability and interaction problems. This is a platform-specific helper candidate, not a general Moss connector. [Outlook automation](https://learn.microsoft.com/en-us/office/vba/outlook/concepts/getting-started/automating-outlook-from-other-office-applications), [Protected properties](https://learn.microsoft.com/en-us/office/vba/outlook/how-to/security/protected-properties-and-methods), [Classic versus new Outlook](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/get-started/migrate-com-to-web-addins), [Office for Mac](https://learn.microsoft.com/en-us/office/vba/api/overview/office-mac), [Unattended automation limitations](https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa).

### Microsoft tools as diagnostics

Graph Explorer and Microsoft Graph PowerShell can legitimately exercise their own supported access flows. Their tenant consent is specific to those applications. PowerShell supports delegated authentication and a custom-app option for isolating permissions; installing or using it does not establish that its app is already approved. These tools can help an operator diagnose/export permitted data but do not supply a normal end-user Moss integration or justify lifting their client identities into Moss. [Graph Explorer](https://learn.microsoft.com/en-us/graph/graph-explorer/graph-explorer-overview), [Graph PowerShell authentication](https://learn.microsoft.com/en-us/powershell/microsoftgraph/authentication-commands).

### IMAP and app passwords

Password-based IMAP is not a shortcut for Exchange Online. Microsoft removed Basic authentication for IMAP, including the corresponding app-password route. OAuth-based IMAP exists but still requires an app identity, consent, and the protocol being enabled; it does not resolve a consent obstacle. A Graph Explorer mail grant is also not evidence that an IMAP grant exists. [Exchange Online Basic authentication retirement](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online), [OAuth for IMAP/POP/SMTP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).

### Forwarding

Automatic external forwarding is policy-controlled and can be blocked or reported. Microsoft documents organization-dependent behavior of the default system-controlled setting, so do not assume forwarding is available. Manual forwarding also moves work data outside its original boundary and is not an automatic exemption from employer rules. [External email forwarding controls](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding).

## Next experiment, before building a connector

1. Decide whether the immediate requirement is background mailbox synchronization or selected-email capture. They need different proofs.
2. For automatic sync, establish an operator-owned app registration outside the work tenant and review verification/consent requirements before attempting a work-account sign-in. Do not lower employer protections or repeatedly retry an explicit policy refusal.
3. For selected capture, first confirm the browser permits the relevant extension/automation mechanism. A first bounded experiment should extract one deliberately opened synthetic test message into a local preview, make no automatic transfers, and avoid cookies/tokens/private network endpoints. This would test DOM access and extraction, not background sync or organizational approval.
4. Before transferring any work content to Moss or AI, agree the storage, retention, destination, and processing boundary. Using the browser as a transport does not settle those decisions.

No further sign-ins, extension installations, consent requests, mailbox exports, or scraping were performed for this research.
