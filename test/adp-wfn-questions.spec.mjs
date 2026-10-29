/**
 * ADP Workforce Now: the employer's own questions, as reported on 1.26.0.
 *
 *   node test/adp-wfn-questions.spec.mjs
 *
 * "Work eligibility questions should be filled using extension like 18 years,
 * previously employed at this company … willing to relocate and … do you have
 * any relatives employed by … in adp currency type is saved but not using in
 * fields … if we save such related questions in saved answers it should apply
 * for every company applications … available start date is not fixed."
 *
 * The page is a credit union's Questions step (test/fixtures/
 * adp-wfn-questions.html): SDF radio groups and react-select lists under
 * `label.qLabel[for]`, a conflict-of-interest box ("If no, enter NA"), Date
 * Available, the desired salary with Annually / Hourly, the amount and
 * "Select currency type", and "Did any of our current employees inform you
 * about this position?". The page's own Next is pressed at the end.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=7b1e4c2a-9d1f-4c55-8a2e-3f0c5e6d7a81&ccId=19000101_000001&jobId=512233&lang=en_US";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const day = (n) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
const START = day(6);

/** The reporter's Work eligibility and Compensation, as saved in the portal. */
const PROFILE = {
  _id: "p1", label: "Default profile",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", phone: "515-555-0142", city: "Des Moines", state: "IA", country: "United States" },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "Yes", workAuthType: "H-1B", willingToRelocate: "Yes",
    remotePreference: "Hybrid", availableStartDate: iso(START), noticePeriod: "0", over18: "Yes",
    previouslyEmployedHere: "No", relativesEmployedHere: "No", referredBy: ".", howDidYouHear: "LinkedIn",
    securityClearance: "None",
  },
  compensation: { desiredSalary: "95000", salaryCurrency: "USD", salaryPeriod: "year" },
  eeo: {},
  experience: [{ company: "Globex Bank", title: "Systems Analyst", startDate: "2021-04", current: true }],
  education: [], documents: [],
};

const [KIT, PAGE] = await Promise.all([
  readFile(join(ROOT, "test/fixtures/adp-sdf-kit.js"), "utf8"),
  readFile(join(ROOT, "test/fixtures/adp-wfn-questions.html"), "utf8"),
]);
const HTML = PAGE.replace("<!--SDF-KIT-->", `<script>${KIT}</script>`);

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/** One fill (from the popup, with `popup`), then the page's Next. */
async function fillAndNext({ wfnq = {}, popup = false, profile = PROFILE, responses = [], answer = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, wfnq, popup, responses }) => {
    window.__APPLI_FILL_TEST = true;
    window.__wfnq = wfnq;
    window.__held = [];
    const session = { profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
    if (popup) {
      window.__POPUP_OPEN = true;
      for (const type of ["focus", "blur", "focusin", "focusout"]) {
        window.addEventListener(type, (e) => { if (window.__POPUP_OPEN && e.isTrusted) e.stopImmediatePropagation(); }, true);
      }
    }
  }, { profile, wfnq, popup, responses });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: HTML }));
  await page.goto(URL);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const started = Date.now();
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const took = Date.now() - started;
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  // The applicant answers what was left for them, by hand.
  if (answer) await answer(page);
  await page.click("h1");
  await page.waitForTimeout(300);
  await page.click("#ja_sv_cw_next_footer_btn");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.id || e.tagName.toLowerCase()),
    boxes: Object.fromEntries(Array.from(document.querySelectorAll("input.vdl-textbox")).map((i) => [i.id, i.value])),
    held: window.__held.map((h) => ({ question: h.question, answer: h.answer, company: h.company, inputType: h.inputType })),
    openLists: document.querySelectorAll(".MDFSelectBox__menu").length,
  }));
  await page.close();
  return { res, took, ...out };
}

/** Pick a react-select choice the way a person does. */
const pickMdf = (id, text) => async (page) => {
  await page.click(`#${id}`);
  await page.waitForTimeout(150);
  await page.click(`.MDFSelectBox__option:text-is("${text}")`);
  await page.waitForTimeout(500);
};
/** Click a radio button of an SDF radio group. */
const pickRadio = (id, value) => async (page) => {
  await page.click(`#${id} sdf-radio-button[value="${value}"]`);
  await page.waitForTimeout(500);
};

function expectProfileAnswers(r) {
  check("At least 18 years of age: Yes", r.model.q1 === "Y", JSON.stringify(r.model.q1));
  check("Previously employed by the credit union: No (Previously employed at this company?)", r.model.q2 === "No", JSON.stringify(r.model.q2));
  check("Willing to relocate, though the question says the job requires it: Yes", r.model.q3 === "Y", JSON.stringify(r.model.q3));
  check("Relatives employed by the credit union: No (the new profile answer)", r.model.q4 === "No", JSON.stringify(r.model.q4));
  check(`Date Available: the profile's date, ${mdy(START)}`, r.model.q8 === mdy(START), JSON.stringify(r.model.q8));
  check("Desired salary 95000, counted Annually", r.model.desiredSalary === "95000" && r.model.salaryFrequency === "A",
    JSON.stringify([r.model.desiredSalary, r.model.salaryFrequency]));
  check("Currency type: USD, the profile's currency", r.model.salaryCurrency === "USD", JSON.stringify(r.model.salaryCurrency));
  check("Did any current employees inform you: No (heard on LinkedIn, nobody referred)", r.model.q10 === "N", JSON.stringify(r.model.q10));
  check("the conflict-of-interest box is never given the current employer's name",
    !/globex/i.test(r.boxes.question_5 ?? ""), JSON.stringify(r.boxes.question_5));
}

console.log("\nThe Questions step, with the page focused");
{
  const r = await fillAndNext();
  expectProfileAnswers(r);
  check("what no profile holds is left outlined for the applicant (contact employer, within 45 miles, other jobs)",
    ["question_5", "question_6", "question_7"].every((id) => r.outlined.includes(id)), JSON.stringify(r.outlined));
  check("Next reports only those three", JSON.stringify(r.errors) === JSON.stringify(["q5: required", "q6: required", "q7: required"]), JSON.stringify(r.errors));
  check("no list is left open", r.openLists === 0, String(r.openLists));
  check("the fill is quick (under 6 seconds)", r.took < 6000, `${r.took} ms`);
}

console.log("\nThe Questions step, filled from the popup (the page has no focus)");
expectProfileAnswers(await fillAndNext({ popup: true }));

console.log("\nCurrency type, however the list names itself");
for (const [currency, label] of [
  ["sdf-placeholder", "a list named only by its placeholder"],
  ["sdf-drawn", "a list whose only name is the text it draws"],
  ["mdf", "a react-select whose placeholder says \"Select currency type\""],
]) {
  const r = await fillAndNext({ wfnq: { currency } });
  const want = currency === "mdf" ? "United States Dollar ( USD )" : "USD";
  check(`${label}: USD`, r.model.salaryCurrency === want, JSON.stringify(r.model.salaryCurrency));
  check("  and the amount and the Annually / Hourly choice are untouched by it", r.model.desiredSalary === "95000" && r.model.salaryFrequency === "A",
    JSON.stringify([r.model.desiredSalary, r.model.salaryFrequency]));
}
{
  const r = await fillAndNext({ profile: { ...PROFILE, compensation: { ...PROFILE.compensation, salaryCurrency: "INR" } } });
  check("a profile saved in Indian Rupees: INR", r.model.salaryCurrency === "INR", JSON.stringify(r.model.salaryCurrency));
}
{
  const r = await fillAndNext({ profile: { ...PROFILE, compensation: { ...PROFILE.compensation, desiredSalary: "48", salaryPeriod: "hour" } } });
  check("a profile whose Period is per hour: Hourly", r.model.salaryFrequency === "H", JSON.stringify(r.model.salaryFrequency));
}

console.log("\nSaved answers for the questions no profile holds, given on another company's application");
{
  const elsewhere = "workforcenow.adp.com";
  const r = await fillAndNext({
    responses: [
      { _id: "s1", question: "May we contact your current employer?", answer: "No", inputType: "select", lastDomain: elsewhere, lastCompany: "Principal Financial Group" },
      { _id: "s2", question: "Do you currently live within 45 miles of the Des Moines metro area and are able to work onsite?", answer: "Yes", inputType: "select", lastDomain: elsewhere },
      { _id: "s3", question: "Do you have any additional jobs in the financial services, banking, or credit union industry? If yes, for conflict of interest review purposes, please list employer and type of work. If no, enter NA.", answer: "NA", inputType: "text", lastDomain: elsewhere },
    ],
  });
  check("May we contact your current employer: No", r.model.q6 === "No", JSON.stringify(r.model.q6));
  check("Within 45 miles: Yes", r.model.q7 === "Yes", JSON.stringify(r.model.q7));
  check("the conflict-of-interest box: NA (it used to be closed to the saved answer)", r.model.q5 === "NA", JSON.stringify(r.model.q5));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nAnswered by hand on one company's application, filled on the next company's");
{
  const blank = { ...PROFILE, workAuth: { ...PROFILE.workAuth, previouslyEmployedHere: "", relativesEmployedHere: "", howDidYouHear: "", referredBy: "" } };
  const first = await fillAndNext({
    profile: blank,
    answer: async (page) => {
      await pickMdf("question_2", "No")(page);
      await pickMdf("question_4", "No")(page);
      await pickMdf("question_6", "No")(page);
      await pickRadio("question_10", "N")(page);
    },
  });
  const held = (re) => first.held.filter((h) => re.test(h.question)).pop();
  const prior = held(/previously been employed/i);
  const relatives = held(/relatives/i);
  const referral = held(/inform you about this position/i);
  check("the previous-employment answer is held under its question, with the company",
    prior?.answer === "No" && /Hawkeye Community Credit Union\?$/.test(prior?.question ?? "") && prior?.company === "Hawkeye Community Credit Union",
    JSON.stringify(prior));
  check("the relatives answer too", relatives?.answer === "No" && relatives?.company === "Hawkeye Community Credit Union", JSON.stringify(relatives));
  check("an answer on an ADP radio group is held under its question (it was never held)",
    referral?.answer === "No" && referral?.question === "Did any of our current employees inform you about this position?", JSON.stringify(referral));
  check("nothing is held under the section heading", !first.held.some((h) => /^questions$/i.test(h.question)), JSON.stringify(first.held.map((h) => h.question)));

  // The next application: another employer, the same questionnaire.
  const saved = first.held.map((h, i) => ({ _id: `h${i}`, question: h.question, answer: h.answer, inputType: h.inputType, lastDomain: "workforcenow.adp.com", lastCompany: h.company }));
  const next = await fillAndNext({ wfnq: { company: "Principal Financial Group" }, profile: blank, responses: saved });
  check("Previously employed by Principal Financial Group: the No given to the credit union", next.model.q2 === "No", JSON.stringify(next.model.q2));
  check("Relatives employed by Principal Financial Group: the No given to the credit union", next.model.q4 === "No", JSON.stringify(next.model.q4));
  check("May we contact your current employer: No", next.model.q6 === "No", JSON.stringify(next.model.q6));
  check("Did any current employees inform you: No", next.model.q10 === "N", JSON.stringify(next.model.q10));
}
{
  const blank = { ...PROFILE, workAuth: { ...PROFILE.workAuth, relativesEmployedHere: "" } };
  const r = await fillAndNext({
    wfnq: { company: "Principal Financial Group" }, profile: blank,
    responses: [{ _id: "y1", question: "Do you have any relatives employed by Hawkeye Community Credit Union?", answer: "Yes", inputType: "select", lastDomain: "workforcenow.adp.com", lastCompany: "Hawkeye Community Credit Union" }],
  });
  check("a Yes for relatives at one company is never carried to another", !r.model.q4 && r.outlined.includes("question_4"), JSON.stringify({ q4: r.model.q4, outlined: r.outlined }));
}
{
  const blank = { ...PROFILE, workAuth: { ...PROFILE.workAuth, relativesEmployedHere: "" } };
  const r = await fillAndNext({
    wfnq: { company: "Principal Financial Group" }, profile: blank,
    responses: [{ _id: "y2", question: "Do you have any relatives employed by this company?", answer: "Yes", inputType: "select", lastDomain: "workforcenow.adp.com", lastCompany: "Hawkeye Community Credit Union" }],
  });
  check("  nor a Yes to \"…this company?\" given on the credit union's own application", !r.model.q4, JSON.stringify(r.model.q4));
}
{
  const blank = { ...PROFILE, workAuth: { ...PROFILE.workAuth, previouslyEmployedHere: "", relativesEmployedHere: "" } };
  const r = await fillAndNext({
    profile: blank,
    responses: [
      { _id: "g1", question: "Have you previously been employed by this company?", answer: "No", inputType: "select" },
      { _id: "g2", question: "Do you have any relatives employed by this company?", answer: "No", inputType: "select" },
    ],
  });
  check("answers written in Saved Answers as \"this company\" fill the credit union's questions",
    r.model.q2 === "No" && r.model.q4 === "No", JSON.stringify([r.model.q2, r.model.q4]));
}

console.log("\nThe work history still decides for a company the applicant worked at");
{
  const r = await fillAndNext({ profile: { ...PROFILE, experience: [
    { company: "Globex Bank", title: "Systems Analyst", startDate: "2021-04", current: true },
    { company: "Hawkeye Community Credit Union", title: "Teller", startDate: "2016-01", endDate: "2018-06" },
  ] } });
  check("Previously employed by Hawkeye Community Credit Union: Yes (it is on the work history)", r.model.q2 === "Yes", JSON.stringify(r.model.q2));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
