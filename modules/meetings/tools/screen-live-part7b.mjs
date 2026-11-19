// Browser pass for Meetings part 7b (Devices list, approval dialog) against the real server held
// up by the live gate. Usage:
//   node modules/meetings/tools/screen-live-part7b.mjs <url from <dir>/url.txt> <screenshot dir>
// Real data only. A fake Mac asks to link through the real pairing routes, the page approves it,
// and the fake Mac then uses its real credential. Nothing is intercepted or rewritten.
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const email = "meetings-owner@example.test";
const password = "temporary-meetings-password-235-not-a-real-secret";
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed += 1;
};

for (const [name, width] of [
  ["desktop", 1280],
  ["phone", 390]
]) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: 800 }
  });
  const page = await context.newPage();
  await page.goto(`${url}/api/hello`);
  await page.evaluate(
    async ([e, p]) =>
      fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: e, password: p })
      }),
    [email, password]
  );
  const open = async (path, hash = "") => {
    await page.goto(`${url}/module-frame?module=meetings&path=${encodeURIComponent(path)}${hash}`);
    await page.waitForTimeout(3500);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (!frame) throw new Error(`${name}: the screen frame did not load for ${path}`);
    return frame;
  };
  const text = async (f) => (await f.locator("body").innerText()).replace(/\n+/g, " | ");
  const shot = (label) => page.screenshot({ path: `${out}/${name}-${label}.png`, fullPage: true });

  // The fake device runs in the page so it shares the real origin and the real server.
  const ask = (platform) =>
    page.evaluate(async (platformName) => {
      const verifier = `${platformName}-verifier-${Math.random()}`;
      const bytes = new TextEncoder().encode(verifier);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const response = await fetch("/api/companion/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceName: platformName === "android" ? "Pixel 9" : "Studio Mac",
          platform: platformName,
          appVersion: "1.0.0",
          osVersion: platformName === "android" ? "15" : "15.1",
          verifierHash: hash,
          ...(platformName === "macos" ? { recordingPolicyVersion: 1 } : {})
        })
      });
      const body = await response.json();
      return { status: response.status, verifier, ...body };
    }, platform);
  const redeem = (made) =>
    page.evaluate(async (m) => {
      const response = await fetch("/api/companion/pair/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: m.attemptId, verifier: m.verifier })
      });
      return { status: response.status, ...(await response.json().catch(() => ({}))) };
    }, made);
  const asDevice = (path, credential, method = "GET", body) =>
    page.evaluate(
      async ([p, c, m, b]) => {
        const response = await fetch(p, {
          method: m,
          headers: { authorization: `Bearer ${c}`, "content-type": "application/json" },
          body: b ? JSON.stringify(b) : undefined
        });
        return response.status;
      },
      [path, credential, method, body]
    );
  const codeOf = (made) => new URLSearchParams(made.approvalPath.split("#")[1]).get("code");

  // Empty list.
  let frame = await open("/settings/meetings");
  let body = await text(frame);
  check(
    `${name} empty list says no devices`,
    body.includes("No devices linked"),
    body.slice(0, 300)
  );
  await shot("devices-empty");

  // A Mac asks to link and the page shows the question.
  const mac = await ask("macos");
  check(`${name} the Mac's request is accepted`, mac.status === 200, JSON.stringify(mac));
  frame = await open("/meetings", `#code=${codeOf(mac)}`);
  body = await text(frame);
  check(
    `${name} approval asks about the Mac`,
    body.includes("Do you recognise this Mac?"),
    body.slice(0, 300)
  );
  check(`${name} approval names the Mac`, body.includes("Studio Mac"));
  await shot("approval-ask");
  check(`${name} the code is gone from the address bar`, !page.url().includes("code="), page.url());
  await frame.getByRole("button", { name: "Link Mac" }).click();
  await page.waitForTimeout(3500);
  frame = page.frames().find((f) => f !== page.mainFrame());
  body = await text(frame);
  check(
    `${name} linking lands on the Devices list`,
    body.includes("Studio Mac"),
    body.slice(0, 300)
  );
  await shot("devices-linked");

  // The Mac redeems and uses its credential.
  const issued = await redeem(mac);
  check(
    `${name} the Mac receives a credential`,
    issued.status === 200 && !!issued.credential,
    JSON.stringify(issued).slice(0, 200)
  );
  const beat = await asDevice("/api/companion/heartbeat", issued.credential, "POST", {
    appVersion: "1.0.0",
    osVersion: "15.1"
  });
  check(`${name} a linked Mac can check in`, beat === 200, String(beat));
  const uploadBefore = await asDevice(
    "/api/m/meetings/recording-uploads",
    issued.credential,
    "POST",
    {}
  );
  check(
    `${name} a linked Mac reaches uploads`,
    uploadBefore !== 401 && uploadBefore !== 403,
    String(uploadBefore)
  );
  frame = await open("/settings/meetings");
  body = await text(frame);
  check(`${name} list shows Connected`, body.includes("Connected"), body.slice(0, 300));
  await shot("devices-list");

  // Rename in place.
  await frame.getByRole("button", { name: "Rename" }).first().click();
  await page.waitForTimeout(600);
  await shot("devices-rename");
  await frame.locator("#device-name").fill("Desk Mac");
  await frame.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(1500);
  body = await text(frame);
  check(`${name} rename shows the new name`, body.includes("Desk Mac"), body.slice(0, 300));
  frame = await open("/settings/meetings");
  check(`${name} rename survives a reload`, (await text(frame)).includes("Desk Mac"));

  // Unlink.
  await frame.getByRole("button", { name: "Unlink" }).first().click();
  await page.waitForTimeout(600);
  await shot("unlink-confirm");
  await frame.locator("#unlink-confirm").click();
  await page.waitForTimeout(2000);
  body = await text(frame);
  check(`${name} unlink empties the list`, body.includes("No devices linked"), body.slice(0, 300));
  const afterBeat = await asDevice("/api/companion/heartbeat", issued.credential, "POST", {
    appVersion: "1.0.0",
    osVersion: "15.1"
  });
  const afterUpload = await asDevice(
    "/api/m/meetings/recording-uploads",
    issued.credential,
    "POST",
    {}
  );
  check(`${name} the unlinked Mac cannot check in`, afterBeat === 401, String(afterBeat));
  check(`${name} the unlinked Mac's upload is refused`, afterUpload === 401, String(afterUpload));
  await shot("devices-after-unlink");

  // A phone asks, the page declines.
  const phone = await ask("android");
  frame = await open("/meetings", `#code=${codeOf(phone)}`);
  body = await text(frame);
  check(
    `${name} approval asks about the phone`,
    body.includes("Do you recognise this phone?"),
    body.slice(0, 300)
  );
  await shot("approval-phone");
  await frame.getByRole("button", { name: "Not this phone" }).click();
  await page.waitForTimeout(2000);
  body = await text(frame);
  check(`${name} declining links nothing`, body.includes("Nothing was linked"), body.slice(0, 300));
  await shot("approval-declined");
  const refused = await redeem(phone);
  check(`${name} a declined phone cannot redeem`, refused.status === 403, JSON.stringify(refused));

  // The same code again is closed.
  frame = await open("/meetings", `#code=${codeOf(phone)}`);
  body = await text(frame);
  check(
    `${name} an answered request says it is closed`,
    body.includes("That request is no longer open"),
    body.slice(0, 300)
  );
  await shot("approval-closed");

  // A phone that is linked.
  const phone2 = await ask("android");
  frame = await open("/meetings", `#code=${codeOf(phone2)}`);
  await frame.getByRole("button", { name: "Link phone" }).click();
  await page.waitForTimeout(3500);
  frame = page.frames().find((f) => f !== page.mainFrame());
  body = await text(frame);
  check(
    `${name} a linked phone shows in the list`,
    body.includes("Pixel 9") && body.includes("Android"),
    body.slice(0, 300)
  );
  await shot("devices-phone");
  await frame.getByRole("button", { name: "Unlink" }).first().click();
  await page.waitForTimeout(500);
  await frame.locator("#unlink-confirm").click();
  await page.waitForTimeout(1500);
  await context.close();
}
await browser.close();
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
