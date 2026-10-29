/**
 * Workday: School or University as a search prompt, and Social Network URLs.
 *
 *   node test/workday-education-prompt.spec.mjs
 *
 * Reported against Workday applications: School or University has to be
 * searched and one of the results picked — typing the school's name only puts
 * text in the search box, and Save and Continue then says "The field School or
 * University is required and must have a value". The extension typed it and
 * left. And the LinkedIn box under "Social Network URLs" stayed empty although
 * the profile holds a LinkedIn address (saved under a type other than
 * "LinkedIn", which is all the old lookup read).
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://independencepetgroup.wd12.myworkdayjobs.com/en-US/careers/job/United-States%3B-Ohio/Senior-DevOps-Engineer_R1234/apply/applyManually";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const profileWith = (school) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", city: "Jacksonville", state: "FL", country: "United States" },
  websites: [
    { label: "Other", url: "https://www.linkedin.com/in/pradeep-reddy-devops" },
    { label: "Portfolio", url: "https://pradeep.dev" },
    { label: "Twitter/X", url: "https://x.com/pradeepdevops" },
  ],
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No" },
  eeo: {},
  experience: [],
  education: [{ school, degree: "Master's Degree", fieldOfStudy: "Computer Science", gpa: "3.8", startDate: "2014-01", endDate: "2016-01" }],
  documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill({ school, prefill = null }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  const profile = profileWith(school);
  await page.addInitScript(({ profile, prefill }) => {
    window.__APPLI_FILL_TEST = true;
    window.__SCHOOL_PREFILL = prefill;
    window.__held = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, prefill });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(join(ROOT, "test/fixtures/workday-education-prompt.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  await page.waitForTimeout(300);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await page.evaluate(() => {
    const pills = (id) => Array.from(document.getElementById(id).closest('[data-automation-id="multiSelectContainer"]')
      .querySelectorAll('[data-automation-id="selectedItem"]')).map((p) => p.getAttribute("title"));
    const school = document.getElementById("education-4--school");
    return {
      pills: pills("education-4--school"),
      searchText: school.value,
      schoolError: window.__schoolError,
      drafted: school.classList.contains("applifill-drafted"),
      outlined: school.classList.contains("applifill-needs-you"),
      searches: window.__searches.slice(),
      study: pills("education-4--fieldOfStudy"),
      gpa: document.getElementById("education-4--gradeAverage").value,
      linkedin: document.getElementById("socialNetworkAccounts--linkedInAccount").value,
      twitter: document.getElementById("socialNetworkAccounts--twitterAccount").value,
      facebook: document.getElementById("socialNetworkAccounts--facebookAccount").value,
      facebookOutlined: document.getElementById("socialNetworkAccounts--facebookAccount").classList.contains("applifill-needs-you"),
      popupOpen: Boolean(document.querySelector('[data-automation-id="activeListContainer"]')),
      held: window.__held.map((h) => `${h.question} = ${h.answer}`),
    };
  });
  await page.close();
  return { ...s, result, ms };
}

console.log("\nthe school as the profile has it");
{
  const s = await fill({ school: "Northwestern University" });
  check("School or University is picked from Workday's list", s.pills.join("|") === "Northwestern University", JSON.stringify(s.pills));
  check("  searched by the profile's own words", s.searches[0] === "Northwestern University", JSON.stringify(s.searches));
  check("  Save and Continue accepts it", s.schoolError === "", `error: ${s.schoolError}`);
  check("  no search text is left in the box", s.searchText === "", `= ${JSON.stringify(s.searchText)}`);
  check("  never a look-alike (Northwestern Polytechnic, Northwestern College)", !/Polytechnic|College/.test(s.pills.join()), JSON.stringify(s.pills));
  check("  not a draft: it is the profile's school", s.drafted === false && s.outlined === false);
  check("  the results list is closed afterwards", s.popupOpen === false);
  check("Field of Study already answered is left as it is", s.study.join("|") === "Computer and Information Science", JSON.stringify(s.study));
  check("GPA from the profile", s.gpa === "3.8", `= ${s.gpa}`);
  check("LinkedIn from the profile, though saved under \"Other\"", s.linkedin === "https://www.linkedin.com/in/pradeep-reddy-devops", `= ${s.linkedin}`);
  check("Twitter from the profile", s.twitter === "https://x.com/pradeepdevops", `= ${s.twitter}`);
  check("Facebook, which the profile does not have, is left empty and not outlined", s.facebook === "" && !s.facebookOutlined, JSON.stringify({ v: s.facebook, o: s.facebookOutlined }));
  check("nothing Appli-Fill filled is offered as the applicant's answer", s.held.length === 0, JSON.stringify(s.held));
  check(`done in ${s.ms}ms`, s.ms < 8000, `${s.ms}ms`);
}

console.log("\na campus or a place after the name");
{
  const s = await fill({ school: "Northwestern University, Evanston, IL" });
  check("the school is found without the place", s.pills.join("|") === "Northwestern University", JSON.stringify({ pills: s.pills, searches: s.searches }));
}

console.log("\n\"The\" in front");
{
  const s = await fill({ school: "The University of North Carolina at Charlotte" });
  check("University of North Carolina at Charlotte, not Chapel Hill", s.pills.join("|") === "University of North Carolina at Charlotte", JSON.stringify({ pills: s.pills, searches: s.searches }));
}

console.log("\ntext already sitting in the search box (a résumé parse, or an earlier fill)");
{
  const s = await fill({ school: "Northwestern University", prefill: "Northwestern University" });
  check("the school is still searched and picked", s.pills.join("|") === "Northwestern University" && s.schoolError === "", JSON.stringify(s));
}

console.log("\na school the tenant's list does not carry");
{
  const s = await fill({ school: "Hogwarts School of Witchcraft and Wizardry" });
  check("\"Other\" is picked, so the step can be saved", s.pills.join("|") === "Other" && s.schoolError === "", JSON.stringify({ pills: s.pills, searches: s.searches }));
  check("  shown as a draft to check", s.drafted === true);
}

console.log("\na name the list holds more than one school for");
{
  const s = await fill({ school: "Northwestern" });
  check("nothing is guessed", s.pills.length === 0, JSON.stringify({ pills: s.pills, searches: s.searches }));
  check("  and not \"Other\" either", !s.pills.includes("Other"));
  check("  the box is outlined for the applicant", s.outlined === true);
  check("  and left without stray search text", s.searchText === "", JSON.stringify(s.searchText));
}

console.log("\nmatching one school's name to another");
{
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  for (const f of ["lib/field-map.js", "lib/matcher.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  const scores = await page.evaluate(() => {
    const s = window.APPLI_FILL_MATCHER.schoolScore;
    return {
      mit: s("Massachusetts Institute of Technology", "MIT"),
      poly: s("Northwestern Polytechnic University", "Northwestern University"),
      uic: s("University of Illinois at Chicago", "University of Illinois"),
      campus: s("Northwestern University - Evanston", "Northwestern University"),
      order: s("University of Illinois at Urbana-Champaign", "University of Illinois Urbana-Champaign"),
      univ: s("Northeastern University", "Northeastern Univ."),
      and: s("Texas A&M University", "Texas A and M University"),
    };
  });
  check("\"MIT\" is Massachusetts Institute of Technology", scores.mit >= 88, JSON.stringify(scores));
  check("Northwestern Polytechnic University is not Northwestern University", scores.poly === 0, JSON.stringify(scores));
  check("University of Illinois at Chicago is not a match for University of Illinois", scores.uic === 0, JSON.stringify(scores));
  check("a campus after the name is the same school", scores.campus >= 90, JSON.stringify(scores));
  check("\"at\" and word order do not matter", scores.order >= 90, JSON.stringify(scores));
  check("\"Univ.\" is University", scores.univ >= 90, JSON.stringify(scores));
  check("\"&\" is \"and\"", scores.and >= 90, JSON.stringify(scores));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
