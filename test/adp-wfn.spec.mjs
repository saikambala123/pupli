/**
 * ADP Workforce Now (workforcenow.adp.com): the Career Center application.
 *
 *   node test/adp-wfn.spec.mjs
 *
 * Reported on 1.25.0: "adp application also should fill using my portal and
 * extension correctly". Workforce Now's application is mostly ordinary boxes
 * and react-select lists, but its questions are ADP's SDF radio groups
 * (`sdf-radio-group` / `sdf-radio-button[label]`), which were never answered —
 * the radio inside each button sits in that button's shadow root — and its
 * Address Line 1 is a Google Places box that newer Maps builds mark as a
 * combobox, which no rule took for the street (the "Enter a location"
 * placeholder made it the applicant's city instead).
 *
 * The page here is drawn from the markup other fillers read off the live site
 * (see test/fixtures/adp-wfn.html). The page's own Next is pressed at the end
 * and its own check has to pass.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=4f8b9ec0-f968-42cd-9774-88eb269c652e&ccId=19000101_000001&jobId=606158&lang=en_US";

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
    howDidYouHear: "LinkedIn", availableStartDate: "Immediately",
  },
  compensation: { desiredSalary: "120000" },
  eeo: { gender: "Male", hispanicLatino: "No", race: "Asian", veteranStatus: "I am not a protected veteran" },
  experience: [], education: [], documents: [],
};

const [KIT, PAGE] = await Promise.all([
  readFile(join(ROOT, "test/fixtures/adp-sdf-kit.js"), "utf8"),
  readFile(join(ROOT, "test/fixtures/adp-wfn.html"), "utf8"),
]);
const HTML = PAGE.replace("<!--SDF-KIT-->", `<script>${KIT}</script>`);

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/** One step filled (from the popup, with `popup`), the popup closed, and the page's Next pressed. */
async function fillAndNext({ step = "personal", wfn = {}, popup = false, profile = PROFILE } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, wfn, popup }) => {
    window.__APPLI_FILL_TEST = true;
    window.__wfn = wfn;
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
  }, { profile, wfn: { step, ...wfn }, popup });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: HTML }));
  await page.goto(URL);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("h1");
  await page.waitForTimeout(300);
  await page.click("#ja_sv_cw_next_footer_btn");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.id || e.tagName.toLowerCase()),
    boxes: Object.fromEntries(Array.from(document.querySelectorAll("input.vdl-textbox")).map((i) => [i.id, i.value])),
    phoneCountry: document.getElementById("phoneCountry")?.value ?? null,
    ticked: Array.from(document.querySelectorAll("input[type=checkbox]")).filter((c) => c.checked).map((c) => c.name),
    openLists: document.querySelectorAll(".MDFSelectBox__menu, .pac-container").length,
  }));
  await page.close();
  return { res, ...out };
}

const today = (() => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
})();

function expectClean(r) {
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
  check("  and no list or suggestion box is left open", r.openLists === 0, JSON.stringify(r.openLists));
}

function expectPersonal(r, { picked = true } = {}) {
  check("First Name, Last Name and Email", r.model.firstName === "Pradeep" && r.model.lastName === "Reddy" && r.model.email === "pradeepbeeram91@gmail.com",
    JSON.stringify([r.model.firstName, r.model.lastName, r.model.email]));
  check("Mobile Number: ten digits in the number box, the country left at United States (+1)",
    String(r.model.mobilePhone ?? "").replace(/\D+/g, "") === "5162058456" && r.phoneCountry === "US",
    JSON.stringify({ phone: r.model.mobilePhone, country: r.phoneCountry }));
  check("Country: United States, picked from its list", r.model.country === "United States", JSON.stringify(r.model.country));
  if (picked) {
    check("Address Line 1: the applicant's own address picked from Google's suggestions",
      r.model.addressLine1 === "8451 Gate Parkway West" && r.log.some((l) => /^picked addressLine1: 8451 Gate Parkway West, Jacksonville$/.test(l)),
      JSON.stringify({ line1: r.model.addressLine1, log: r.log }));
    check("  the apartment it dropped in Address Line 2", r.model.addressLine2 === "Apt 128", JSON.stringify(r.model.addressLine2));
  } else {
    check("Address Line 1: no suggestion is the applicant's, so the street stays as typed",
      r.model.addressLine1 === "8451 Gate Pkwy W Apt 128" && r.boxes.addressLine1 === "8451 Gate Pkwy W Apt 128" && !r.outlined.includes("addressLine1"),
      JSON.stringify({ line1: r.model.addressLine1, box: r.boxes.addressLine1, outlined: r.outlined }));
  }
  check("City, State and Postal Code", r.model.city === "Jacksonville" && r.model.state === "Florida" && r.model.postalCode === "32216",
    JSON.stringify([r.model.city, r.model.state, r.model.postalCode]));
  check("\"I have a preferred or chosen name\" left clear (the profile has none) and not outlined",
    !r.ticked.includes("usePreferredName") && !r.outlined.includes("usePreferredName-input"), JSON.stringify({ ticked: r.ticked, outlined: r.outlined }));
  check("the text-message consent is never ticked for the applicant", !r.ticked.includes("consentCheckBox"), JSON.stringify(r.ticked));
  expectClean(r);
}

console.log("\nPersonal information, with the page focused");
expectPersonal(await fillAndNext());

console.log("\nPersonal information, filled from the popup (the page has no focus)");
expectPersonal(await fillAndNext({ popup: true }));

console.log("\nPersonal information: Address Line 1 marked as a combobox (newer Maps builds)");
expectPersonal(await fillAndNext({ wfn: { pacAria: true }, popup: true }));

console.log("\nPersonal information: Google's suggestions arrive 1.2 s after typing");
expectPersonal(await fillAndNext({ wfn: { latency: 1200 } }));

console.log("\nPersonal information: no suggestion is the applicant's address");
expectPersonal(await fillAndNext({ wfn: { noPlace: true } }), { picked: false });

console.log("\nPersonal information: no suggestion, and the box marked as a combobox");
{
  const r = await fillAndNext({ wfn: { noPlace: true, pacAria: true } });
  expectPersonal(r, { picked: false });
  check("  never retyped with the city and state added", !/Jacksonville/.test(r.boxes.addressLine1 ?? ""), JSON.stringify(r.boxes.addressLine1));
}

for (const popup of [false, true]) {
  console.log(`\nQuestions, ${popup ? "from the popup" : "with the page focused"}`);
  const r = await fillAndNext({ step: "questions", popup });
  check("At least 18: Yes", r.model.q1 === "Y", JSON.stringify(r.model.q1));
  check("Authorized to work: Yes", r.model.q2 === "Y", JSON.stringify(r.model.q2));
  check("Sponsorship: No", r.model.q3 === "N", JSON.stringify(r.model.q3));
  check("How did you hear: LinkedIn, picked from its list", r.model.q4 === "LinkedIn", JSON.stringify(r.model.q4));
  check("Worked for Acme Corporation before: No", r.model.q5 === "N", JSON.stringify(r.model.q5));
  check(`Available Start Date: today (${today})`, r.model.q6 === today, JSON.stringify(r.model.q6));
  check("Desired salary: 120000, counted Annually", r.model.desiredSalary === "120000" && r.model.salaryFrequency === "A",
    JSON.stringify([r.model.desiredSalary, r.model.salaryFrequency]));
  expectClean(r);
}

for (const popup of [false, true]) {
  console.log(`\nVoluntary self-identification, ${popup ? "from the popup" : "with the page focused"}`);
  const r = await fillAndNext({ step: "vsid", popup });
  check("Gender: Male", r.model.gender === "Male", JSON.stringify(r.model.gender));
  check("Ethnicity: Not Hispanic or Latino", r.model.ethnicity === "Not Hispanic or Latino", JSON.stringify(r.model.ethnicity));
  check("Race (open only once Ethnicity is answered): Asian", r.model.race === "Asian (Not Hispanic or Latino)", JSON.stringify(r.model.race));
  check("Protected Veteran Status: not a protected veteran", r.model.veteran === "N", JSON.stringify(r.model.veteran));
  expectClean(r);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
