/**
 * Work eligibility, start date and relatives, however a company words them.
 *
 *   node test/eligibility-wording.spec.mjs
 *
 * Reported on 1.26.0: the eligibility questions — at least 18, worked here
 * before, willing to relocate, relatives employed here — should be answered
 * from the profile "for every company applications", and "available start date
 * is not fixed". The same questions come in many wordings, and a good number
 * of them were left blank, or claimed by the wrong rule:
 *
 *   - "Are you a former Acme employee?", "Have you ever been an employee of
 *     Acme?", "Prior employment with Acme?" — blank;
 *   - "Are you related to anyone currently employed by Acme?" — answered as if
 *     it asked whether the applicant had worked at Acme;
 *   - every other relatives question — blank (there was no profile answer);
 *   - "Are you under the age of 18?", "…at least 16?" — blank;
 *   - "This position requires relocation… Are you willing to relocate?" and
 *     "…willing to relocate at your own expense?" — refused as questions about
 *     relocation assistance;
 *   - "Date Available", "How soon can you start?", "When could you begin?" —
 *     blank; and "When can you start?" asked as choices ("Immediately",
 *     "Within 2 weeks"…), or a notice period asked as choices — never answered.
 *
 * An ordinary application page (Greenhouse), so none of this depends on ADP.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://boards.greenhouse.io/acmecorporation/jobs/4455667";

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

const PROFILE = {
  _id: "p1", label: "Default profile",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", phone: "515-555-0142", city: "Des Moines", state: "IA", country: "United States" },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "Yes", workAuthType: "H-1B", willingToRelocate: "Yes",
    availableStartDate: iso(day(6)), noticePeriod: "0", over18: "Yes",
    previouslyEmployedHere: "No", relativesEmployedHere: "No", referredBy: "", howDidYouHear: "LinkedIn",
  },
  compensation: { desiredSalary: "120000", salaryCurrency: "USD", salaryPeriod: "year" },
  eeo: {},
  experience: [{ company: "Globex", title: "Engineer", startDate: "2021-01", current: true }],
  education: [], documents: [],
};

const YN = ["Yes", "No"];
/**
 * [id, kind, question, options, expected]. Kind "select" and "radio" offer the
 * options; "text" is a box. An expected "" means left blank.
 */
const QUESTIONS = (start) => [
  // At least 18, however asked
  ["a1", "select", "Are you at least 18 years of age?", YN, "Yes"],
  ["a2", "radio", "Are you 18 years of age or older?", YN, "Yes"],
  ["a3", "select", "Are you over the age of 18?", YN, "Yes"],
  ["a4", "select", "Are you under the age of 18?", YN, "No"],
  ["a5", "radio", "Are you at least 16 years of age?", YN, "Yes"],
  ["a6", "select", "Are you at least 21 years of age?", YN, ""],
  ["a7", "select", "Do you have at least 18 years of experience in software?", YN, ""],
  // Worked here before, however asked
  ["p1", "select", "Have you ever worked for Acme Corporation before?", YN, "No"],
  ["p2", "radio", "Are you a former Acme Corporation employee?", YN, "No"],
  ["p3", "select", "Have you ever been an employee of Acme Corporation?", YN, "No"],
  ["p4", "select", "Prior employment with Acme Corporation?", YN, "No"],
  ["p5", "select", "Are you a current or former employee of Acme Corporation?", YN, "No"],
  // Relocation, however asked
  ["r1", "select", "This position requires relocation to Des Moines, IA. Are you willing to relocate?", YN, "Yes"],
  ["r2", "radio", "If offered the position, are you willing to relocate at your own expense?", YN, "Yes"],
  ["r3", "select", "Are you open to relocation?", YN, "Yes"],
  ["r4", "select", "Will you require relocation assistance?", YN, ""],
  // Relatives, however asked
  ["k1", "select", "Do you have any relatives employed by Acme Corporation?", YN, "No"],
  ["k2", "radio", "Are you related to anyone currently employed by Acme Corporation?", YN, "No"],
  ["k3", "select", "Is anyone in your immediate family currently employed by Acme Corporation?", YN, "No"],
  ["k4", "select", "Does Acme Corporation employ any of your relatives?", YN, "No"],
  ["k5", "select", "Do you have a relative or friend employed with us?", YN, ""],
  ["k6", "text", "If you have relatives employed by Acme Corporation, please list their names and relationship. If none, enter N/A.", null, "N/A"],
  ["k7", "select", "Are you related to any government official?", YN, ""],
  ["k8", "select", "Do you have relatives who work in banking?", YN, ""],
  // Referral
  ["e1", "radio", "Did any of our current employees inform you about this position?", YN, "No"],
  ["e2", "select", "Were you referred by a current employee?", YN, "No"],
  // Start date, however asked
  ["s1", "text", "Date Available", null, mdy(start)],
  ["s2", "text", "How soon can you start?", null, mdy(start)],
  ["s3", "text", "If offered a position, when would you be available to begin work?", null, mdy(start)],
  ["s4", "text", "Earliest date you can start", null, mdy(start)],
  ["s5", "select", "When can you start?", ["Immediately", "Within 2 weeks", "Within 1 month", "1-3 months", "More than 3 months"], "Within 2 weeks"],
  ["s6", "radio", "How soon could you start working?", ["Immediately", "1 week", "2 weeks", "1 month", "2+ months"], "1 week"],
  ["s7", "select", "Can you start within two weeks of an offer?", YN, "Yes"],
  ["n1", "select", "What is your notice period?", ["Immediate", "15 days", "30 days", "60 days", "90 days"], "Immediate"],
  // Mentions an employer, asks for something else
  ["x1", "text", "Do you have any additional jobs in the financial services industry? If yes, please list employer and type of work. If no, enter NA.", null, ""],
];

function pageFor(questions) {
  const control = ([id, kind, q, options]) => {
    if (kind === "radio") {
      return `<fieldset class="field" id="${id}"><legend>${q}</legend>${options.map((o, i) =>
        `<label><input type="radio" name="${id}" id="${id}_${i}" value="${o}"> ${o}</label>`).join(" ")}</fieldset>`;
    }
    if (kind === "select") {
      return `<div class="field"><label for="${id}">${q}</label><select id="${id}" name="${id}"><option value="">Select...</option>${options.map((o) => `<option>${o}</option>`).join("")}</select></div>`;
    }
    return `<div class="field"><label for="${id}">${q}</label><input type="text" id="${id}" name="${id}"></div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Job Application for Software Engineer at Acme Corporation</title>
  <style>body{font-family:system-ui;padding:20px;max-width:760px}.field{margin-bottom:14px}label{display:block}select,input[type=text]{width:100%;padding:6px}</style></head>
  <body><h1 class="app-title">Software Engineer</h1><div class="company-name">at Acme Corporation</div>
  <form id="application_form">${questions.map(control).join("\n")}
  <input type="file" id="resume"><button type="submit">Submit Application</button></form></body></html>`;
}

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill(profile, questions) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile });
  const html = pageFor(questions);
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto(URL);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(500);
  const values = await page.evaluate((ids) => Object.fromEntries(ids.map(([id, kind]) => {
    if (kind === "radio") return [id, document.querySelector(`input[name="${id}"]:checked`)?.value ?? ""];
    return [id, document.getElementById(id)?.value ?? ""];
  })), questions.map(([id, kind]) => [id, kind]));
  await page.close();
  return values;
}

console.log("\nThe reporter's profile: over 18, never worked at Acme, willing to relocate, no relatives there, starting in six days");
{
  const questions = QUESTIONS(day(6));
  const got = await fill(PROFILE, questions);
  for (const [id, , q, , want] of questions) {
    check(`${q} → ${want === "" ? "left blank" : want}`, got[id] === want, `got "${got[id]}"`);
  }
}

console.log("\nA former employee with no relatives there: the relatives question is not the employment question");
{
  const questions = QUESTIONS(day(6)).filter(([id]) => ["k2", "p1"].includes(id));
  const profile = { ...PROFILE, workAuth: { ...PROFILE.workAuth, previouslyEmployedHere: "Yes" } };
  const got = await fill(profile, questions);
  check("Have you ever worked for Acme Corporation before? → Yes", got.p1 === "Yes", `got "${got.p1}"`);
  check("Are you related to anyone currently employed by Acme Corporation? → still No", got.k2 === "No", `got "${got.k2}"`);
}

console.log("\nA date of birth answers an age the profile's yes / no cannot");
{
  const questions = QUESTIONS(day(6)).filter(([id]) => id === "a6");
  const born = day(0);
  born.setFullYear(born.getFullYear() - 30);
  const got = await fill({ ...PROFILE, personal: { ...PROFILE.personal, dateOfBirth: iso(born) } }, questions);
  check("Are you at least 21 years of age? → Yes (thirty years old)", got.a6 === "Yes", `got "${got.a6}"`);
}

console.log("\nStarting today, and a notice period instead of a date");
{
  const ids = ["s5", "s6", "s7", "n1"];
  const today = await fill({ ...PROFILE, workAuth: { ...PROFILE.workAuth, availableStartDate: "Immediately" } },
    QUESTIONS(day(0)).filter(([id]) => ids.includes(id)));
  check("\"Immediately\": When can you start? → Immediately", today.s5 === "Immediately", `got "${today.s5}"`);
  check("  and the radio choices → Immediately", today.s6 === "Immediately", `got "${today.s6}"`);
  const notice = await fill({ ...PROFILE, workAuth: { ...PROFILE.workAuth, availableStartDate: "", noticePeriod: "30 days" } },
    QUESTIONS(day(30)).filter(([id]) => ids.includes(id)));
  check("no start date, 30 days' notice: When can you start? → Within 1 month", notice.s5 === "Within 1 month", `got "${notice.s5}"`);
  check("  Can you start within two weeks? → No", notice.s7 === "No", `got "${notice.s7}"`);
  check("  What is your notice period? → 30 days", notice.n1 === "30 days", `got "${notice.n1}"`);
}

console.log("\nNothing in the profile: nothing is invented");
{
  const profile = { ...PROFILE, workAuth: {}, experience: [] };
  const questions = QUESTIONS(day(6)).filter(([id]) => ["a1", "a4", "p1", "k1", "k6", "r1", "s5", "n1"].includes(id));
  const got = await fill(profile, questions);
  for (const [id, , q] of questions) {
    // An explicit N/A instruction is the requested fallback for an unknown
    // answer; the other declarations still have no implied answer.
    const expected = id === "k6" ? "N/A" : "";
    check(`${q} → ${expected || "left blank"}`, got[id] === expected, `got "${got[id]}"`);
  }
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
