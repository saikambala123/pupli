/**
 * ADP Recruiting Management (myjobs.adp.com): the apply flow.
 *
 *   node test/adp-myjobs.spec.mjs
 *
 * Reported on 1.25.0: "adp application also should fill using my portal and
 * extension correctly". Nothing on an ADP Recruiting Management application
 * was filled. Its questions are ADP's SDF web components: every box sits
 * inside its component's shadow root, where no label reaches it (the boxes
 * read as "off | input"), the lists, radio groups and check boxes draw their
 * own choices, and every write to a box inside a shadow root was refused as
 * "not on the page".
 *
 * The page here is drawn from the markup other fillers read off the live site
 * (see test/fixtures/adp-sdf-kit.js and adp-myjobs.html): `adp-form-group`
 * questions labelled by `label.form-control-label`, the prescreening questions
 * of `#prescreeningForm` with the question in the row above, the Employment
 * History rows with "Add Employer", and the self-identification page with the
 * CC-305 signature. The page's own Next is pressed at the end and its own
 * check has to pass.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = (section) => `https://myjobs.adp.com/acmecareers/cx/job-details/apply?reqId=9201266812345&workflowComponent=${section}`;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456",
    address: "8451 Gate Pkwy W Apt 128", city: "Jacksonville", state: "FL", zip: "32216", country: "United States",
  },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No", previouslyEmployedHere: "No", over18: "Yes",
    willingToBackgroundCheck: "Yes", howDidYouHear: "LinkedIn", availableStartDate: "Immediately",
  },
  compensation: { desiredSalary: "120000" },
  eeo: {
    gender: "Male", hispanicLatino: "No", race: "Asian", veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No, I don't have a disability",
  },
  experience: [
    { company: "Globex", title: "Senior SRE", startDate: "2021-03", endDate: "", current: true },
    { company: "Initech", title: "DevOps Engineer", startDate: "2018-06", endDate: "2021-02" },
  ],
  education: [], documents: [],
};

const [KIT, PAGE] = await Promise.all([
  readFile(join(ROOT, "test/fixtures/adp-sdf-kit.js"), "utf8"),
  readFile(join(ROOT, "test/fixtures/adp-myjobs.html"), "utf8"),
]);
const HTML = PAGE.replace("<!--SDF-KIT-->", `<script>${KIT}</script>`);

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/** One step filled (from the popup, with `popup`), the popup closed, and the page's Next pressed. */
async function fillAndNext({ section = "contact", adp = {}, sdf = {}, popup = false, profile = PROFILE } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, adp, sdf, popup }) => {
    window.__APPLI_FILL_TEST = true;
    window.__adp = adp;
    window.__sdf = sdf;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
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
  }, { profile, adp: { section, ...adp }, sdf, popup });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: HTML }));
  await page.goto(URL(section));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("h1");
  await page.waitForTimeout(300);
  await page.click("#next");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.id || e.tagName.toLowerCase()),
    // Open by its own say, or by its pane showing (a list that says nothing when open).
    openLists: Array.from(document.querySelectorAll("sdf-select-simple"))
      .filter((e) => e.classList.contains("open") || (e.pane && !e.pane.classList.contains("floating-pane-hidden"))).map((e) => e.id),
    // Text left in a list's search box.
    filterLeft: Array.from(document.querySelectorAll("sdf-select-simple")).map((e) => [e.id, e.filterBox?.value || ""]).filter(([, v]) => v),
    shown: Object.fromEntries(Array.from(document.querySelectorAll("sdf-input, sdf-date-picker")).map((h) => [h.id, (h.shadowRoot || h).querySelector("input, textarea")?.value ?? ""])),
  }));
  await page.close();
  return { res, ...out };
}

const today = (() => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
})();

/** What Next must accept, and no list left open. */
function expectClean(r) {
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
  check("  and no list is left open over the form", r.openLists.length === 0, JSON.stringify(r.openLists));
}

function expectContact(r, { phone = "5162058456" } = {}) {
  check("First Name, Last Name and Email kept by the form (the boxes inside the components)",
    r.model.firstName === "Pradeep" && r.model.lastName === "Reddy" && r.model.email === "pradeepbeeram91@gmail.com",
    JSON.stringify([r.model.firstName, r.model.lastName, r.model.email]));
  check("  and the same text shows in the boxes",
    r.shown.firstName === "Pradeep" && r.shown.lastName === "Reddy", JSON.stringify(r.shown));
  check("Phone: the number in its box, ten digits, the country list left at United States (+1)",
    String(r.model.phone ?? "").replace(/\D+/g, "") === phone && !String(r.model.phone).includes("+"),
    JSON.stringify(r.model.phone));
  check("Phone Type: Mobile, picked from its list", r.model.phoneType === "M" && r.log.includes("picked phoneType: Mobile"),
    JSON.stringify({ phoneType: r.model.phoneType, log: r.log }));
  check("Address Line 1, City and Zip/Postal Code",
    r.model.addressLine1 === "8451 Gate Pkwy W Apt 128" && r.model.city === "Jacksonville" && r.model.zipCode === "32216",
    JSON.stringify([r.model.addressLine1, r.model.city, r.model.zipCode]));
  check("Country: United States picked from the long list (not United States Minor Outlying Islands)",
    r.model.country === "USA" && r.log.includes("picked country: United States"), JSON.stringify({ country: r.model.country, log: r.log }));
  check("State/Province: Florida, found through the list's search for the profile's \"FL\"",
    r.model.state === "FL" && r.log.includes("picked state: Florida"), JSON.stringify({ state: r.model.state, log: r.log }));
  check("Middle Name and Address Line 2 left empty, and not outlined (optional, nothing in the profile)",
    !r.model.middleName && !r.model.addressLine2 && !r.outlined.includes("middleName") && !r.outlined.includes("addressLine2"),
    JSON.stringify({ outlined: r.outlined }));
  expectClean(r);
}

console.log("\nContact Information, with the page focused");
expectContact(await fillAndNext({ section: "contact" }));

console.log("\nContact Information, filled from the popup (the page has no focus)");
expectContact(await fillAndNext({ section: "contact", popup: true }));

console.log("\nContact Information: the form keeps a box only once it is left, and a choice shows 0.4 s after the click");
expectContact(await fillAndNext({ section: "contact", adp: { commitOnChange: true }, sdf: { pickLatency: 400 }, popup: true }));

/**
 * How ADP's components draw themselves cannot be seen from outside, so each
 * plausible way is filled too: the boxes in the components' own light DOM,
 * the open list drawn at the end of the page, and list items named only by
 * their `label`.
 */
for (const [what, sdf] of [
  ["the boxes drawn in the components' light DOM", { lightBoxes: true }],
  ["each open list drawn at the end of the page", { portal: true }],
  ["list items named only by their `label`", { labelItems: true }],
]) {
  console.log(`\nContact Information: ${what}`);
  expectContact(await fillAndNext({ section: "contact", sdf, popup: true }));
}

console.log("\nContact Information: each open list drawn at the end of the page, and nothing on the list itself says it is open");
expectContact(await fillAndNext({ section: "contact", sdf: { portal: true, quietFrame: true }, popup: true }));

for (const state of ["TX", "Texas"]) {
  console.log(`\nContact Information: the profile's state saved as "${state}"`);
  const r = await fillAndNext({ section: "contact", profile: { ...PROFILE, personal: { ...PROFILE.personal, state } } });
  check("State/Province: Texas, found through the list's search",
    r.model.state === "TX" && r.log.includes("picked state: Texas") && !r.outlined.includes("state"),
    JSON.stringify({ state: r.model.state, outlined: r.outlined, log: r.log }));
  expectClean(r);
}

console.log("\nContact Information: a country the list does not offer");
{
  const r = await fillAndNext({ section: "contact", profile: { ...PROFILE, personal: { ...PROFILE.personal, country: "Atlantis" } } });
  check("Country left empty and outlined for the applicant", !r.model.country && r.outlined.includes("country"),
    JSON.stringify({ country: r.model.country, outlined: r.outlined }));
  check("  its search box emptied again, and the list closed", r.filterLeft.length === 0 && r.openLists.length === 0,
    JSON.stringify({ filterLeft: r.filterLeft, openLists: r.openLists }));
  check("  and the rest of the page filled as usual",
    r.model.firstName === "Pradeep" && r.model.state === "FL" && r.model.phoneType === "M", JSON.stringify(r.model));
}

console.log("\nContact Information: the profile's phone saved as \"+1 516-205-8456\"");
{
  const r = await fillAndNext({ section: "contact", profile: { ...PROFILE, personal: { ...PROFILE.personal, phone: "+1 516-205-8456" } } });
  check("the national number goes in the box, without the +1 the country list already has",
    String(r.model.phone ?? "").replace(/\D+/g, "") === "5162058456" && !String(r.model.phone).includes("+"), JSON.stringify(r.model.phone));
  expectClean(r);
}

for (const popup of [false, true]) {
  console.log(`\nQuestions (#prescreeningForm), ${popup ? "from the popup" : "with the page focused"}`);
  const r = await fillAndNext({ section: "questions", popup });
  check("At least 18: Yes (the question as the group's aria-label)", r.model.q_1001 === "Y", JSON.stringify(r.model.q_1001));
  check("Authorized to work: Yes (the question as the group's own label)", r.model.q_1002 === "Y", JSON.stringify(r.model.q_1002));
  check("Sponsorship: No (the question in the row above, the choices named only by `label`)", r.model.q_1003 === "N", JSON.stringify(r.model.q_1003));
  check("How did you hear: LinkedIn, picked from the list", r.model.q_1004 === "LI" && r.log.includes("picked q_1004: LinkedIn"),
    JSON.stringify({ q: r.model.q_1004, log: r.log }));
  check("Salary expectations: the profile's 120000", r.model.q_1005 === "120000", JSON.stringify(r.model.q_1005));
  check("Ever employed by Acme Corporation: No", r.model.q_1006 === "N", JSON.stringify(r.model.q_1006));
  check(`Earliest start date: today (${today}), as MM/DD/YYYY`, r.model.q_1007 === today, JSON.stringify(r.model.q_1007));
  check("Background check: ticked, as the profile consents", r.model.q_1008 === true && r.log.includes("ticked q_1008"),
    JSON.stringify({ q: r.model.q_1008, log: r.log }));
  check("the free-text question nothing in the profile answers is left for the applicant, outlined",
    !r.model.q_1009 && r.outlined.includes("q_1009"), JSON.stringify({ q: r.model.q_1009, outlined: r.outlined }));
  expectClean(r);
}

for (const [what, sdf] of [["the boxes in the components' light DOM", { lightBoxes: true }], ["the lists drawn at the end of the page", { portal: true, labelItems: true }]]) {
  console.log(`\nQuestions: ${what}`);
  const r = await fillAndNext({ section: "questions", sdf });
  check("every question the profile answers is answered",
    r.model.q_1001 === "Y" && r.model.q_1002 === "Y" && r.model.q_1003 === "N" && r.model.q_1004 === "LI" &&
    r.model.q_1005 === "120000" && r.model.q_1006 === "N" && r.model.q_1007 === today && r.model.q_1008 === true,
    JSON.stringify(r.model));
  expectClean(r);
}

console.log("\nQuestions, with a profile that gives no consent to a background check");
{
  const profile = { ...PROFILE, workAuth: { ...PROFILE.workAuth, willingToBackgroundCheck: undefined } };
  const r = await fillAndNext({ section: "questions", profile });
  check("the consent box is not ticked on the applicant's behalf, and is outlined for them",
    r.model.q_1008 === undefined && !r.log.some((l) => /ticked q_1008/.test(l)) && r.outlined.includes("q_1008"),
    JSON.stringify({ q: r.model.q_1008, outlined: r.outlined }));
}

console.log("\nEmployment History: two jobs in the profile, one employer block on the page");
{
  const r = await fillAndNext({ section: "employment" });
  check("Add Employer pressed once, for the second job", r.log.filter((l) => /^added employer/.test(l)).length === 2,
    JSON.stringify(r.log));
  check("first block: the current job, its start, \"I currently work here\" ticked and no end date",
    r.model.employerName_1 === "Globex" && r.model.jobTitle_1 === "Senior SRE" && r.model.startDate_1 === "03/01/2021" &&
    r.model.currentEmployer_1 === true && !r.model.endDate_1,
    JSON.stringify([r.model.employerName_1, r.model.jobTitle_1, r.model.startDate_1, r.model.currentEmployer_1, r.model.endDate_1]));
  check("second block: the earlier job, its start and end",
    r.model.employerName_2 === "Initech" && r.model.jobTitle_2 === "DevOps Engineer" &&
    r.model.startDate_2 === "06/01/2018" && r.model.endDate_2 === "02/01/2021" && !r.model.currentEmployer_2,
    JSON.stringify([r.model.employerName_2, r.model.jobTitle_2, r.model.startDate_2, r.model.endDate_2, r.model.currentEmployer_2]));
  expectClean(r);
}

for (const [popup, sdf] of [[false, {}], [true, {}], [true, { portal: true, labelItems: true, lightBoxes: true }]]) {
  console.log(`\nVoluntary Self-Identification, ${popup ? "from the popup" : "with the page focused"}${sdf.portal ? ", lists drawn at the end of the page" : ""}`);
  const r = await fillAndNext({ section: "eeo", popup, sdf });
  check("Gender: Male", r.model.gender === "M", JSON.stringify(r.model.gender));
  check("Hispanic or Latino: No", r.model.hispanicLatino === "N", JSON.stringify(r.model.hispanicLatino));
  check("Race: Asian", r.model.race === "AS", JSON.stringify(r.model.race));
  check("Veteran Status: not a protected veteran", r.model.veteranStatus === "N", JSON.stringify(r.model.veteranStatus));
  check("Disability (CC-305): the \"No, I do not have a disability\" choice", r.model.disabilityStatus === "N", JSON.stringify(r.model.disabilityStatus));
  check(`CC-305 signature: the applicant's name and today's date (${today})`,
    r.model.selfIdName === "Pradeep Reddy" && r.model.selfIdDate === today, JSON.stringify([r.model.selfIdName, r.model.selfIdDate]));
  expectClean(r);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
