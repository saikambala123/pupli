/**
 * Manual edits on a Workday questionnaire reach the pending list.
 *
 *   node test/workday-capture.spec.mjs
 *
 * Reported against 1.14.0: "when we edit or manually enter data it is not
 * showing in pending saved answers". Three things lost those edits:
 *
 *   - a question that merely contained a watched word ("travel out of
 *     *state*", "Please *state* your salary") matched a profile rule, and
 *     answers to profile rules are never banked — so the edit was dropped;
 *   - an answer refused once because the page was still flagging the field
 *     invalid was marked "already captured" and never tried again;
 *   - a typed answer was only captured on blur, and opening the popup does not
 *     always blur the page.
 *
 * A control that Workday re-renders on selection is covered too: the new
 * element continues from its predecessor's starting value.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const FIXTURE = join(ROOT, "test/fixtures/workday-questions.html");
const URL = "https://gdit.wd5.myworkdayjobs.com/en-US/external_career_site/job/X/apply/applyManually";
const Q = (n) => `primaryQuestionnaire--4f1c0a9e7d2b100115a3c1e2f7a400${String(n).padStart(2, "0")}`;

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "m@example.com", address: "1 Main St",
    city: "Stanley", state: "North Carolina", zip: "28164", country: "United States" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", previouslyEmployedHere: "No",
    securityClearance: "None", willingToRelocate: "Yes" },
  eeo: {}, experience: [], education: [], documents: [],
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});

async function open({ fill = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile: PROFILE });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(FIXTURE, "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  if (fill) await page.evaluate(() => window.__applifill.run({ manual: true }));
  // Past the window that marks freshly written controls as the fill's own.
  await page.waitForTimeout(1700);
  return page;
}

const pick = async (page, id, text) => {
  await page.click(`[id="${id}"]`);
  await page.waitForTimeout(120);
  await page.click(`ul[role=listbox] li:has-text("${text}")`);
  await page.waitForTimeout(900);
};

const held = (page) => page.evaluate(() => window.__held.map((h) => ({
  q: h.question, a: String(h.answer), t: h.inputType, o: h.options || [], at: h.editedAt,
})));
const last = (rows, re) => rows.filter((r) => re.test(r.q)).pop();

/* ------------------------------------------------------------------ */
console.log("\na fill on its own offers nothing for review");
{
  const page = await open();
  await page.waitForTimeout(1500);
  const rows = await held(page);
  check("nothing is pending after a fill", rows.length === 0, JSON.stringify(rows));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nevery manual change reaches the pending list, under its own question");
{
  const page = await open();
  await pick(page, Q(2), "Yes");
  await pick(page, Q(2), "No");
  await pick(page, Q(7), "Yes");
  await pick(page, Q(6), "Yes");
  await pick(page, Q(11), "No");
  await pick(page, Q(1), "No");
  await pick(page, Q(9), "No");            // Workday re-renders this control on selection
  const rows = await held(page);

  const agreements = last(rows, /^Have you signed any agreements/);
  check("the agreements question is held with the latest answer", agreements?.a === "No", JSON.stringify(agreements));
  check("under the question's own wording", /solicit their customers or business\?/.test(agreements?.q || ""), agreements?.q);
  check("with the menu's choices stored beside it",
    JSON.stringify(agreements?.o) === JSON.stringify(["Yes", "No"]), JSON.stringify(agreements?.o));
  check("the Federal Government question is held", last(rows, /Federal Government/)?.a === "Yes");
  check("the clearance-eligibility question is held", last(rows, /able to obtain one/)?.a === "Yes");
  check("a question mentioning 'out of state' is held — it is not an address",
    last(rows, /travel out of state/)?.a === "No", JSON.stringify(rows.map((r) => r.q)));
  check("an edit to an autofilled answer is held", last(rows, /over the age of 18/)?.a === "No");
  check("an edit to a control the page re-renders is held", last(rows, /willing to relocate/)?.a === "No");
  check("every held answer carries the time it was made", rows.every((r) => Number(r.at) > 0));
  check("no identity or address field was offered", !rows.some((r) => /first name|last name|city|postal|address/i.test(r.q)));

  /* Typing is captured when it pauses — no blur needed. */
  await page.click(`[id="${Q(12)}"]`);
  await page.keyboard.type("150000");
  await page.waitForTimeout(1400);
  const typed = last(await held(page), /desired annual salary/);
  check("a typed answer is held without leaving the box", typed?.a === "150000", JSON.stringify(typed));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nan answer refused while the page still flagged the field is captured once it clears");
{
  const page = await open({ fill: false });
  // Workday marks a required dropdown invalid after a failed Save and Continue,
  // and clears the flag a moment after the applicant answers.
  await page.evaluate((id) => {
    const btn = document.getElementById(id);
    btn.setAttribute("aria-invalid", "true");
    btn.addEventListener("change", () => setTimeout(() => btn.removeAttribute("aria-invalid"), 500));
  }, Q(8));
  await pick(page, Q(8), "Yes");
  await page.waitForTimeout(1500);
  const row = last(await held(page), /previously been employed by GDIT/);
  check("the corrected answer reaches the pending list", row?.a === "Yes", JSON.stringify(await held(page)));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
