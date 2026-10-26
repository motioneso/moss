import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  HardwareNavLink,
  isMossAndroid,
  MOSS_ANDROID_HARDWARE_URL
} from "../../apps/web/src/settings/settings-hardware-link";

const APP_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile MossAndroid/1.0";
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
const PHONE_BROWSER_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";

describe("Settings Hardware entry", () => {
  it("shows only when the Android app marker is present", () => {
    expect(isMossAndroid(APP_AGENT)).toBe(true);
    expect(isMossAndroid(BROWSER_AGENT)).toBe(false);
    expect(isMossAndroid(PHONE_BROWSER_AGENT)).toBe(false);
  });

  it("renders a link to the app address inside the app", () => {
    const html = renderToString(createElement(HardwareNavLink, { userAgent: APP_AGENT }));
    expect(html).toContain("Hardware");
    expect(html).toContain(`href="${MOSS_ANDROID_HARDWARE_URL}"`);
  });

  it("renders nothing in a browser", () => {
    expect(renderToString(createElement(HardwareNavLink, { userAgent: BROWSER_AGENT }))).toBe("");
    expect(renderToString(createElement(HardwareNavLink, { userAgent: PHONE_BROWSER_AGENT }))).toBe(
      ""
    );
  });
});
