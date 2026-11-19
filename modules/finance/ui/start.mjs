// The Start screen. It shows first to a person with no accounts and needs no bank keys.
import { esc, button, sectionHead, masthead, errorState, loadingLine, badge } from "./html.mjs";

const rowHtml = (title, body, aside) =>
  `<li class="fnm-row"><div class="fnm-txmain"><strong>${esc(title)}</strong><span class="jds-hint">${esc(body)}</span></div>${aside}</li>`;

export function startView(s) {
  if (s.error) return errorState("Start didn't load.", button("Try again", { act: "start-reload" }));
  if (!s.data) return loadingLine("Loading");
  const d = s.data;
  const bank = d.hasBank
    ? badge("Connected", "success")
    : d.keysConfigured
      ? button("Connect a bank", { act: "connect-bank", variant: "primary" })
      : badge("Waiting on your admin", "neutral");
  const head = masthead({
    eyebrowText: "Finance",
    title: "Run your money with Moss"
  });
  return `${head}<p class="jds-lede">Start with a manual account or connect a bank, review your spending, and build your budget with Moss.</p>
${sectionHead("Start without a bank connection")}
<p>Keep a private manual account, add transactions or import a CSV, and reconcile your statements. No bank keys are needed.</p>
<div class="fnm-chips">${button("Add a manual account", { act: "start-add", variant: "primary" })}</div>
${sectionHead("Connect a bank later")}
<ul class="fnm-feed">${rowHtml("Connect a bank", d.keysConfigured || d.hasBank ? "Link your bank so Moss can bring in your transactions." : "A bank link needs keys from your admin.", bank)}${rowHtml("Moss sorts your spending", "Purchases are sorted into categories for you to review.", badge("Next"))}${rowHtml("Build your budget together", "Give every dollar a job, month by month.", badge("Then"))}</ul>`;
}
