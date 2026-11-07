/**
 * Drives the key setup screens in a real browser, the way an owner with no terminal would.
 * Throwaway spike code.
 *
 *   pnpm exec tsx rust-spike/keystore/proof/drive.ts <port> <scratch> <keystore-ui> <fake-secret-service>
 *
 * Every run gets fresh home folders under <scratch>/proof-home, saves screenshots to
 * <scratch>/proof-shots and writes its log to <scratch>/evidence. Each server runs on its own private session bus, never the
 * desktop's, with no keychain unless the step starts the fake one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";

function argument(position: number): string {
  const value = process.argv[2 + position];
  if (!value)
    throw new Error("usage: drive.ts <port> <scratch> <keystore-ui> <fake-secret-service>");
  return value;
}
const port = Number(argument(0));
const scratch = argument(1);
const uiBin = argument(2);
const fakeBin = argument(3);
const base = `http://127.0.0.1:${port}`;
/** The one-time link the running server printed. */
let launch = "";
const homes = join(scratch, "proof-home");
const shots = join(scratch, "proof-shots");
rmSync(homes, { recursive: true, force: true });
rmSync(shots, { recursive: true, force: true });
mkdirSync(homes, { recursive: true });
mkdirSync(shots, { recursive: true });
mkdirSync(join(scratch, "evidence"), { recursive: true });

const busConfig = join(homes, "bus.conf");
writeFileSync(
  busConfig,
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${homes}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`
);

const log: string[] = [];
function note(line: string): void {
  log.push(line);
  console.log(line);
}
function check(ok: boolean, what: string): void {
  note(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) throw new Error(`check failed: ${what}`);
}

type Keychain = "none" | "no-bus" | "broken" | "working";

interface Home {
  root: string;
  keyFolder: string;
  keyFile: string;
  bundle: string;
}

function home(name: string): Home {
  const root = join(homes, name);
  mkdirSync(join(root, "run"), { recursive: true, mode: 0o700 });
  const keyFolder = join(root, ".config/moss/keys");
  return {
    root,
    keyFolder,
    keyFile: join(keyFolder, "recovery-store"),
    bundle: join(root, ".local/share/moss/keys/credential-keys.json")
  };
}

/** Each server's exit, recorded at spawn so a second stop never waits on an exit already past. */
const exits = new Map<ChildProcess, Promise<void>>();

async function start(at: Home, keychain: Keychain): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: at.root,
    XDG_CONFIG_HOME: join(at.root, ".config"),
    XDG_DATA_HOME: join(at.root, ".local/share"),
    XDG_RUNTIME_DIR: join(at.root, "run")
  };
  const ui = [uiBin, "--port", String(port)];
  const command: [string, string[]] =
    keychain === "no-bus"
      ? [uiBin, ui.slice(1)]
      : keychain === "none"
        ? ["dbus-run-session", [`--config-file=${busConfig}`, "--", ...ui]]
        : [
            "dbus-run-session",
            [
              `--config-file=${busConfig}`,
              "--",
              "sh",
              "-c",
              '"$0" "$1" & sleep 0.5; exec "$2" --port "$3"',
              fakeBin,
              `--${keychain}`,
              uiBin,
              String(port)
            ]
          ];
  const child = spawn(command[0], command[1], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"]
  });
  exits.set(child, new Promise<void>((resolve) => child.once("exit", () => resolve())));
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
    let printed = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      const link = /listening on (\S+)\n/.exec(printed);
      if (link) {
        launch = link[1];
        resolve();
      }
    });
  });
  return child;
}

/** Stops a server with its session bus and any fake keychain, which share its process group. */
async function stop(child: ChildProcess): Promise<void> {
  const exited = exits.get(child);
  if (child.pid === undefined || exited === undefined) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
  }
  await exited;
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * Clicks a button or link that loads a new page, then waits for that page. A form sent back to
 * the same address leaves the address unchanged, so the wait marks the old page instead.
 */
async function press(page: Page, label: string): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.old = "yes";
  });
  await page.click(`text=${label}`);
  // The page being replaced may briefly have no root element at all.
  await page.waitForFunction(() => {
    const root = document.documentElement as HTMLElement | null;
    return root !== null && root.dataset.old !== "yes";
  });
  await page.waitForLoadState("load");
}

async function heading(page: Page): Promise<string> {
  return (await page.locator("h1").textContent()) ?? "";
}

async function shot(page: Page, name: string, caption: string): Promise<void> {
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  note(`shot ${name}.png: ${caption}`);
}

async function readWords(page: Page): Promise<{ name: string; words: string[] }> {
  const name = (await page.locator("#key-name").textContent()) ?? "";
  const words = (await page.locator("#words li").allTextContents()).map((item) =>
    item.replace(/^\d+/, "")
  );
  return { name, words };
}

async function fillBoxes(page: Page, words: string[]): Promise<void> {
  for (const [index, word] of words.entries()) {
    await page.fill(`input[name="w${index + 1}"]`, word);
  }
}

/** The browser's cookie for this server, to send from outside the browser. */
async function cookie(page: Page): Promise<string> {
  const found = (await page.context().cookies(base)).find(
    (each) => each.name === `moss-keys-${port}`
  );
  if (!found) throw new Error("the browser has no cookie for this server");
  return `${found.name}=${found.value}`;
}

/** A raw request, as another account or a script would send it, outside the browser. */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>,
  body = ""
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const running: ChildProcess[] = [];

try {
  // A desktop session with no keychain installed.
  const a = home("a");
  let server = await start(a, "none");
  running.push(server);
  await page.goto(launch);
  check(
    (await heading(page)) === "Where should Moss keep its keys?",
    "first start asks where to keep keys"
  );
  await shot(page, "01-setup-choice", "First start on a computer with no keychain");

  check(
    (await raw("GET", "/", { Host: `attacker.example:${port}` })) === 421,
    "another host name is refused"
  );
  const local = { Host: `127.0.0.1:${port}` };
  const posted = { ...local, "Content-Type": "application/x-www-form-urlencoded" };
  const token = await page.locator('input[name="token"]').first().inputValue();
  check((await raw("GET", "/", local)) === 403, "another account cannot open the screens");
  check(
    (await raw("POST", "/setup", posted, `token=${token}`)) === 403,
    "the page's form token alone does not let another account in"
  );
  const link = new URL(launch);
  check(
    (await raw("GET", link.pathname + link.search, local)) === 403,
    "the one-time link works only once"
  );
  check(
    (await raw("POST", "/setup", { ...posted, Cookie: await cookie(page) }, "token=guess")) === 403,
    "a form without this server's token is refused"
  );

  await press(page, "Use a private file");
  check((await heading(page)) === "Write down your recovery words", "the recovery words are shown");
  const first = await readWords(page);
  check(
    first.words.length === 24 && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(first.name),
    "24 words and a key name"
  );
  check(
    !existsSync(a.keyFile) && !existsSync(a.bundle),
    "nothing is saved while the words are on screen"
  );
  check(
    (await raw("GET", "/setup/words", local)) === 403,
    "another account cannot read the words on screen"
  );

  // The owner goes back and starts again: the first words must never become valid.
  await page.goto(launch);
  await press(page, "Use a private file");
  const sheet = await readWords(page);
  check(
    sheet.name !== first.name,
    `starting again gives a new key (${first.name} then ${sheet.name})`
  );
  await shot(page, "02-recovery-words", `The recovery sheet for key ${sheet.name}`);

  await press(page, "I've written them down");
  check(
    (await heading(page)) === "Check your sheet",
    "the sheet is checked before anything is saved"
  );
  const asked = await page
    .locator('form.check input[name^="w"]')
    .evaluateAll((inputs) =>
      inputs.map((input) => Number((input as HTMLInputElement).name.slice(1)))
    );
  for (const position of asked) {
    const word = sheet.words[position - 1] ?? "";
    await page.fill(`input[name="w${position}"]`, word === "zoo" ? "abandon" : "zoo");
  }
  await press(page, "Finish setup");
  check((await page.locator(".errors li").count()) === 3, "three wrong words are each named");
  check(!existsSync(a.keyFile) && !existsSync(a.bundle), "a failed check saves nothing");
  await shot(
    page,
    "03-check-mistake",
    "A failed sheet check names each wrong word and saves nothing"
  );

  for (const [index, position] of asked.entries()) {
    const word = sheet.words[position - 1] ?? "";
    // The first four letters are enough, and capitals do not matter.
    const typed = index === 0 ? word.slice(0, 4) : index === 1 ? word.toUpperCase() : word;
    await page.fill(`input[name="w${position}"]`, typed);
  }
  await press(page, "Finish setup");
  check((await heading(page)) === "Your keys are set up", "setup finishes");
  const fingerprint = (await page.locator("#fingerprint").textContent()) ?? "";
  check(
    mode(a.keyFolder) === "0700" && mode(a.keyFile) === "0600",
    "key folder 0700, key file 0600"
  );
  check(mode(a.bundle) === "0600", "key bundle 0600");
  await shot(page, "04-set-up", `Set up; the keys' fingerprint is ${fingerprint}`);

  await stop(server);
  server = await start(a, "none");
  running.push(server);
  await page.goto(launch);
  check(
    (await heading(page)) === "Moss is unlocked",
    "after a restart Moss unlocks without asking"
  );
  check(
    (await page.locator("#fingerprint").textContent()) === fingerprint,
    "the same keys after a restart"
  );
  await shot(page, "05-restart", "After a restart: unlocked, no prompt, same fingerprint");

  rmSync(a.keyFile);
  await page.goto(launch);
  check(
    (await heading(page)) === "Enter your recovery words",
    "a lost key file asks for the words"
  );
  check(
    (await page.locator("#needs").textContent()) === sheet.name,
    `it names the sheet to find (${sheet.name})`
  );
  await shot(page, "06-key-file-lost", "The key file is gone, so Moss asks for the recovery words");

  // A typo: two neighbouring letters swapped in a long word.
  const typoAt = sheet.words.findIndex((word) => word.length >= 6 && word[2] !== word[3]);
  check(typoAt >= 0, "the sheet has a word long enough for the typo");
  const typoWord = sheet.words[typoAt] ?? "";
  const typo = typoWord.slice(0, 2) + typoWord[3] + typoWord[2] + typoWord.slice(4);
  await fillBoxes(
    page,
    sheet.words.map((word, index) => (index === typoAt ? typo : word))
  );
  await press(page, "Bring my keys back");
  const typoError = (await page.locator(".errors").textContent()) ?? "";
  check(
    typoError.includes(`Word ${typoAt + 1}, "${typo}"`),
    `the typo is pinpointed: ${typoError.trim()}`
  );
  const boxes = await Promise.all(
    sheet.words.map((_, index) => page.locator(`input[name="w${index + 1}"]`).inputValue())
  );
  check(
    boxes.every((value, index) => value === (index === typoAt ? typo : sheet.words[index])),
    "every box keeps what was typed, typo included"
  );
  await shot(page, "07-typo", "A typo is pinpointed, with a suggestion");

  await fillBoxes(page, first.words);
  await press(page, "Bring my keys back");
  const wrongSheet = (await page.locator(".errors").textContent()) ?? "";
  check(
    wrongSheet.includes(first.name) && wrongSheet.includes(sheet.name),
    "words from the abandoned first sheet are refused, naming both keys"
  );
  check(!existsSync(a.keyFile), "refused words change nothing");
  await shot(page, "08-wrong-sheet", "Words from a different sheet are refused by name");

  // Pasted as a numbered list into the first box, every third word cut to four letters.
  const pasted = sheet.words
    .map((word, index) => `${index + 1}. ${index % 3 === 0 ? word.slice(0, 4) : word}`)
    .join("\n");
  await fillBoxes(page, Array<string>(24).fill(""));
  await page.fill(`input[name="w1"]`, pasted.replace(/\n/g, " "));
  await press(page, "Bring my keys back");
  check((await heading(page)) === "Your keys are back", "pasted words bring the keys back");
  check(
    (await page.locator("#fingerprint").textContent()) === fingerprint,
    "the same keys as before"
  );
  check(mode(a.keyFile) === "0600", "the new key file is 0600");
  await shot(page, "09-recovered", "Recovered from a pasted sheet; same fingerprint");

  writeFileSync(a.keyFile, "{ this is not a key file");
  await page.goto(launch);
  check(
    (await heading(page)) === "Enter your recovery words",
    "a damaged key file asks for the words"
  );
  check(
    (await page.locator("main").textContent())?.includes("damaged") === true,
    "it says the file is damaged"
  );
  await shot(
    page,
    "10-key-file-damaged",
    "A damaged key file is refused, and the words are asked for"
  );
  await fillBoxes(page, sheet.words);
  await press(page, "Bring my keys back");
  check((await heading(page)) === "Your keys are back", "the words replace a damaged key file");
  const kept = readdirSync(a.keyFolder).filter((name) =>
    name.startsWith("recovery-store.replaced-")
  );
  check(
    kept.length === 1 && mode(join(a.keyFolder, kept[0] ?? "")) === "0600",
    "the damaged file is kept, 0600"
  );

  chmodSync(a.keyFile, 0o644);
  await page.goto(launch);
  check(
    (await heading(page)) === "Your key file isn't private",
    "a key file others can read is not used"
  );
  await shot(page, "11-not-private", "A key file other accounts could read is refused");
  await press(page, "Make it private");
  check((await heading(page)) === "Moss is unlocked", "one button makes it private and unlocks");
  check(mode(a.keyFile) === "0600" && mode(a.keyFolder) === "0700", "back to 0600 and 0700");
  check((await page.locator("#fingerprint").textContent()) === fingerprint, "still the same keys");
  await shot(page, "12-made-private", "Made private with one button; unlocked");
  await stop(server);

  // A keychain is installed but broken: the key file must not be offered.
  const b = home("b");
  server = await start(b, "broken");
  running.push(server);
  await page.goto(launch);
  check(
    (await heading(page)) === "Moss can't use this computer's keychain",
    "a broken keychain is reported"
  );
  check((await page.locator("text=Use a private file").count()) === 0, "no key file is offered");
  await shot(page, "13-keychain-broken", "A broken keychain: no key file is offered");
  await stop(server);
  check(!existsSync(b.keyFile) && !existsSync(b.bundle), "nothing was written");

  const c = home("c");
  server = await start(c, "working");
  running.push(server);
  await page.goto(launch);
  check((await heading(page)) === "This computer has a keychain", "a working keychain is found");
  await shot(page, "14-keychain-found", "A working keychain is found; the spike stops there");
  await stop(server);

  const d = home("d");
  server = await start(d, "no-bus");
  running.push(server);
  await page.goto(launch);
  check(
    (await heading(page)) === "Where should Moss keep its keys?",
    "no desktop session offers the key file"
  );
  check(
    (await page.locator("main").textContent())?.includes("no desktop session") === true,
    "it says why"
  );
  await shot(page, "15-no-desktop-session", "No desktop session at all, as on a server");
  await stop(server);
  note("all checks passed");
} finally {
  for (const child of running) await stop(child).catch(() => undefined);
  await browser.close();
  writeFileSync(join(scratch, "evidence/06-browser-proof.txt"), `${log.join("\n")}\n`);
}
