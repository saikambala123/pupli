/**
 * Headless verification for the autofill engine.
 *
 *   node test/autofill.spec.mjs
 *
 * Loads the real extension libraries into a Chromium page holding mock
 * Workday / Oracle / iCIMS / SAP widgets, runs one fill, and asserts the things
 * the bug report is about:
 *
 *   1. never more than one dropdown open at a time
 *   2. every control opened at most once
 *   3. no value is written, reverted and rewritten (that is the flicker)
 *   4. the right value lands in the right row and the right date part
 *   5. voluntary self-identification questions get the profile's own answer
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1",
  label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar",
    email: "madhu.ittech@gmail.com", phone: "+1 630 555 0142",
    address: "1703 High Point Terrace, Stanley, NC, 28164",
    city: "Stanley", state: "North Carolina", zip: "28164", country: "United States",
  },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No",
    willingToRelocate: "Yes", noticePeriod: "2 weeks",
    howDidYouHear: "LinkedIn",
  },
  eeo: {
    gender: "Male",
    race: "Asian",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No",
  },
  experience: [
    {
      company: "Northern Trust Bank", title: "Senior DevOps Engineer",
      location: "Chicago, IL", startDate: "2025-04", endDate: "",
      current: true, description: "Client: American Express Bank. Governed identity and access compliance.",
    },
    {
      company: "Cognizant", title: "IAM Security Engineer",
      location: "Hyderabad, India", startDate: "2021-06", endDate: "2025-03",
      current: false, description: "Applied IT governance and risk management principles.",
    },
  ],
  education: [
    { school: "Northwestern Polytechnic University", degree: "Master's Degree", fieldOfStudy: "Computer Science", startDate: "2014-01", endDate: "2016-01" },
  ],
  documents: [],
};

const SAVED_RESPONSES = [
  { question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks", aliases: [] },
  { question: "Are you willing to relocate?", normalizedKey: "willing relocate", answer: "Yes", aliases: [] },
  { question: "How did you hear about this opportunity?", normalizedKey: "how hear about opportunity", answer: "LinkedIn", aliases: ["How did you hear about us?"] },
  // Answered in the dashboard's Saved Answers tab. These must reach the form,
  // and the first one must beat the profile-derived years-of-experience value.
  { question: "Years of relevant experience:", normalizedKey: "years relevant experience", answer: "8", aliases: [] },
  { question: "What is your earliest available start date?", normalizedKey: "what earliest available start date", answer: "Immediately", aliases: [] },
  { question: "What are your compensation expectations?", normalizedKey: "what compensation expectations", answer: "160000", aliases: [] },
  // Answers a dropdown that only exists once its parent has been chosen.
  { question: "Please specify", normalizedKey: "specify", answer: "LinkedIn", aliases: [] },
];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  const mark = pass ? "  ok  " : " FAIL ";
  console.log(`${mark} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on("pageerror", (e) => console.log("  page error:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("  console error:", m.text()); });

// Stub the extension messaging surface, then load the real libraries.
await page.addInitScript(({ profile, responses }) => {
  window.__APPLI_FILL_TEST = true;
  const session = {
    profile, profiles: [profile], responses, premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        const reply =
          msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } :
          msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } :
          { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE, responses: SAVED_RESPONSES });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/forms.html")).href);

for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}
await page.addStyleTag({ content: await readFile(join(EXT, "content/overlay.css"), "utf8") });

// Watch for overlapping menus continuously, not just at the end: a flicker can
// be over long before the run finishes.
await page.evaluate(() => {
  window.__peak = 0;
  window.__watcher = setInterval(() => {
    const open = document.querySelectorAll('[role="listbox"]');
    let n = 0;
    open.forEach((m) => { if (m.getBoundingClientRect().height > 0) n++; });
    window.__peak = Math.max(window.__peak, n);
  }, 15);
});

const started = Date.now();
const runResult = await page.evaluate(async () => {
  const res = await window.__applifill.run({ manual: true });
  clearInterval(window.__watcher);
  return {
    result: res,
    peakMenus: window.__peak,
    ztest: {
      opens: window.ZTEST.opens,
      values: window.ZTEST.values,
      maxConcurrent: window.ZTEST.maxConcurrent,
      bodyClicks: window.ZTEST.bodyClicks,
      stillOpen: document.querySelectorAll('[role="listbox"]').length
        ? Array.from(document.querySelectorAll('[role="listbox"]'))
            .filter((m) => m.getBoundingClientRect().height > 0).map((m) => m.id)
        : [],
    },
  };
});
const elapsed = Date.now() - started;

const read = async (id) =>
  page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) return null;
    if (el.tagName === "SELECT") return el.value;
    if (el.tagName === "BUTTON") return el.getAttribute("aria-valuetext") || el.textContent.trim();
    return el.value;
  }, id);

const radio = async (name) =>
  page.evaluate((n) => {
    const picked = Array.from(document.querySelectorAll(`input[name="${n}"]`)).find((r) => r.checked);
    return picked ? picked.value : null;
  }, name);

/** What a Greenhouse react-select would actually submit. */
const reactSelect = async (id) =>
  page.evaluate((n) => document.querySelector(`input[type="hidden"][name="${n}"]`)?.value ?? null, id);

/** How many times a control was committed during the run just measured. */
const writesTo = (id) => (runResult.ztest.values[id] || []).length;

if (process.env.ZDEBUG) {
  const info = await page.evaluate(() => {
    const S = window.__applifill.state;
    const M = window.APPLI_FILL_MATCHER;
    return {
      unmatched: S.unmatched.map((f) => `${f.el.id || f.el.name || f.el.tagName} :: ${String(f.label).slice(0, 70)}`),
      gh: ["gh-eligible", "gh-sponsorship", "gh-residence", "gh-gender", "gh-office"].map((id) => {
        const el = document.getElementById(id);
        return `${id} display="${M.comboboxDisplayValue(el)}" hasValue=${M.hasValue(el)} hidden="${document.querySelector(`input[type=hidden][name="${id}"]`)?.value}"`;
      }),
      opens: window.ZTEST.opens,
      validation: window.__applifill.state.lastRun?.validationErrors,
    };
  });
  console.log(JSON.stringify(info, null, 2));
}

console.log(`\nAppli-Fill autofill — ${elapsed}ms, ${runResult.result?.data?.filled} filled, ${runResult.result?.data?.unmatched} left for the user\n`);

/* ---------------- 1. no overlapping menus ---------------- */
check("only one dropdown open at a time", runResult.peakMenus <= 1, `peak simultaneous listboxes: ${runResult.peakMenus}`);
check("no menu left open at the end", runResult.ztest.stillOpen.length === 0, `still open: ${runResult.ztest.stillOpen.join(", ")}`);

/* ---------------- 2. each control opened once ---------------- */
const reopened = Object.entries(runResult.ztest.opens).filter(([, n]) => n > 1);
check("no dropdown opened more than once", reopened.length === 0, reopened.map(([k, n]) => `${k}: ${n}x`).join(", "));

/* ---------------- 3. no write / revert / rewrite ---------------- */
const churned = Object.entries(runResult.ztest.values).filter(([, list]) => list.length > 1);
check("no field written more than once", churned.length === 0, churned.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("; "));
check("no synthetic click on <body>", runResult.ztest.bodyClicks === 0, `body clicks: ${runResult.ztest.bodyClicks}`);
check("SAP-style widget kept its value", (await read("edu-degree")) === "Master's Degree", `degree = ${await read("edu-degree")}`);

/* ---------------- 4. correct values, correct rows ---------------- */
check("first name", (await read("firstName")) === "Madhu");
check("email", (await read("email")) === "madhu.ittech@gmail.com");
check("street address has no city/state/zip tail", (await read("street")) === "1703 High Point Terrace", `street = ${await read("street")}`);
check("country combobox", (await read("country")) === "United States", `country = ${await read("country")}`);
check("state select", (await read("state")) === "North Carolina", `state = ${await read("state")}`);

check("work row 1 employer", (await read("wx1-employer")) === "Northern Trust Bank", `= ${await read("wx1-employer")}`);
check("work row 1 title", (await read("wx1-title")) === "Senior DevOps Engineer", `= ${await read("wx1-title")}`);
check("work row 2 employer is the second job", (await read("wx2-employer")) === "Cognizant", `= ${await read("wx2-employer")}`);
check("work row 2 title is the second job", (await read("wx2-title")) === "IAM Security Engineer", `= ${await read("wx2-title")}`);

check("row 1 start month", (await read("wx1-start-month")) === "April", `= ${await read("wx1-start-month")}`);
check("row 1 start year", (await read("wx1-start-year")) === "2025", `= ${await read("wx1-start-year")}`);
check("row 1 end date left blank (current job)", !(await read("wx1-end-year")) || (await read("wx1-end-year")) === "Select One", `= ${await read("wx1-end-year")}`);
check("row 2 start year", (await read("wx2-start-year")) === "2021", `= ${await read("wx2-start-year")}`);
check("row 2 end year", (await read("wx2-end-year")) === "2025", `= ${await read("wx2-end-year")}`);
check("row 2 end month", (await read("wx2-end-month")) === "March", `= ${await read("wx2-end-month")}`);
check("row 2 employer country filled from its own menu", (await read("wx2-employer-country")) === "United States", `= ${await read("wx2-employer-country")}`);
check(
  "unsatisfiable menu did not leak into the next field",
  (await read("wx1-employer-country")) === "Select One",
  `wx1 country = ${await read("wx1-employer-country")}`
);

/* iCIMS parenthesised rows + split M/D/Y */
check("iCIMS row 1 employer", (await read("ic1-employer")) === "Northern Trust Bank", `= ${await read("ic1-employer")}`);
check("iCIMS row 1 title", (await read("ic1-title")) === "Senior DevOps Engineer", `= ${await read("ic1-title")}`);
check("iCIMS row 2 employer is job 2", (await read("ic2-employer")) === "Cognizant", `= ${await read("ic2-employer")}`);
check("iCIMS year box holds a year, not '2025-04'", (await read("ic1-start-yyyy")) === "2025", `= ${await read("ic1-start-yyyy")}`);
check("iCIMS start month is April", (await read("ic1-start-mm")) === "April", `= ${await read("ic1-start-mm")}`);
check("iCIMS row 2 end year", (await read("ic2-end-yyyy")) === "2025", `= ${await read("ic2-end-yyyy")}`);

/* ---------------- 5. voluntary self-identification ---------------- */
check(
  "veteran radio picked the applicant's own answer",
  (await radio("veteran-radio")) === "I AM NOT A PROTECTED VETERAN",
  `= ${await radio("veteran-radio")}`
);
check("gender select", (await read("gender")) === "Male", `= ${await read("gender")}`);
check("ethnicity select", (await read("ethnicity")) === "Asian (United States of America)", `= ${await read("ethnicity")}`);
check(
  "disability dropdown took the 'No' branch, never the 'Yes' one",
  (await read("disability")) === "No, I do not have a disability and have not had one in the past",
  `= ${await read("disability")}`
);

/* ---------------- 6. saved answers ---------------- */
check("saved answer: notice period", (await read("noticeperiod")) === "2 weeks", `= ${await read("noticeperiod")}`);
check("saved answer: relocation", (await read("relocate")) === "Yes", `= ${await read("relocate")}`);
check("saved answer: how did you hear", (await read("hear")) === "LinkedIn", `= ${await read("hear")}`);
check("sponsorship answered No", (await read("sponsorship")) === "No", `= ${await read("sponsorship")}`);
check("work authorization answered Yes", (await read("authorized")) === "Yes", `= ${await read("authorized")}`);

/* ---------------- 7. label isolation (Greenhouse flat layout) ---------------- */
check("years-of-experience question got its own answer", (await read("gh-years")) === "8", `= ${await read("gh-years")}`);
check("start-date question got its own answer", (await read("gh-start")) === "Immediately", `= ${await read("gh-start")}`);
check("compensation question got its own answer", (await read("gh-comp")) === "160000", `= ${await read("gh-comp")}`);
check(
  "the neighbouring question's answer did not leak into 'full legal name'",
  (await read("gh-designee")) === "",
  `designee name = ${await read("gh-designee")}`
);
check("unknown designee email left empty", (await read("gh-designee-email")) === "", `= ${await read("gh-designee-email")}`);
check("unknown location-requirement question left empty", (await read("gh-locationreq")) === "", `= ${await read("gh-locationreq")}`);

/* ---------------- 7b. iCIMS decorated + dependent dropdowns ---------------- */
check("iCIMS address", (await read("ic-address")) === "1703 High Point Terrace", `= ${await read("ic-address")}`);
check("iCIMS city", (await read("ic-city")) === "Stanley", `= ${await read("ic-city")}`);
check(
  "the '— Make a Selection —' country picker is answered",
  (await read("ic-country")) === "United States",
  `country = ${await read("ic-country")}`
);
check(
  "the country picker was answered without opening its menu",
  !runResult.ztest.opens["ic-country"],
  `menu opened ${runResult.ztest.opens["ic-country"]} time(s)`
);
check(
  "the widget's visible text followed the value",
  (await page.evaluate(() => document.getElementById("ic-country-widget").textContent.trim())) === "United States"
);
check(
  "State/Province is filled after Country unlocks it",
  (await read("ic-state")) === "North Carolina",
  `state = ${await read("ic-state")}`
);
check(
  // The category itself is not the point of this check — the widget exposes no
  // ARIA, so what matters is that the hidden select got answered at all. Both
  // "Job Board" and "Social Media" offer LinkedIn as a sub-answer, and the
  // dependent check below is what proves the two-step resolved correctly.
  "a widget with no ARIA is still answered through its hidden select",
  ["Job Board", "Social Media"].includes(await read("ic-hear")),
  `how did you hear = ${await read("ic-hear")}`
);
check(
  "the dependent 'Please specify' takes its saved answer",
  (await read("ic-specify")) === "LinkedIn",
  `specify = ${await read("ic-specify")}`
);

check(
  "a select inside a collapsed step is not filled",
  (await read("hidden-country")) === "",
  `hidden step country = ${await read("hidden-country")}`
);

/* ------- 7c. Greenhouse react-select: answered once, then left alone ------- */
check("Greenhouse: work eligibility answered", (await reactSelect("gh-eligible")) === "Yes", `= ${await reactSelect("gh-eligible")}`);
check("Greenhouse: sponsorship answered", (await reactSelect("gh-sponsorship")) === "No", `= ${await reactSelect("gh-sponsorship")}`);
check(
  "Greenhouse: country of residence answered",
  (await reactSelect("gh-residence")) === "United States of America",
  `= ${await reactSelect("gh-residence")}`
);
check("Greenhouse: gender answered", (await reactSelect("gh-gender")) === "Male", `= ${await reactSelect("gh-gender")}`);

for (const id of ["gh-eligible", "gh-sponsorship", "gh-residence", "gh-gender"]) {
  check(`Greenhouse: ${id} written exactly once`, writesTo(id) === 1, `writes: ${JSON.stringify(runResult.ztest.values[id] || [])}`);
  check(`Greenhouse: ${id} menu opened at most once`, (runResult.ztest.opens[id] || 0) <= 1, `opens: ${runResult.ztest.opens[id] || 0}`);
}

check(
  "Greenhouse: an unknowable question is left blank",
  (await reactSelect("gh-office")) === "",
  `office question = ${await reactSelect("gh-office")}`
);
const ghFlagged = await page.evaluate(() =>
  ["gh-eligible", "gh-sponsorship", "gh-residence", "gh-gender"]
    .filter((id) => document.getElementById(id)?.classList.contains("applifill-needs-you"))
);
check(
  "Greenhouse: answered questions are not flagged as needing the user",
  ghFlagged.length === 0,
  `wrongly highlighted: ${ghFlagged.join(", ")}`
);
check(
  "Greenhouse: the unanswerable question is the one flagged",
  await page.evaluate(() => document.getElementById("gh-office")?.classList.contains("applifill-needs-you")),
  "the office question was not highlighted for the applicant"
);

/* ------- 7d. the same shape in the other widget libraries ------- */
check(
  "Ant-style dropdown answered through its hidden input",
  (await reactSelect("antd-country")) === "United States",
  `= ${await reactSelect("antd-country")}`
);
check("Ant-style dropdown written once", writesTo("antd-country") === 1, JSON.stringify(runResult.ztest.values["antd-country"] || []));
check("Ant-style dropdown opened once", (runResult.ztest.opens["antd-country"] || 0) <= 1, `opens: ${runResult.ztest.opens["antd-country"] || 0}`);
check(
  "Downshift-style combobox keeps working",
  (await read("ds-authorized")) === "Yes",
  `= ${await read("ds-authorized")}`
);
check("Downshift-style combobox written once", writesTo("ds-authorized") === 1, JSON.stringify(runResult.ztest.values["ds-authorized"] || []));
check("Downshift-style combobox opened once", (runResult.ztest.opens["ds-authorized"] || 0) <= 1, `opens: ${runResult.ztest.opens["ds-authorized"] || 0}`);

/* ---------------- 8. resume is not attached unless asked ---------------- */
check("resume input left alone", (await page.evaluate(() => document.getElementById("resume").files.length)) === 0);

/* ---------------- 9. a second run must not touch anything ---------------- */
const before = await page.evaluate(() =>
  Array.from(document.querySelectorAll("input, select, textarea"))
    .map((el) => `${el.id}=${el.value}`).join("|")
);
const second = await page.evaluate(async () => {
  window.ZTEST.reset();
  const res = await window.__applifill.run({ manual: true });
  return {
    filled: res?.data?.filled ?? 0,
    writes: Object.keys(window.ZTEST.values).length,
    opens: Object.keys(window.ZTEST.opens).length,
    reopenedAnswered: Object.keys(window.ZTEST.opens).filter((id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      // A react-select shows nothing on the control itself — its answer is the
      // hidden input the form posts.
      const hidden = document.querySelector(`input[type="hidden"][name="${id}"]`);
      if (hidden && hidden.value.trim()) return true;
      return (el.getAttribute("aria-valuetext") || "").trim().length > 0;
    }),
    greenhouse: ["gh-eligible", "gh-sponsorship", "gh-residence", "gh-gender"].map(
      (id) => `${id}=${document.querySelector(`input[type="hidden"][name="${id}"]`)?.value ?? ""}`
    ).join("|"),
    snapshot: Array.from(document.querySelectorAll("input, select, textarea"))
      .map((el) => `${el.id}=${el.value}`).join("|"),
  };
});
check("re-running changes no already-filled value", second.snapshot === before, "some values changed on the second run");
check("re-running writes nothing", second.writes === 0, `${second.writes} field(s) written again`);
// A dropdown that is still blank may legitimately be tried again on an
// explicit second click; one that already holds an answer must not be.
check(
  "re-running only revisits dropdowns that are still blank",
  second.reopenedAnswered.length === 0,
  `answered controls reopened: ${second.reopenedAnswered.join(", ")}`
);
check(
  "re-running leaves the Greenhouse answers untouched",
  second.greenhouse === "gh-eligible=Yes|gh-sponsorship=No|gh-residence=United States of America|gh-gender=Male",
  second.greenhouse
);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
