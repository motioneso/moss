# Trail Marker

## Developer design guide

Version 1.0 · macOS 14 and later

Trail Marker is the native macOS companion for Moss. It securely links one Mac to a user’s existing self-hosted Moss instance and identifies that Mac in Moss. The first release does not capture screenshots, observe activity, or provide coaching.

---

## 1. Product identity

### Naming hierarchy

| Context                                 | Required name             |
| --------------------------------------- | ------------------------- |
| App name in Finder, Settings, and menus | Trail Marker              |
| Short relationship line                 | A Moss companion          |
| Browser authorization title             | Link Trail Marker to Moss |
| Active Sessions product label           | Trail Marker for Mac      |
| Executable/process name                 | Trail Marker              |

Use “Moss Companion” only when referring generically to the product category. Do not present it as the installed app name.

### Logo

Use the three-line Moss mark supplied in `assets/moss-mark.svg`.

- Top bar: medium width.
- Middle bar: longest and gold in full-color brand contexts.
- Bottom bar: shortest.
- All bars are left-aligned and have fully rounded ends.
- Preserve the original 24 × 24 view box and geometry.
- Never redraw the mark as a leaf, tree, shield, trail arrow, or stacked chevron.
- Never combine the mark with a containing badge unless macOS requires an app-icon shape.

The mark identifies Moss ownership. Trail Marker gains its identity from its name, typography, color, illustration, and tone rather than a second logo.

### Logo treatments

| Use                       | Treatment                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------ |
| On bone or light surfaces | Forest top/bottom bars; gold middle bar                                              |
| On forest surfaces        | Bone top/bottom bars; gold middle bar                                                |
| Menu-bar template image   | Solid monochrome; allow macOS to tint                                                |
| Small title-bar mark      | Solid monochrome forest or system label color                                        |
| Disabled                  | System secondary/tertiary label color; never lower opacity below accessible contrast |

Minimum visual size is 16 points. Preferred product-lockup size is 24 points. Keep clear space of at least one bar height on every side.

---

## 2. Design principles

### Native first

Use standard macOS windows, menus, fields, toggles, alerts, sheets, sidebars, keyboard behavior, focus rings, and system icons. Brand the experience through composition and restrained color—not through replacement controls.

### Quietly branded

Trail Marker should feel recognizably Moss without feeling themed. Forest surfaces, bone backgrounds, gold rules, and field-guide numbering are strongest during onboarding. Everyday menus and settings should be calmer and more native.

### State is always explicit

Every connection state includes an icon, a plain-text label, and an appropriate next action. Never communicate status with color alone.

### User control is durable

Disconnect, Quit, and Log Out have different outcomes and must remain visibly distinct. Manual Disconnect persists across app and Mac restarts.

In the interface, Disconnect is labelled **Pause** and Connect is labelled **Resume**, and the Disconnected state reads **Paused** (Ben, 2026-09-23). The behaviour is unchanged: Pause stops all communication without logging out. This guide keeps the Disconnect / Connect names for the behaviour. It is the only pause: there is no separate Focus pause.

### Honest about scope

The first release links the account and identifies the device. Permission copy must state that future capabilities remain inactive and that granting access does not begin observation.

---

## 3. Color system

### Brand colors

| Token             | Light value | Intended use                                   |
| ----------------- | ----------- | ---------------------------------------------- |
| `moss.forest`     | `#173E2B`   | Primary brand surfaces, primary branded action |
| `moss.forestDeep` | `#0E2D1E`   | Dark appearance, hover/pressed forest          |
| `moss.bone`       | `#F3EEDF`   | Branded onboarding surfaces                    |
| `moss.boneRaised` | `#FBF8EF`   | Raised light surfaces and brand cards          |
| `moss.gold`       | `#C79B45`   | Logo middle bar, step numbers, fine rules      |
| `moss.charcoal`   | `#262A27`   | Brand typography on light surfaces             |

### Semantic colors

Prefer macOS semantic colors in application UI:

| Meaning                    | Recommended color             |
| -------------------------- | ----------------------------- |
| Connected / success        | `NSColor.systemGreen`         |
| Reconnecting / attention   | `NSColor.systemOrange`        |
| Sign-in required / failure | `NSColor.systemRed`           |
| Disconnected / inactive    | `NSColor.secondaryLabelColor` |
| Not linked / neutral       | `NSColor.tertiaryLabelColor`  |
| Keyboard focus             | System focus ring             |

Do not override system colors in a way that breaks increased contrast, dark appearance, or accessibility settings.

### Color usage rules

- Gold is an accent, not a body-text color.
- Use forest for branded primary actions only when a standard blue action is not required by platform convention.
- Destructive actions remain system red.
- Settings surfaces use system background materials; bone belongs primarily to onboarding, empty states, and supporting illustrations.
- Dark appearance uses system backgrounds with forest accents. Do not invert bone into a beige dark surface.

---

## 4. Typography

### Application UI

Use the system font through SwiftUI or AppKit. Do not bundle a substitute for SF Pro.

| Role                   | macOS style                               |
| ---------------------- | ----------------------------------------- |
| Window title           | `.headline` or native title-bar treatment |
| Screen heading         | `.title2`, semibold                       |
| Section heading        | `.headline`                               |
| Body                   | `.body`                                   |
| Supporting copy        | `.callout` or `.subheadline`              |
| Metadata               | `.caption`                                |
| Buttons and menu items | Native control typography                 |

### Brand/editorial type

The large serif “Trail Marker” treatment belongs to marketing, onboarding artwork, and documentation—not routine settings or menus. Use New York where available, with a platform-safe serif fallback for non-app collateral.

Uppercase tracking may be used for small field-guide labels such as “GET STARTED” or “DEVICE SETUP.” Keep it at 12 points or larger, use semibold weight, and avoid letter spacing that harms readability.

---

## 5. Layout and spacing

Use an 8-point base grid with 4-point adjustments for compact native controls.

| Token     | Value | Use                                     |
| --------- | ----: | --------------------------------------- |
| `space.1` |  4 pt | Icon-to-label and compact metadata gaps |
| `space.2` |  8 pt | Related controls                        |
| `space.3` | 12 pt | Compact row padding                     |
| `space.4` | 16 pt | Standard group spacing                  |
| `space.5` | 24 pt | Section spacing                         |
| `space.6` | 32 pt | Major onboarding separation             |

### Window geometry

- First-run window target: 640–720 points wide.
- Settings window target: 720–820 points wide and 500–620 points tall.
- Settings sidebar target: 180–210 points wide.
- Menu-bar popover target: 300–340 points wide.
- Maintain native window resizability where content benefits from it.
- Minimum content edge inset: 20 points; use 24–32 points in onboarding.

### Corners and borders

Use native component radii. Custom brand panels may use 10–12 point corner radii. Gold rules are 1 physical pixel where possible and should not frame every surface.

---

## 6. Illustration and field-guide language

The National Parks influence appears through:

- Numbered steps in muted-gold tabs.
- Thin route lines and contour lines.
- Flat forest silhouettes and simple signpost forms.
- Bone paper-like presentation surfaces.
- Short, confident section labels.

Keep this layer subordinate to the UI.

- Use illustration in onboarding side panels, empty states, release notes, and marketing.
- Do not put scenic art behind form controls.
- Do not use distressed textures inside native windows.
- Avoid mascots, literal ranger badges, faux government seals, or novelty camping icons.
- Decorative trees are scenery, never product logos.

---

## 7. Core components

### Primary action

Use a native bordered-prominent button. In branded onboarding it may use forest fill with white text. Provide standard pressed, disabled, focus, and keyboard-default states.

### Secondary action

Use native bordered or plain buttons according to macOS hierarchy. “Cancel,” “Later,” and “Not Now” should not visually compete with the primary action.

### Destructive action

Use system destructive styling for Log Out, Sign Out, and confirmed revocation. Disconnect is not destructive and must not be red.

### Status row

Each status row contains:

1. Status symbol.
2. Status name.
3. One-sentence explanation.
4. Recovery action when applicable.

### Permission row

Each permission row contains the system capability icon, permission name, short scope explanation, explicit state, and “Open System Settings…” action. Supported states are Granted, Not granted, and Denied.

### Moss mark in controls

Use the monochrome three-line mark as a template image in the menu bar. At tiny sizes, keep all bars the same color. Do not attempt a gold center bar in the macOS menu bar.

---

## 8. First-run flow

### Step 1 — Welcome

Title: **Connect your Mac to Moss**

Required content:

- Moss instance URL field.
- “Connect in Browser” primary action.
- Explanation that the browser completes secure sign-in and approval.
- One-account-at-a-time note.

Validation:

- Remote instances require HTTPS.
- HTTP is permitted for `localhost`, `127.0.0.1`, and `[::1]`.
- Use inline validation adjacent to the URL field.
- Preserve the entered URL when an error occurs.

### Step 2 — Waiting for browser approval

Show progress, “Cancel,” and “Open Browser Again.” Do not imply that the app is frozen. Cancelling returns to the editable URL state.

### Step 3 — Browser approval

Title: **Link Trail Marker to Moss?**

Show:

- Account name and email.
- Device name.
- Requested access: account identity and this device’s connection.
- Approve and Cancel.
- Copy stating that future capabilities request additional access separately.

### Step 4 — Device setup

- Device name defaults to the Mac computer name and remains editable.
- Start at login defaults off.
- Accessibility and Screen Recording are optional.
- “Skip for Now” remains available and does not block connection.

Required copy: **These permissions prepare future capabilities. Trail Marker is not observing your activity.**

### Step 5 — Success

Show the instance, account, device name, and explicit Connected status. The final action closes onboarding and leaves Trail Marker in the menu bar.

---

## 9. Connection states

| State            | Meaning                                          | Symbol            | Primary action      |
| ---------------- | ------------------------------------------------ | ----------------- | ------------------- |
| Connected        | Linked, authenticated, and reachable             | Check             | Pause               |
| Paused           | User deliberately disabled communication         | Pause             | Resume              |
| Reconnecting     | Connection enabled; Moss temporarily unreachable | Circular arrows   | Retry Now           |
| Sign-in required | Credential expired or access was revoked         | Key or lock       | Sign In             |
| Not linked       | No account is connected                          | Broken/empty link | Set Up Trail Marker |

### Behavioral requirements

- Disconnect persists across app and Mac restarts.
- Disconnect stops communication immediately and queues nothing for later upload.
- Quit retains login and the selected connection state.
- Log Out removes the local credential and attempts server-side revocation.
- Remote revocation transitions to Sign-in required.

---

## 10. Menu-bar menu

Order items consistently:

1. Status summary.
2. Connected instance and account.
3. State-specific primary action: Pause All, Resume All, Retry, or Sign In. While running, **Pause All** is a quieter outlined button with a pause icon; while paused, **Resume All** is the prominent forest button with a play icon, so the paused state reads at a glance (Ben, 2026-09-23).
4. One switch row per feature that is turned on in Settings (Focus; Backtrack when it ships). Each
   switch pauses or resumes only its feature; the connection stays up.
5. Open Moss.
6. Settings…
7. Log Out… when linked.
8. Quit Trail Marker.

Pause All stops everything, including the connection to Moss. While it is on, the feature switches
keep their positions but are greyed and can't be changed, so Resume All brings back exactly what was
running. A switched-off Focus reads "Focus paused" in the status line, so it is never confused with
the connection's "Paused" (Ben, 2026-09-23; supersedes the single-Pause note of the same day).

Controls use the Moss forest (`#173E2B`) as the app's accent colour, not the system blue: the primary
button, the switches and the Settings sidebar selection (Ben, 2026-09-23).

Check for Updates lives in Settings, under Updates, not in the menu.

Use separators between status, navigation/actions, account actions, and Quit. Include standard keyboard shortcuts only where they do not conflict with system conventions.

The menu-bar icon is the monochrome Moss mark and should be implemented as a template image so macOS handles light/dark tinting and highlighted state.

---

## 11. Settings window

Use one native settings window with sidebar navigation.

### Connection

- Instance URL.
- Account name and email.
- Current state and last successful contact.
- Pause/Resume or Retry.
- Log Out.

Changing the instance or account requires Log Out first.

### This Mac

- Editable device name.
- Start at login toggle.

### Permissions

- Accessibility status and action.
- Screen Recording status and action.
- Explanation of future use and current inactivity.
- Do not prompt again at every launch after the user skips.

### Updates

- Installed version.
- Automatic update checks toggle.
- Check Now.
- Available update summary.
- Install and Restart / Later.
- Failure message with Try Again and View Details.

---

## 12. Moss web integration

Under **Settings → Profile & account → Active sessions**, add a **Mac companions** group.

Each row shows:

- Device name.
- Product label: Trail Marker for Mac.
- Connection or last-seen status.
- Relevant instance/device metadata.
- Existing Sign Out control.

One account may link multiple Macs. Each Mac is independently revocable. Include a **Download Trail Marker for Mac** link near the group heading.

After remote revocation, confirm in the browser and transition the affected Mac to Sign-in required.

---

## 13. Exceptional states and copy

| Condition            | Message                                                                             | Actions                        |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------ |
| Invalid URL          | Enter a valid Moss instance URL.                                                    | Keep focus in field            |
| Remote HTTP URL      | Use HTTPS for remote Moss instances.                                                | Edit URL                       |
| Unreachable instance | Can’t reach this Moss instance. Check the URL and network connection.               | Edit URL, Retry                |
| Incompatible version | This Moss version isn’t compatible with Trail Marker.                               | Learn More, Cancel             |
| Browser cancelled    | Linking was cancelled. Nothing was changed.                                         | Try Again, Cancel              |
| Linking failed       | This Mac couldn’t be linked.                                                        | Try Again, View Details        |
| Permissions missing  | You’re still connected. Future features will remain off.                            | Open System Settings…, Not Now |
| Remote revocation    | Your Trail Marker access was revoked from Moss.                                     | Sign In, Log Out               |
| Offline logout       | Logged out on this Mac. Server-side revocation couldn’t be confirmed while offline. | Dismiss, Learn More            |
| Update available     | A new Trail Marker update is ready.                                                 | Install and Restart, Later     |
| Update failed        | The update couldn’t be installed.                                                   | Try Again, View Details        |

Avoid internal error codes in primary messages. Put diagnostics behind View Details and ensure they can be copied.

---

## 14. Light and dark appearance

- Use semantic system backgrounds and labels wherever possible.
- Keep the Moss mark geometry unchanged.
- In dark appearance, use forest for selected accents only when it remains distinguishable from the system background.
- Gold remains restrained and must meet contrast requirements when it conveys information.
- Illustrations may darken, but should preserve low visual priority behind controls.
- Validate Vibrancy/Reduce Transparency combinations.

---

## 15. Accessibility

### Keyboard

- Every action is keyboard reachable in logical reading order.
- Respect standard Escape and Return behavior in sheets and alerts.
- Show the native focus ring; never replace it with a gold outline.
- Do not assign custom shortcuts that override common macOS commands.

### VoiceOver

- Menu-bar icon label: “Trail Marker.”
- Status values are announced as text, not inferred from icon color.
- The Moss mark is decorative when adjacent to the product name.
- Permission rows announce capability, current state, and action.
- Progress indicators include a meaningful label.

### Visual

- Meet WCAG AA contrast for text and essential icons.
- Support Increase Contrast, Reduce Transparency, and Reduce Motion.
- Maintain usability at larger accessibility text sizes.
- Avoid relying on fine gold rules as the only boundary between interactive areas.

### Motion

Use restrained system progress animation for reconnecting and browser waiting. Avoid scenic parallax, decorative looping motion, or pulsing status indicators.

---

## 16. App icon and menu-bar icon

### Menu-bar icon

Use the monochrome three-line mark from `assets/moss-mark-monochrome.svg` as the source for an `NSImage` template. Test at 16, 18, and 20 points on standard and Retina displays.

### App icon

Use the Moss mark centered within a restrained forest-and-bone macOS icon composition. The mark remains the same; do not create a Trail Marker-specific tree or arrow emblem. Avoid detailed landscape art at small sizes.

Export all required macOS icon sizes and verify that the bars remain distinct at 16 pixels.

---

## 17. Engineering notes

- Store credentials in macOS Keychain.
- Treat connection enablement separately from authentication state.
- Persist manual Disconnect independently of app termination.
- Do not request Accessibility or Screen Recording on every launch.
- Treat permission state as informational in v1; it must not gate account linking.
- Use system APIs to open the appropriate Privacy & Security pane.
- Make server revocation best effort during logout and surface offline uncertainty.
- Keep state transitions deterministic and observable by UI tests.

Suggested view-model state:

```swift
enum ConnectionState {
    case notLinked
    case connected
    case disconnected
    case reconnecting
    case signInRequired
}
```

Do not collapse `disconnected` and `reconnecting`; they represent different user intent.

---

## 18. Acceptance checklist

- [ ] App is named Trail Marker in all user-facing macOS surfaces.
- [ ] “A Moss companion” appears in onboarding/about contexts.
- [ ] Only the official three-line Moss mark is used.
- [ ] Menu-bar icon is a monochrome template image.
- [ ] All five connection states include icon and text.
- [ ] Disconnect persists after relaunch and restart.
- [ ] Quit preserves login and connection preference.
- [ ] Log Out removes the local credential.
- [ ] URL validation permits local HTTP and requires remote HTTPS.
- [ ] Browser approval names the account and Mac and lists limited access.
- [ ] Permissions remain optional and do not block connection.
- [ ] Missing/denied permissions have a later recovery path.
- [ ] Settings include Connection, This Mac, Permissions, and Updates.
- [ ] Active Sessions identifies Trail Marker devices and allows independent revocation.
- [ ] Remote revocation produces Sign-in required.
- [ ] Offline logout explains that server revocation is unconfirmed.
- [ ] Update available and failure states are implemented.
- [ ] Light/dark, keyboard, VoiceOver, contrast, reduced motion, and increased contrast are tested.

---

## 19. Reference status

The included Trail Marker board defines visual character, not literal implementation geometry. Native macOS components, the copy and semantics in this guide, and accessibility behavior take precedence over generated details in the image.
