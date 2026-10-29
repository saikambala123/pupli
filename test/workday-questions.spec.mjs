/**
 * Workday "My Information" + "Application Questions", as a GDIT posting draws
 * them.
 *
 *   node test/workday-questions.spec.mjs
 *
 * Reported against 1.14.0, with a screenshot of a GDIT application:
 *
 *   1. State was wrong. Workday names its State menu `address--countryRegion`,
 *      the state rule refused anything whose *machine name* read "country
 *      region", so the country rule took the box and offered "United States"
 *      to a menu of states — where it is the start of "United States Minor
 *      Outlying Islands". And a profile state of "MA", "GA", "VA" or "IA" was
 *      matched by letters: Maine, Michigan, Nevada, California.
 *
 *   2. Application questions were answered wrongly, several of them the
 *      opposite way: keyword rules answered questions they did not ask
 *      ("Have you ever *failed* a drug test?" got the applicant's willingness
 *      to take one — "Yes"), the state rule claimed "Please *state* your
 *      desired salary", a clearance level of "None" was matched into "No" on
 *      its first two letters, and the applicant's own saved answer to the
 *      exact question was ignored whenever a keyword rule had matched.
 *
 *   3. The résumé upload was driven: Workday's "Select files" button was
 *      collected as a dropdown.
 *
 *   4. Filling was slow.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const FIXTURE = join(ROOT, "test/fixtures/workday-questions.html");
const URL = "https://gdit.wd5.myworkdayjobs.com/en-US/external_career_site/job/Any-Location/Cloud-Solutions-Engineer_RQ227051-1/apply/applyManually";

const Q = (n) => `primaryQuestionnaire--4f1c0a9e7d2b100115a3c1e2f7a400${String(n).padStart(2, "0")}`;

const BASE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", phone: "6305550142",
    address: "1703 High Point Terrace", city: "Stanley", state: "NC", zip: "28164", country: "United States",
  },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", previouslyEmployedHere: "No",
    willingToRelocate: "Yes", willingToDrugTest: "Yes", willingToBackgroundCheck: "Yes",
    securityClearance: "None",
  },
  compensation: { desiredSalary: "160000" },
  eeo: {}, experience: [], education: [],
  documents: [{ kind: "resume", name: "resume.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0=" }],
};

const AGREEMENTS =
  "Have you signed any agreements with your current or former employer(s) that could restrict your ability to work for GDIT, compete with these employers, or solicit their customers or business? This includes agreements such as:";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});

async function fill({ profile = BASE, responses = [], settings = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses, settings }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false, ...settings },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(m, cb) {
          const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
            : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
            : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile, responses, settings });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(FIXTURE, "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  const shown = (id) => page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) return null;
    return el.tagName === "BUTTON" ? el.textContent.trim() : el.value;
  }, id);
  const collected = await page.evaluate(() =>
    window.__applifill.state.allFields.map((f) => f.el.id || f.el.getAttribute("data-automation-id") || f.el.tagName));
  const flagged = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".applifill-needs-you")).map((el) => el.id || el.getAttribute("data-automation-id")));
  const pickerOpened = await page.evaluate(() => window.__filePickerOpened);
  return { page, result, ms, shown, collected, flagged, pickerOpened };
}

/* ------------------------------------------------------------------ */
console.log("\nState comes from the profile, as the state itself");

{
  const run = await fill();
  check(
    "Workday's State menu (address--countryRegion) gets the profile state, not the country",
    (await run.shown("address--countryRegion")) === "North Carolina",
    `State = ${await run.shown("address--countryRegion")}`
  );
  check("Country is left as Workday prefilled it", (await run.shown("country--country")) === "United States of America");
  check("City and postal code from the profile",
    (await run.shown("address--city")) === "Stanley" && (await run.shown("address--postalCode")) === "28164");
  await run.page.close();
}

for (const [stored, expected] of [
  ["MA", "Massachusetts"], ["GA", "Georgia"], ["VA", "Virginia"], ["IA", "Iowa"],
  ["Virginia", "Virginia"], ["West Virginia", "West Virginia"], ["N.C.", "North Carolina"],
  ["Stanley, NC", "North Carolina"], ["Washington DC", "District of Columbia"],
]) {
  const run = await fill({ profile: { ...BASE, personal: { ...BASE.personal, state: stored } } });
  const got = await run.shown("address--countryRegion");
  check(`profile state "${stored}" selects ${expected}`, got === expected, `got ${got}`);
  await run.page.close();
}

{
  // A state the menu does not list is left for the applicant — never a neighbour.
  const run = await fill({ profile: { ...BASE, personal: { ...BASE.personal, state: "Karnataka" } } });
  check("a state that is not on the menu is left blank rather than guessed",
    (await run.shown("address--countryRegion")) === "Select One", `got ${await run.shown("address--countryRegion")}`);
  await run.page.close();
}

{
  // An exact saved answer for State still applies — in its canonical form.
  const run = await fill({
    profile: { ...BASE, personal: { ...BASE.personal, state: "" } },
    responses: [{ question: "State", normalizedKey: "state", answer: "TX", aliases: [] }],
  });
  check("a saved State answer of \"TX\" selects Texas", (await run.shown("address--countryRegion")) === "Texas",
    `got ${await run.shown("address--countryRegion")}`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nApplication questions are answered only when the answer is known");

{
  const run = await fill({
    responses: [
      { question: AGREEMENTS, answer: "No", aliases: [] },
      { question: "Application Questions", answer: "Yes", aliases: [] },   // a heading banked by an old build
    ],
  });
  const v = (n) => run.shown(Q(n));
  check("over 18 → Yes (profile)", (await v(1)) === "Yes", `got ${await v(1)}`);
  check("non-compete agreements → No (the applicant's saved answer)", (await v(2)) === "No", `got ${await v(2)}`);
  check("no agreement-type follow-up appears", !(await run.page.$("#agr-nc")));
  check("legally authorized → Yes", (await v(3)) === "Yes", `got ${await v(3)}`);
  check("sponsorship → No", (await v(4)) === "No", `got ${await v(4)}`);
  check("active clearance, profile says None → No", (await v(5)) === "No", `got ${await v(5)}`);
  check("able to obtain a clearance is not answered No for someone without one",
    (await v(6)) === "Select One", `got ${await v(6)}`);
  check("employed by the Federal Government is not answered as 'worked here before'",
    (await v(7)) === "Select One", `got ${await v(7)}`);
  check("previously employed by GDIT → No (profile)", (await v(8)) === "No", `got ${await v(8)}`);
  check("willing to relocate → Yes", (await v(9)) === "Yes", `got ${await v(9)}`);
  check("'Have you ever FAILED a drug test?' is never answered Yes", (await v(10)) === "Select One", `got ${await v(10)}`);
  check("'travel out of state' does not receive the applicant's state", (await v(11)) === "Select One", `got ${await v(11)}`);
  check("'Please state your desired salary' gets the salary, not the state",
    (await v(12)) === "160000", `got ${await v(12)}`);
  check("a saved answer filed under a section heading is never replayed",
    !(await Promise.all([6, 7, 10, 11].map(v))).includes("Yes"));
  check("unanswerable questions are highlighted for the applicant",
    [6, 7, 10, 11].every((n) => run.flagged.includes(Q(n))), `flagged: ${run.flagged.join(", ")}`);
  await run.page.close();
}

{
  // The applicant's own answer to the exact question outranks a keyword rule.
  const run = await fill({
    responses: [
      { question: "Have you ever been employed by the U.S. Federal Government (military or civilian)?", answer: "Yes", aliases: [] },
      { question: "Are you over the age of 18?", answer: "Yes", aliases: [] },
      { question: "If you do not have a security clearance, are you able to obtain one?", answer: "Yes", aliases: [] },
    ],
    profile: { ...BASE, workAuth: { ...BASE.workAuth, over18: "" } },
  });
  check("an exact saved answer is used for the Federal Government question",
    (await run.shown(Q(7))) === "Yes", `got ${await run.shown(Q(7))}`);
  check("an exact saved answer fills a profile-only question the profile left empty",
    (await run.shown(Q(1))) === "Yes", `got ${await run.shown(Q(1))}`);
  check("an exact saved answer fills the clearance-eligibility question",
    (await run.shown(Q(6))) === "Yes", `got ${await run.shown(Q(6))}`);
  await run.page.close();
}

{
  // A near match that flips the meaning is refused.
  const run = await fill({
    responses: [{ question: "Are you willing to travel out of state up to 25% of the time?", answer: "Yes", aliases: [] }],
  });
  check("an exact saved answer to the travel question is used", (await run.shown(Q(11))) === "Yes");
  await run.page.close();

  const negated = await fill({
    responses: [{ question: "Are you not willing to travel out of state up to 25% of the time?", answer: "Yes", aliases: [] }],
  });
  check("a near match with the opposite polarity is not replayed",
    (await negated.shown(Q(11))) === "Select One", `got ${await negated.shown(Q(11))}`);
  await negated.page.close();
}

{
  const run = await fill({ profile: { ...BASE, workAuth: { ...BASE.workAuth, securityClearance: "Secret" } } });
  check("a Secret clearance answers the active-clearance question Yes", (await run.shown(Q(5))) === "Yes", `got ${await run.shown(Q(5))}`);
  check("and the able-to-obtain question Yes", (await run.shown(Q(6))) === "Yes", `got ${await run.shown(Q(6))}`);
  await run.page.close();
}

{
  // Silent profile: the eligibility questions are highlighted, never drafted or guessed.
  const run = await fill({ profile: { ...BASE, workAuth: {} } });
  for (const n of [1, 3, 4, 8]) {
    check(`question ${n} is left blank when the profile is silent`, (await run.shown(Q(n))) === "Select One", `got ${await run.shown(Q(n))}`);
  }
  check("and highlighted for the applicant", [1, 3, 4, 8].every((n) => run.flagged.includes(Q(n))), `flagged: ${run.flagged.join(", ")}`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nThe résumé upload is left alone");

{
  const run = await fill({ settings: { autoAttachResume: true, aiAnswers: true } });
  check("the Select files button is not collected as a field", !run.collected.includes("select-files"), run.collected.join(", "));
  check("the file input is not collected either", !run.collected.includes("resume-input"));
  check("the file chooser is never opened", run.pickerOpened === 0, `opened ${run.pickerOpened} times`);
  check("nothing is attached", (await run.page.evaluate(() => document.getElementById("resume-input").files.length)) === 0);
  check("the upload is not outlined as needing an answer", !run.flagged.includes("select-files"));
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nSpeed");

{
  // 120ms was the dashboard default and used to be spent after every field.
  const run = await fill({ settings: { fillDelayMs: 120 } });
  check(`a full page fills in well under three seconds (${run.ms}ms)`, run.ms < 3000, `${run.ms}ms`);
  check("and nothing was skipped to get there", (await run.shown("address--countryRegion")) === "North Carolina");
  await run.page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
