/**
 * Available start date on applications other than Workday.
 *
 *   node test/start-date-other.spec.mjs
 *
 * Reported on 1.23.0: "in workday and other applications available start date
 * field value ... not filling". The date is the profile's, or today's when the
 * profile says "Immediately" or nothing a calendar can hold, in whatever shape
 * the page asks for it: a date input, a MM/DD/YYYY box, a question in words,
 * or three lists (Month, Day, Year) — the lists used to be left for the
 * applicant. Other boxes that share a group with the date are never taken for
 * part of it.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const profileWith = (availableStartDate) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456", city: "Jacksonville", state: "FL", country: "United States" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", availableStartDate },
  compensation: { desiredSalary: "120000" },
  eeo: {}, experience: [], education: [], documents: [],
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="app" role="group" aria-label="Application">
  <div><label for="native">Available Start Date</label><input id="native" type="date"></div>
  <div><label for="typed">Earliest start date</label><input id="typed" type="text" placeholder="MM/DD/YYYY"></div>
  <div><label for="words">When can you start?</label><input id="words" type="text"></div>
  <fieldset><legend>Available Start Date</legend>
    <select id="lm" aria-label="Month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select>
    <select id="ld" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${String(i + 1).padStart(2, "0")}</option>`).join("")}</select>
    <select id="ly" aria-label="Year"><option value="">Year</option>${[2025, 2026, 2027, 2028, 2029, 2030].map((y) => `<option>${y}</option>`).join("")}</select>
  </fieldset>
  <fieldset><legend>Potential start date (month and year)</legend>
    <select id="nm" aria-label="MM"><option value="">MM</option>${Array.from({ length: 12 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select>
    <select id="ny" aria-label="YYYY"><option value="">YYYY</option>${[2025, 2026, 2027, 2028, 2029, 2030].map((y) => `<option>${y}</option>`).join("")}</select>
  </fieldset>
  <div><label for="salary">Desired salary</label><input id="salary" type="text"></div>
  <div><label for="bonus">What is your desired annual bonus?</label><input id="bonus" type="text"></div>
</form></body></html>`;

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill(url, profile, responses = []) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses }) => {
    window.__APPLI_FILL_TEST = true;
    const session = { profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, responses });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(url);
  await page.setContent(PAGE);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(500);
  const got = await page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    const shown = (id) => { const s = document.getElementById(id); return s.options[s.selectedIndex]?.textContent ?? ""; };
    return { native: v("native"), typed: v("typed"), words: v("words"), lm: shown("lm"), ld: shown("ld"), ly: shown("ly"),
      nm: shown("nm"), ny: shown("ny"), salary: v("salary"), bonus: v("bonus") };
  });
  await page.close();
  return got;
}

const pad = (n) => String(n).padStart(2, "0");
const on = (d) => ({ iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, us: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
  month: MONTHS[d.getMonth()], day: pad(d.getDate()), year: String(d.getFullYear()), m: String(d.getMonth() + 1) });
const today = new Date(); today.setHours(0, 0, 0, 0);

for (const url of ["https://boards.greenhouse.io/acme/jobs/4012345", "https://careers-acme.icims.com/jobs/1234/devops-engineer/job"]) {
  const host = new URL(url).hostname;
  console.log(`\n${host}: "Immediately" in the profile`);
  {
    const g = await fill(url, profileWith("Immediately"), [{ question: "What is your desired annual bonus?", answer: "20000", aliases: [], inputType: "text", lastDomain: host }]);
    const t = on(today);
    check("a date input gets today's date", g.native === t.iso, `= ${g.native}`);
    check("a MM/DD/YYYY box gets today's date", g.typed === t.us, `= ${g.typed}`);
    check("\"When can you start?\" keeps the applicant's words", g.words === "Immediately", `= ${g.words}`);
    check("Month / Day / Year lists get today's month, day and year", g.lm === t.month && g.ld === t.day && g.ly === t.year, JSON.stringify([g.lm, g.ld, g.ly]));
    check("numbered MM / YYYY lists too", g.nm === t.m && g.ny === t.year, JSON.stringify([g.nm, g.ny]));
    check("the salary and the saved bonus go in their own boxes", g.salary === "120000" && g.bonus === "20000", JSON.stringify([g.salary, g.bonus]));
  }
  console.log(`\n${host}: a date in the profile`);
  {
    const g = await fill(url, profileWith("2027-03-15"));
    const t = on(new Date(2027, 2, 15));
    check("every date shape gets 03/15/2027", g.native === t.iso && g.typed === t.us && g.lm === t.month && g.ld === t.day && g.ly === t.year && g.nm === t.m,
      JSON.stringify(g));
  }
}

console.log("\na start month saved off an earlier application is not replayed");
{
  const url = "https://boards.greenhouse.io/acme/jobs/4012345";
  const g = await fill(url, profileWith("Immediately"), [
    { question: "Month | Available Start Date", answer: "January", aliases: [], inputType: "select", lastDomain: "boards.greenhouse.io" },
    { question: "Month", answer: "January", aliases: [], inputType: "select", lastDomain: "boards.greenhouse.io" },
  ]);
  check("the Month list shows this month, not the saved January", g.lm === on(today).month, `= ${g.lm}`);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
