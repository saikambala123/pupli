/**
 * Pending Saved Answers holds what the applicant changed — never what Appli-Fill
 * filled.
 *
 *   node test/provenance.spec.mjs
 *
 * Reported: "The field values which are filled by the extension in any
 * application portal should not show in pending saved answers; if a value
 * filled by the extension is edited or changed manually it can show."
 *
 * The old test for "the applicant did this" was page-wide: any trusted event
 * anywhere in the previous eight seconds. So a click on the page right after
 * a fill — or the in-page Fill button itself — followed by the page doing
 * something to a value Appli-Fill had written (a phone mask, a salary formatter,
 * a date rewritten in another format, a control re-rendered) offered Appli-Fill's
 * own answers back as manual edits. A change now needs a person's pointer,
 * key, paste or drop on *that* control after Appli-Fill wrote it.
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

/**
 * The profile's start date, a month from the day the test runs. A fixed date
 * becomes a past one, and a start date already past is replaced with today's
 * (see the start-date rule), so the page's own format would never see it.
 */
const START = (() => {
  const d = new Date(Date.now() + 30 * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com", phone: "6305550142",
    city: "Stanley", state: "North Carolina", country: "United States" },
  workAuth: { willingToRelocate: "Yes", availableStartDate: START, howDidYouHear: "LinkedIn" },
  compensation: { desiredSalary: "160000" },
  eeo: {}, experience: [], education: [], documents: [],
};
const SAVED = [
  { question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks", aliases: [] },
  { question: "Why do you want to work here?", normalizedKey: "why want work here", answer: "The platform work and the scale of the identity problem.", aliases: [] },
];

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));
await page.addInitScript(({ profile, saved }) => {
  window.__APPLI_FILL_TEST = true;
  window.__held = [];
  window.__discarded = [];
  const session = { profile, profiles: [profile], responses: saved, premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
  window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
    if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
    if (m?.type === "APPLI_FILL_DISCARD_HELD") window.__discarded.push(...(m.questions || []));
    const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
      : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
    setTimeout(() => cb && cb(r), 0);
  }, onMessage: { addListener() {} } } };
}, { profile: PROFILE, saved: SAVED });
await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
await page.goto("https://boards.greenhouse.io/acme/jobs/4242");
await page.setContent(await readFile(join(ROOT, "test/fixtures/provenance.html"), "utf8"));
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(200);

const state = () => page.evaluate(() => ({
  phone: document.getElementById("phone").value,
  salary: document.getElementById("salary").value,
  start: document.getElementById("start").value,
  source: document.getElementById("source").value,
  relocate: document.getElementById("relocate").textContent.trim(),
  notice: document.getElementById("notice").value,
  why: document.getElementById("why").value,
  held: window.__held.map((h) => ({ q: h.question, a: String(h.answer) })),
  discarded: window.__discarded.slice(),
}));

/* ------------------------------------------------------------------ */
console.log("\nfill, then let the page have its way with the answers");
// The fill is started from the page, as the in-page button does — a trusted
// click on the page just before Appli-Fill writes anything.
await page.mouse.click(600, 20);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.evaluate(() => window.__pageEffects());
// The applicant clicks around while the page finishes: not an edit.
await page.waitForTimeout(250);
await page.mouse.click(700, 520);
await page.waitForTimeout(700);
await page.click("h1");
await page.waitForTimeout(2600);

let s = await state();
check("the fill landed", s.salary && s.relocate.startsWith("Yes") && s.source === "LinkedIn" && s.notice === "2 weeks", JSON.stringify(s));
check("the page's phone mask ran", s.phone === "(630) 555-0142", s.phone);
check("the page's salary format ran", s.salary === "$160,000", s.salary);
check("the page's date format ran", s.start === START, JSON.stringify({ shown: s.start, profile: START }));
check("the page's wipe was restored by the settle pass", s.notice === "2 weeks", s.notice);
check("nothing Appli-Fill filled is pending", s.held.length === 0, JSON.stringify(s.held));

/* ------------------------------------------------------------------ */
console.log("\nlooking is not editing");
await page.click("#salary");
await page.click("#why");
await page.click("h1");
await page.waitForTimeout(500);
s = await state();
check("clicking into filled boxes and away holds nothing", s.held.length === 0, JSON.stringify(s.held));

/* ------------------------------------------------------------------ */
console.log("\nwhat the applicant changes is pending");
await page.click("#salary", { clickCount: 3 });
await page.keyboard.type("175000");
await page.click("h1");
await page.waitForTimeout(500);
s = await state();
check("a retyped salary is held", s.held.some((h) => /salary/i.test(h.q) && /175,?000/.test(h.a)), JSON.stringify(s.held));

await page.click("#relocate");
await page.click("#relocate-menu li:nth-child(2)");
await page.waitForTimeout(1000);
s = await state();
check("a different dropdown choice is held", s.held.some((h) => /relocate/i.test(h.q) && /^No/.test(h.a)), JSON.stringify(s.held));

await page.selectOption("#source", "Referral");
await page.waitForTimeout(500);
s = await state();
check("a different select choice is held", s.held.some((h) => /hear about us/i.test(h.q) && h.a === "Referral"), JSON.stringify(s.held));

await page.click("#notice", { clickCount: 3 });
await page.keyboard.type("30 days");
await page.click("h1");
await page.waitForTimeout(500);
s = await state();
check("a corrected saved answer is held", s.held.some((h) => /notice period/i.test(h.q) && h.a === "30 days"), JSON.stringify(s.held));
check("only the four changed answers are held",
  new Set(s.held.map((h) => h.q.toLowerCase())).size === 4 && !s.held.some((h) => /phone|start|why/i.test(h.q)),
  JSON.stringify(s.held));

/* ------------------------------------------------------------------ */
console.log("\nchanging it back to Appli-Fill's answer");
await page.click("#notice", { clickCount: 3 });
await page.keyboard.type("2 weeks");
await page.click("h1");
await page.waitForTimeout(500);
s = await state();
check("withdraws what was held for the detour", s.discarded.some((q) => /notice period/i.test(q)), JSON.stringify(s.discarded));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
