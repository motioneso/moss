# Meetings: device pairing mockups

Static design review of device pairing inside Meetings (part 7b of
`docs/superpowers/specs/2026-11-11-rust-phase5-meetings-briefings-plan.md`, section 4a). Approved by
Ben on 2026-11-18. No product code, pairing, credentials or network calls.

Serve from the checkout root and open `index.html` in this folder:

```bash
python3 -m http.server <port> --bind 0.0.0.0
```

Take the port from `devports claim`. The pages reuse the merged Meetings review frame
(`../meetings-redesign/mockups.css`), shipped tokens, `@moss/ui` primitive CSS and the settings row
styles. A real build uses `@moss/ui` components. Names and devices are fictional.

| Screen                              | What it shows                                                     | Primitives                                          |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| [Devices](devices.html)             | Linked Mac and phone, status dot, last contact, Rename and Unlink | section head, settings row, indicator, quiet button |
| [No devices](devices-empty.html)    | Empty state with the two app downloads                            | empty state, secondary button                       |
| [Approve a Mac](approve.html)       | A Mac asks to link; what it will be able to do                    | dialog, primary and secondary button                |
| [Linked](linked.html)               | Devices list after Link Mac, with a status line                   | as Devices                                          |
| [Declined](declined.html)           | After Not this Mac                                                | dialog                                              |
| [Request closed](expired.html)      | The request is too old                                            | dialog                                              |
| [Rename](rename.html)               | Inline rename in the row                                          | field, input, buttons                               |
| [Unlink](unlink.html)               | Confirm before unlinking                                          | dialog, danger button                               |
| [Phone approve](phone-approve.html) | The approval inside the Android app's view                        | dialog                                              |
| [Phone devices](phone-devices.html) | Devices list at 390 px                                            | as Devices                                          |
| [Phone unlink](phone-unlink.html)   | Unlink confirm at 390 px                                          | dialog                                              |

Each screen has a matching PNG in this folder (desktop 1440 px, phone 390 px at 2x).
