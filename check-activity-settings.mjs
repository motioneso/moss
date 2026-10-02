import { chromium } from "@playwright/test";
import fs from "node:fs";
const out="/tmp/dsw2920/"; const BASE="http://localhost:5192";
const b=await chromium.launch(); let fails=0; const log=[];
const ok=(c,m)=>{log.push((c?"PASS ":"FAIL ")+m); if(!c)fails++;};
const gap=(a,c)=>Math.max(c.x-(a.x+a.width), a.x-(c.x+c.width), c.y-(a.y+a.height), a.y-(c.y+c.height));
for (const [w,h,tag] of [[1440,900,"1440"],[1920,1000,"1920"],[390,844,"390"]]) {
  const p=await (await b.newContext({viewport:{width:w,height:h}})).newPage();
  await p.goto(BASE+"/"); await p.fill('input[type=email]',"ben@ben.com"); await p.fill('input[type=password]',process.env.PW);
  await p.keyboard.press("Enter"); await p.waitForTimeout(8000);
  await p.goto(BASE+"/settings?section=activity"); await p.waitForSelector(".aud__row",{timeout:20000}); await p.waitForTimeout(800);
  const f=await p.evaluate(()=>{const r=document.querySelector(".set2").getBoundingClientRect();return {w:r.width,x:r.x,sw:document.documentElement.scrollWidth,vw:innerWidth}});
  ok(f.sw<=f.vw, `${tag}: no sideways scroll (scrollWidth ${f.sw} <= ${f.vw})`);
  if(w>=1440){ ok(f.w>=w-260, `${tag}: Settings frame fills width (${Math.round(f.w)}px of ${w}px window)`); }
  else ok(f.w>=w-40, `${tag}: Settings frame fills phone width (${Math.round(f.w)}px)`);
  const text=await p.locator(".aud").innerText();
  ok(/Checked your calendar|Updated the assistant's command-line tools/.test(text), `${tag}: rows show plain actions`);
  ok(!/mcp\.moss|cli-tools\.update|home-assistant\.Hass/.test(text), `${tag}: no raw tool names on screen`);
  ok(!/too many requests|run again later/i.test(text), `${tag}: no rate-limit claim on refused rows`);
  ok(/Held back/.test(text) && /did not run/.test(text), `${tag}: refused row says held back and did not run`);
  ok(/Did not work/.test(text), `${tag}: failed row shows plain chip`);
  // spacing: no touching neighbours among badges, notes and titles inside rows
  const bad=await p.evaluate(()=>{const res=[];for(const row of document.querySelectorAll(".aud__row")){const kids=[...row.querySelectorAll(".aud__what > b, .aud__badges, .aud__note, .aud__cat, .aud__when")].map(e=>e.getBoundingClientRect());for(let i=0;i<kids.length;i++)for(let j=i+1;j<kids.length;j++){const a=kids[i],c=kids[j];const g=Math.max(c.left-a.right,a.left-c.right,c.top-a.bottom,a.top-c.bottom);if(g<4)res.push(Math.round(g))}const bs=[...row.querySelectorAll(".aud__badges > *")].map(e=>e.getBoundingClientRect());for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++){const a=bs[i],c=bs[j];if(Math.max(c.left-a.right,a.left-c.right,c.top-a.bottom,a.top-c.bottom)<4)res.push("badge")}}return res});
  ok(bad.length===0, `${tag}: every element in an Activity row has at least 4px clearance (${bad.length} too close)`);
  await p.screenshot({path:`${out}activity-${tag}-top.png`});
  await p.locator(".aud__row").nth(0).scrollIntoViewIfNeeded();
  await p.evaluate(()=>window.scrollTo(0,document.querySelector(".audfilter").getBoundingClientRect().top+scrollY-120)); await p.waitForTimeout(300);
  const sel=p.locator(".audfilter select");
  if(await sel.count()){ await sel.selectOption({label:"Calendar"}); await p.waitForTimeout(400);
    const rows=await p.locator(".aud__row").count(); const cats=await p.locator(".aud__cat").allInnerTexts();
    ok(rows>0&&cats.every(c=>/calendar/i.test(c)), `${tag}: module filter Calendar leaves ${rows} rows, all Calendar`); }
  // floating controls vs filter row at this scroll position
  const ov=await p.evaluate(()=>{const fl=[...document.querySelectorAll("button,a")].filter(e=>{const s=getComputedStyle(e);return s.position==="fixed"}).map(e=>e.getBoundingClientRect());const fr=document.querySelector(".audfilter").getBoundingClientRect();return fl.filter(r=>r.left<fr.right&&r.right>fr.left&&r.top<fr.bottom&&r.bottom>fr.top).length});
  ok(ov===0, `${tag}: no fixed button covers the filter row when scrolled (${ov} overlaps)`);
  await p.screenshot({path:`${out}activity-${tag}-filtered.png`});
  await p.goto(BASE+"/settings?section=modules"); await p.getByText("read your mail for context").waitFor({timeout:20000}).catch(()=>{}); await p.waitForTimeout(500);
  const mt=await p.locator("body").innerText();
  ok(/read your mail for context/.test(mt)&&!/never a nav destination|A Moss module/.test(mt), `${tag}: Modules wording is plain`);
  await p.screenshot({path:`${out}modules-${tag}.png`});
  await p.close();
}
await b.close(); fs.writeFileSync(out+"results.txt",log.join("\n")+"\n"); console.log(log.join("\n")); process.exit(fails?1:0);
