/**
 * Oracle Recruiting Cloud, refreshed Candidate Experience: Personal Info.
 *
 *   node test/oracle-cx-redwood.spec.mjs
 *
 * Reported on 1.24.0 from …fa.us2.oraclecloud.com/hcmUI/CandidateExperience/
 * en/sites/CX/job/34866/apply/section/1/: Phone Number showed only its
 * "Country code +1" with the number box beside it empty, and Address Line 1,
 * ZIP Code and City were empty.
 *
 * Phone Number is one row on this page: the country-code list box and the
 * number box share the row's label. The number box was taken for part of the
 * country-code picker and left alone. Address Line 1 is a list box you type
 * into ("Enter your street name and other address details to see
 * suggestions"); it keeps only an address picked from its suggestions, and the
 * pick fills ZIP Code, City, State and County itself. Typed into, and never
 * picked from, it threw the street away.
 *
 * Now the number goes into its box (the national number: the +1 is already in
 * the country-code box), the street is typed into Address Line 1 and the
 * applicant's own address is picked from the suggestions — with the city and
 * state added when the street alone finds other towns first — and ZIP Code,
 * City, State and County are left for Oracle to fill from that pick. From
 * 1.26.0, whatever Oracle does not fill is chosen from its own list.
 *
 * The page's own Next button is pressed at the end, and its own check has to
 * pass: the number kept, ten digits and no "+", and every address field set.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://ebrm.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/34866/apply/section/1/?jr_id=6abc";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const profileWith = (phone = "516-205-8456", address = "4685 Old Oaks Dr") => ({
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone,
    address, city: "Jacksonville", state: "FL", zip: "32256", country: "United States",
  },
  workAuth: {}, eeo: {}, experience: [], education: [], documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/**
 * The page filled, then left as the applicant leaves it (the popup closed by
 * clicking the page) and Next pressed. `popup`: the fill runs as it does from
 * the extension's popup, with no focus or blur events reaching the page.
 */
async function fillAndNext({ ocx = {}, popup = false, phone, address } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, ocx, popup }) => {
    window.__APPLI_FILL_TEST = true;
    window.__ocx = ocx;
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
  }, { profile: profileWith(phone, address), ocx, popup });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(join(ROOT, "test/fixtures/oracle-cx-redwood.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(2600);
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("h1");
  await page.waitForTimeout(250);
  await page.click("#next");
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    shown: Object.fromEntries(Array.from(document.querySelectorAll("input")).map((i) => [i.name || i.dataset.model || i.id, i.value])),
    model: { ...window.__model }, errors: window.__errors ?? null, log: [...window.__log],
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((e) => e.name || e.dataset.model || e.id),
  }));
  await page.close();
  return { res, ...out };
}

/** The checks every variant of the page has to pass. */
function expectFilled(r, { phoneDigits = "5162058456" } = {}) {
  const kept = String(r.model.phoneNumber ?? "");
  check("Phone Number: the number is in its box and kept by the page",
    kept.replace(/\D+/g, "") === phoneDigits && !kept.includes("+") && r.shown.phoneNumber === kept,
    JSON.stringify({ shown: r.shown.phoneNumber, kept: r.model.phoneNumber }));
  check("  the country code is left as it was (+1), not typed over",
    r.shown.countryCodesDropDownPhoneNumber === "+1" && !r.log.some((l) => l.startsWith("typed countryCodesDropDownPhoneNumber")),
    JSON.stringify({ code: r.shown.countryCodesDropDownPhoneNumber, log: r.log.filter((l) => /countryCodes/.test(l)) }));
  check("Address Line 1: the street typed and the applicant's own address picked from Oracle's suggestions",
    r.model.addressLine1 === "4685 Old Oaks Dr" && r.log.includes("picked addressLine1: 4685 Old Oaks Dr") && r.model.postalCode === "32256",
    JSON.stringify({ line1: r.model.addressLine1, zip: r.model.postalCode, log: r.log.filter((l) => /addressLine1/.test(l)) }));
  check("  ZIP Code, City, State and County filled by Oracle from that pick",
    r.model.postalCode === "32256" && r.model.city === "Jacksonville" && r.model.region2 === "Florida" && r.model.region1 === "Duval",
    JSON.stringify({ zip: r.model.postalCode, city: r.model.city, state: r.model.region2, county: r.model.region1 }));
  const touched = r.log.filter((l) => /^(typed|picked|cleared) (postalCode|city|region1|region2)\b/.test(l));
  check("  and never typed into or picked by Appli-Fill", touched.length === 0, JSON.stringify(touched));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

for (const popup of [false, true]) {
  console.log(`\nPersonal Info, ${popup ? "filled from the popup (the page has no focus)" : "with the page focused"}`);
  const r = await fillAndNext({ popup });
  expectFilled(r);
  check("First Name and Last Name filled", r.shown.firstName === "Pradeep" && r.shown.lastName === "Reddy",
    JSON.stringify([r.shown.firstName, r.shown.lastName]));
}

console.log("\nthe row's Phone Number label belongs to nothing");
expectFilled(await fillAndNext({ ocx: { phoneLabelFor: false } }));

console.log("\nthe number box says nothing about itself (a generated id, no name)");
expectFilled(await fillAndNext({ ocx: { bareNumber: true }, popup: true }));

console.log("\nthe street alone finds the same street in five other towns first");
expectFilled(await fillAndNext({ ocx: { crowded: true } }));

console.log("\nsuggestions slow to arrive (1.5 s)");
expectFilled(await fillAndNext({ ocx: { latency: 1500 } }));

console.log("\nno suggestion is the applicant's address");
{
  const r = await fillAndNext({ address: "77 Quarry Bend Ln" });
  check("no other address is picked: Address Line 1 is outlined for the applicant, not reported as filled",
    !r.model.addressLine1 && r.outlined.includes("addressLine1") && !(r.res.keys ?? []).includes("address"),
    JSON.stringify({ line1: r.model.addressLine1, outlined: r.outlined, keys: r.res.keys }));
  // Reported on 1.25.0: "not filling values for other fields, all fields
  // should be filled". With no address to pick, nothing will fill them, so
  // they are chosen from their own lists (County only where Oracle offers one).
  check("  ZIP Code, City and State are chosen from their own lists all the same",
    r.model.postalCode === "32256" && r.model.city === "Jacksonville" && r.model.region2 === "Florida",
    JSON.stringify({ zip: r.model.postalCode, city: r.model.city, state: r.model.region2, county: r.model.region1, log: r.log }));
  check("  and the phone number is filled all the same", String(r.model.phoneNumber ?? "").replace(/\D+/g, "") === "5162058456",
    JSON.stringify(r.model.phoneNumber));
}

for (const phone of ["+1 516-205-8456", "+15162058456", "1 (516) 205-8456"]) {
  console.log(`\nthe profile's phone saved as "${phone}"`);
  const r = await fillAndNext({ phone });
  const kept = String(r.model.phoneNumber ?? "");
  check("the national number goes in the box, without the country code the +1 box already has",
    kept.replace(/\D+/g, "") === "5162058456" && !kept.includes("+"), JSON.stringify({ shown: r.shown.phoneNumber, kept }));
  check("Next reports nothing missing or invalid", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
