/**
 * Oracle Recruiting Candidate Experience, as Oracle draws it in 2026.
 *
 *   node test/oracle-cx-live.spec.mjs
 *
 * Reported on 1.25.0 from …fa.us2.oraclecloud.com/hcmUI/CandidateExperience/
 * en/sites/CX/job/34866/apply/section/1/ and /section/2/:
 *   - Address Line 1 showed "8451 GATE PKWY W APT 128" typed and never picked,
 *     with ZIP Code, City, State and County empty under "The … field is
 *     required." — "Address is filled but not validated into the fields and
 *     not filling values for other fields".
 *   - On the questions page, the three Yes / No questions (restrictive
 *     covenants, former employee, authorized to work), the race boxes, Gender,
 *     Veteran Self-Identification Status, Sex at Birth and the lists after it
 *     were all left empty; only the salary was filled. Title was not chosen.
 *
 * The page here is drawn from the live markup other fillers read (Jobright's
 * Oracle module, OSApplyTrack #318 — see the fixture's header):
 * Candidate Experience's own list boxes (`input.cx-select-input`, choices as
 * rows of a grid in `#<id>-listbox`, fetched from the server, typed text
 * thrown away when the box is left), Yes / No questions and check boxes
 * drawn at 0 x 0 behind their labels, and Title as pills. 1.25.0 saw none of
 * the radios or boxes, read the typed search text back as the answer of a
 * list, and found no suggestion rows in the address search (they are grid
 * cells, not options).
 *
 * The page's own Next button is pressed at the end; its own check has to pass.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const PAGE = (section) => `https://eklm.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/34866/apply/section/${section}/?jr_id=6abc1dcb92b2612ef0f8d05a`;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456",
    address: "8451 GATE PKWY W APT 128", city: "Jacksonville", state: "FL", zip: "32216", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", previouslyEmployedHere: "No", signedNonCompete: "No" },
  compensation: { desiredSalary: "120000" },
  eeo: { gender: "Male", hispanicLatino: "No", race: "Asian", veteranStatus: "I am not a protected veteran" },
  experience: [], education: [], documents: [],
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/** One section filled (from the popup, with `popup`), the popup closed, and the page's Next pressed. */
async function fillAndNext({ section = 1, cxl = {}, popup = false, profile = PROFILE } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, cxl, popup }) => {
    window.__APPLI_FILL_TEST = true;
    window.__cxl = cxl;
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
  }, { profile, cxl: { section, ...cxl }, popup });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(PAGE(section));
  await page.setContent(await readFile(join(ROOT, "test/fixtures/oracle-cx-live.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(2600);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("h1");
  await page.waitForTimeout(300);
  await page.click("#next");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.name || e.id || e.className),
    drafted: Array.from(document.querySelectorAll(".applifill-drafted")).map((e) => e.name || e.id || e.className),
    openLists: document.querySelectorAll(".cx-select__list").length,
  }));
  await page.close();
  return { res, ...out };
}

const ADDRESS_PARTS = ["postalCode", "city", "region2", "region1"];

/** Section 1, filled: the checks every variant has to pass. */
function expectContact(r, { fromPick = true } = {}) {
  check("Title: Mr., the title that goes with the gender in the profile", r.model.title === "Mr.", JSON.stringify(r.model.title));
  check("Legal First and Last Name", r.model.firstName === "Pradeep" && r.model.lastName === "Reddy", JSON.stringify([r.model.firstName, r.model.lastName]));
  check("Phone Number kept by the page, as ten digits", r.model.phoneNumber === "5162058456", JSON.stringify(r.model.phoneNumber));
  if (fromPick) {
    check("Address Line 1: the applicant's own address picked from Oracle's search (validated, not just typed)",
      r.model.addressLine1 === "8451 Gate Pkwy W" && r.log.includes("picked addressLine1: 8451 Gate Pkwy W"),
      JSON.stringify({ line1: r.model.addressLine1, log: r.log.filter((l) => /addressLine1/.test(l)) }));
  }
  check("  the apartment in Address Line 2", r.model.addressLine2 === "APT 128", JSON.stringify(r.model.addressLine2));
  check("ZIP Code, City, State and County all filled",
    r.model.postalCode === "32216" && r.model.city === "Jacksonville" && r.model.region2 === "Florida" && r.model.region1 === "Duval",
    JSON.stringify(Object.fromEntries(ADDRESS_PARTS.map((k) => [k, r.model[k]]))));
  check("no list left open", r.openLists === 0, `${r.openLists} open`);
}

/** Section 2, filled. */
function expectQuestions(r) {
  const m = r.model;
  check("restrictive covenants: explicit profile No",
    m["300000469539525-22"] === "No" && !r.drafted.includes("300000469539525-22"), JSON.stringify({ answer: m["300000469539525-22"], drafted: r.drafted }));
  check("former employee: No (the profile's)", m["300000469539525-23"] === "No", JSON.stringify(m["300000469539525-23"]));
  check("authorized to work without requiring sponsorship: Yes", m["300000469539525-24"] === "Yes", JSON.stringify(m["300000469539525-24"]));
  check("salary expectations: 120000", m["300000469539525-25"] === "120000", JSON.stringify(m["300000469539525-25"]));
  check("I am Hispanic or Latino.: left unticked (the profile says No)", m["I am Hispanic or Latino."] !== true, JSON.stringify(m["I am Hispanic or Latino."]));
  check("races: Asian ticked, and only Asian",
    m.Asian === true && !["American Indian or Alaska Native", "Black or African American", "Native Hawaiian or other Pacific Islander", "White"].some((k) => m[k] === true),
    JSON.stringify(m));
  check("Gender: Male", m.gender === "Male", JSON.stringify(m.gender));
  check("Veteran Self-Identification Status: I am not a protected veteran", m.veteranStatus === "I am not a protected veteran", JSON.stringify(m.veteranStatus));
  check("  the protected-veteran categories left unticked, and not outlined",
    !["Disabled Veteran", "Active Duty Wartime or Campaign Badge Veterans", "Armed Forces Service Medal Veteran", "Recently Separated Veteran"].some((k) => m[k] === true) &&
    !r.outlined.some((o) => /vetcat/.test(o)), JSON.stringify(r.outlined));
  check("  the discharge date left blank, and not outlined",
    !m.dischargeDay && !m.dischargeMonth && !m.dischargeYear && !r.outlined.some((o) => /discharge/i.test(o)), JSON.stringify(r.outlined));
  check("Sex at Birth and Visually identified Sex at Birth: Male", m.sexAtBirth === "Male" && m.visualSex === "Male", JSON.stringify([m.sexAtBirth, m.visualSex]));
  check("I choose not to disclose my sex: No", m.declineSex === "No", JSON.stringify(m.declineSex));
  check("Visually identified and Regional Ethnicity or Race: Asian", m.visualRace === "Asian" && m.regionalRace === "Asian", JSON.stringify([m.visualRace, m.regionalRace]));
  check("I choose not to disclose my ethnicity or race: No", m.declineRace === "No", JSON.stringify(m.declineRace));
  check("nothing left outlined", r.outlined.length === 0, JSON.stringify(r.outlined));
  check("Next reports nothing missing", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
  check("no list left open", r.openLists === 0, `${r.openLists} open`);
}

for (const popup of [false, true]) {
  console.log(`\nPersonal Info, ${popup ? "filled from the popup (the page has no focus)" : "with the page focused"}`);
  const r = await fillAndNext({ section: 1, popup });
  expectContact(r);
  const touched = r.log.filter((l) => /^(typed|picked) (postalCode|city|region1|region2)\b/.test(l));
  check("  ZIP Code, City, State and County came from the address picked, not typed by Appli-Fill", touched.length === 0, JSON.stringify(touched));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nlists that only the keyboard (or a person's click) moves");
{
  const r = await fillAndNext({ section: 1, cxl: { keysOnly: true } });
  expectContact(r);
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nan address picked, and Oracle fills nothing from it");
{
  const r = await fillAndNext({ section: 1, cxl: { addressFills: false } });
  expectContact(r);
  check("  ZIP Code chosen from its own list first (it brings the City, State and County)",
    r.log.includes("picked postalCode: 32216") && !r.log.some((l) => /^picked (city|region1|region2)\b/.test(l)), JSON.stringify(r.log));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nOracle's search finds no such address");
{
  const r = await fillAndNext({ section: 1, cxl: { noSuggestion: true } });
  check("Address Line 1 is outlined for the applicant, not reported as filled",
    !r.model.addressLine1 && r.outlined.includes("addressLine1") && !(r.res.keys ?? []).includes("address"),
    JSON.stringify({ line1: r.model.addressLine1, outlined: r.outlined }));
  check("  ZIP Code, City, State and County are chosen from their own lists all the same",
    r.model.postalCode === "32216" && r.model.city === "Jacksonville" && r.model.region2 === "Florida" && r.model.region1 === "Duval",
    JSON.stringify(Object.fromEntries(ADDRESS_PARTS.map((k) => [k, r.model[k]]))));
  check("  so Next asks for Address Line 1 alone", JSON.stringify(r.errors) === JSON.stringify(["addressLine1: required"]), JSON.stringify(r.errors));
}

console.log("\nno such address, on a page whose Address Line 1 keeps a typed street");
{
  const r = await fillAndNext({ section: 1, cxl: { noSuggestion: true, freeText: true } });
  expectContact(r, { fromPick: false });
  check("Address Line 1 keeps the street, typed (its apartment in Address Line 2)", r.model.addressLine1 === "8451 GATE PKWY W", JSON.stringify(r.model.addressLine1));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\na slow server (2 s for every list)");
{
  const r = await fillAndNext({ section: 1, cxl: { latency: 2000 } });
  expectContact(r);
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

for (const [how, opts] of [
  ["with the page focused", {}],
  ["filled from the popup (the page has no focus)", { popup: true }],
  ["lists that only the keyboard moves", { cxl: { keysOnly: true } }],
  ["a slow server (1.8 s for every list)", { cxl: { latency: 1800 } }],
]) {
  console.log(`\nApplication Questions and Diversity Information, ${how}`);
  expectQuestions(await fillAndNext({ section: 2, ...opts }));
}

console.log("\nan applicant who declines to self-identify");
{
  const profile = { ...PROFILE, eeo: { declineToSelfIdentify: true } };
  const r = await fillAndNext({ section: 2, profile });
  check("Gender: I do not wish to disclose", r.model.gender === "I do not wish to disclose", JSON.stringify(r.model.gender));
  check("I choose not to disclose my sex / my ethnicity or race: Yes", r.model.declineSex === "Yes" && r.model.declineRace === "Yes",
    JSON.stringify([r.model.declineSex, r.model.declineRace]));
  check("  no race ticked", !r.model.Asian, JSON.stringify(r.model));
}

/**
 * The same address and lists on a site whose lists are Oracle JET's
 * <oj-select-single> (DTCC's): the box hides on a click and a search box of
 * JET's own takes the typing; rows in a layer at the end of the page.
 */
async function fillJet({ jet = {}, popup = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, jet, popup }) => {
    window.__APPLI_FILL_TEST = true;
    window.__jet = jet;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
    if (popup) {
      window.__POPUP_OPEN = true;
      for (const type of ["focus", "blur", "focusin", "focusout"]) {
        window.addEventListener(type, (e) => { if (window.__POPUP_OPEN && e.isTrusted) e.stopImmediatePropagation(); }, true);
      }
    }
  }, { profile: PROFILE, jet, popup });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://dtcc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1/apply/section/1/");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/oracle-cx-jet.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("h1");
  await page.click("#next");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    keys: Object.fromEntries(Array.from(document.querySelectorAll("oj-select-single")).map((h) => [h.id, h.value])),
    open: Array.from(document.querySelectorAll(".oj-listbox-drop-layer")).filter((l) => l.style.display !== "none").length,
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.id),
  }));
  await page.close();
  return { res, ...out };
}

for (const [how, opts] of [
  ["with the page focused", {}],
  ["filled from the popup (the page has no focus)", { popup: true }],
  ["lists that only the keyboard moves", { jet: { keysOnly: true } }],
  ["a slow server (2 s for every list)", { jet: { latency: 2000 } }],
]) {
  console.log(`\nOracle JET's lists (oj-select-single), ${how}`);
  const r = await fillJet(opts);
  check("Address Line 1: the applicant's address picked — the drop-down holds its key",
    r.keys["single-select-2"] === "a1" && r.model.addressLine1 === "8451 Gate Pkwy W, Jacksonville, FL 32216",
    JSON.stringify({ key: r.keys["single-select-2"], shown: r.model.addressLine1, log: r.log.filter((l) => /addressLine1/.test(l)) }));
  check("  the apartment in Address Line 2", r.model.addressLine2 === "APT 128", JSON.stringify(r.model.addressLine2));
  check("ZIP Code, City, State and County filled",
    r.model.postalCode === "32216" && r.model.city === "Jacksonville" && r.model.region2 === "Florida" && r.model.region1 === "Duval",
    JSON.stringify(Object.fromEntries(ADDRESS_PARTS.map((k) => [k, r.model[k]]))));
  check("Gender: Male, and Veteran Status: not a protected veteran",
    r.keys["single-select-7"] === "Male" && r.keys["single-select-8"] === "I am not a protected veteran", JSON.stringify(r.keys));
  check("no list left open, nothing outlined", r.open === 0 && r.outlined.length === 0, JSON.stringify({ open: r.open, outlined: r.outlined }));
  check("Next reports nothing missing", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
