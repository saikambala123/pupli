/**
 * Workday's Voluntary Disclosures and Self Identify (CC-305) steps.
 *
 *   node test/workday-selfid.spec.mjs
 *
 * Reported: "in Workday applications self identity fields are not filling —
 * they should fill correct values, including the present (MM/DD/YYYY) date."
 *
 * Three things stopped it:
 *   - the step has no heading that names the form (it is titled "Self
 *     Identify"; "Voluntary Self-Identification of Disability · Form CC-305"
 *     is rich text above the fields), so the self-ID rules never applied;
 *   - "Date" is three boxes labelled only Month, Day and Year, with "Date"
 *     attached to the widget or to the month box alone, so no box read "Date";
 *   - the disability boxes carry generated ids and no shared `name`, so each
 *     was treated as a lone "I agree" box and "No, I don't have a disability"
 *     — neither yes nor no — ticked nothing.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const profileWith = (eeo) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "p@example.com", city: "Jacksonville", state: "Florida", country: "United States" },
  workAuth: {}, eeo, experience: [], education: [], documents: [],
});
const EEO = {
  gender: "Male", race: "Asian", hispanicLatino: "No",
  veteranStatus: "I am not a protected veteran", disabilityStatus: "No, I don't have a disability",
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/**
 * `prepare` runs in the page before the extension loads, so a variant of a
 * fixture can be made without another file.
 */
async function openFixture(file, profile, prepare) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
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
  }, { profile });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://gdit.wd5.myworkdayjobs.com/en-US/External_Career_Site/job/Reston-VA/DevOps-Engineer_RQ1/apply/applyManually");
  await page.setContent(await readFile(join(ROOT, "test/fixtures", file), "utf8"));
  if (prepare) await page.evaluate(prepare);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  return page;
}

const fill = async (page) => {
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data);
  // Past both settle passes, so anything that would leak into Pending has.
  await page.waitForTimeout(2600);
  return res;
};

const today = (page) => page.evaluate(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
});

/* Readers for the GUID-id fixture (native checkboxes in a fieldset). */
const G = "3a1f9c5e0d6b10001b2c3d4e5f6000";
const readGuid = (page) => page.evaluate((G) => ({
  ethnicity: document.getElementById("personalInfoUS--ethnicity")?.textContent.trim() ?? null,
  gender: document.getElementById("personalInfoUS--gender")?.textContent.trim() ?? null,
  veteran: document.getElementById("personalInfoUS--veteranStatus")?.textContent.trim() ?? null,
  name: document.getElementById(`${G}01`).value,
  employeeId: document.getElementById(`${G}02`).value,
  date: ["m", "d", "y"].map((s) => document.getElementById(`${G}03-${s}`).value).join("/"),
  boxes: Array.from(document.querySelectorAll("fieldset input[type=checkbox]")).map((b) => b.checked),
  earlier: document.getElementById("earlier-date")?.value ?? null,
  held: window.__held.map((h) => ({ q: h.question, a: String(h.answer) })),
}), G);

/* Readers for the standalone step (role="checkbox" boxes). */
const readStep = (page) => page.evaluate(() => ({
  name: document.getElementById("selfIdentifiedDisabilityData--name").value,
  employeeId: document.getElementById("selfIdentifiedDisabilityData--employeeId").value,
  date: ["Month", "Day", "Year"].map((s) =>
    document.getElementById(`selfIdentifiedDisabilityData--dateSignedOn-dateSection${s}-input`).value).join("/"),
  boxes: Array.from(document.querySelectorAll("[role=checkbox]")).map((b) => b.getAttribute("aria-checked") === "true"),
  held: window.__held.map((h) => ({ q: h.question, a: String(h.answer) })),
}));

/* ------------------------------------------------------------------ */
console.log("\nVoluntary Disclosures and Self Identify on one page (generated ids)");
{
  const page = await openFixture("workday-selfid.html", profileWith(EEO));
  await fill(page);
  const s = await readGuid(page);
  check("race/ethnicity", s.ethnicity === "Asian (Not Hispanic or Latino) (United States of America)", s.ethnicity);
  check("gender", s.gender === "Male", s.gender);
  check("veteran status", s.veteran === "I am not a veteran", s.veteran);
  check("Name is the applicant's name", s.name === "Pradeep Reddy", s.name);
  check("Employee ID is left blank", s.employeeId === "", s.employeeId);
  check("Date is today, MM/DD/YYYY", s.date === await today(page), `${s.date} vs ${await today(page)}`);
  check("the \"No\" disability box is ticked, and only it", JSON.stringify(s.boxes) === "[false,true,false]", JSON.stringify(s.boxes));
  check("nothing Appli-Fill filled is pending", s.held.length === 0, JSON.stringify(s.held));

  console.log("\n  …and a change made by hand is");
  await page.click("label[for='64cbff5f364f10000aeec521b4ec0002']");
  await page.waitForTimeout(600);
  const after = await readGuid(page);
  check("the applicant's choice is held", after.held.some((h) => /check one of the boxes|disabilit/i.test(h.q) && /do not want to answer/i.test(h.a)),
    JSON.stringify(after.held));
  check("  and nothing else", after.held.length === 1, JSON.stringify(after.held));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nthe Self Identify step alone (generated ids, no heading naming the form)");
{
  // Only the Self Identify half of the page, plus an unrelated "Date" that
  // sits above the CC-305 text and must not be given today's date.
  const selfIdOnly = () => {
    document.querySelectorAll("[data-fkit-id^='personalInfoUS']").forEach((n) => n.remove());
    const [h2] = document.querySelectorAll("h2");
    h2.nextElementSibling.remove();          // the disclosures rich text
    h2.remove();
    document.querySelector("[data-automation-id='progressBarActiveStep'] div").textContent = "Self Identify";
    const earlier = document.createElement("div");
    earlier.setAttribute("data-fkit-id", "earlier");
    earlier.innerHTML = '<label for="earlier-date">Date</label><input type="text" id="earlier-date">';
    document.querySelector("[data-automation-id='applyFlowPage']").prepend(earlier);
  };
  const page = await openFixture("workday-selfid.html", profileWith(EEO), selfIdOnly);
  const fields = await page.evaluate(() =>
    window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map((f) => `${f.el.id}=${f.rule?.key ?? "-"}`));
  await fill(page);
  const s = await readGuid(page);
  check("Name is the applicant's name", s.name === "Pradeep Reddy", `${s.name} ${JSON.stringify(fields)}`);
  check("Employee ID is left blank", s.employeeId === "", s.employeeId);
  check("Date is today, MM/DD/YYYY", s.date === await today(page), `${s.date} ${JSON.stringify(fields)}`);
  check("the \"No\" disability box is ticked", JSON.stringify(s.boxes) === "[false,true,false]", JSON.stringify(s.boxes));
  check("a \"Date\" above the form is not given today's date", s.earlier === "", `= ${JSON.stringify(s.earlier)}`);
  check("nothing Appli-Fill filled is pending", s.held.length === 0, JSON.stringify(s.held));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\na current tenant's Self Identify step (selfIdentifiedDisabilityData ids, role=checkbox)");
{
  const page = await openFixture("workday-selfid-step.html", profileWith(EEO));
  await fill(page);
  const s = await readStep(page);
  check("Name is the applicant's name", s.name === "Pradeep Reddy", s.name);
  check("Employee ID is left blank", s.employeeId === "", s.employeeId);
  check("Date is today, MM/DD/YYYY", s.date === await today(page), `${s.date} vs ${await today(page)}`);
  check("the \"No\" disability box is ticked, and only it", JSON.stringify(s.boxes) === "[false,true,false]", JSON.stringify(s.boxes));
  check("nothing Appli-Fill filled is pending", s.held.length === 0, JSON.stringify(s.held));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nethnicity drawn as a list of boxes (Voluntary Disclosures)");
{
  const ethnicityBoxes = () => {
    const opts = [
      "American Indian or Alaska Native (United States of America)", "Asian (United States of America)",
      "Black or African American (United States of America)", "Hispanic or Latino (United States of America)",
      "Native Hawaiian or Other Pacific Islander (United States of America)", "White (United States of America)",
      "I do not wish to answer. (United States of America)",
    ];
    document.querySelector("[data-automation-id='applyFlowPage']").innerHTML =
      "<h2>Voluntary Disclosures</h2><div data-automation-id='formField-ethnicityMulti'><fieldset><legend><label>" +
      "Please select the ethnicity (or ethnicities) which most accurately describe(s) how you identify yourself.*</label></legend>" +
      opts.map((o, i) => `<div><input type="checkbox" id="64cb${i}aa00000000000000000000${i}"><label for="64cb${i}aa00000000000000000000${i}">${o}</label></div>`).join("") +
      "</fieldset></div>";
  };
  const page = await openFixture("workday-selfid.html", profileWith(EEO), ethnicityBoxes);
  await fill(page);
  const ticked = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=checkbox]"))
    .filter((b) => b.checked).map((b) => b.nextElementSibling.textContent));
  check("only the applicant's ethnicity is ticked", JSON.stringify(ticked) === JSON.stringify(["Asian (United States of America)"]), JSON.stringify(ticked));
  check("nothing Appli-Fill filled is pending", (await page.evaluate(() => window.__held.length)) === 0);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nhowever the profile words the disability answer");
const CASES = [
  ["No", "[false,true,false]"],
  ["Yes, I have a disability", "[true,false,false]"],
  ["Yes", "[true,false,false]"],
  ["I don't wish to answer", "[false,false,true]"],
  ["", "[false,false,false]"],
];
for (const [answer, want] of CASES) {
  for (const file of ["workday-selfid.html", "workday-selfid-step.html"]) {
    const page = await openFixture(file, profileWith({ ...EEO, disabilityStatus: answer }));
    await page.evaluate(async () => { await window.__applifill.run({ manual: true }); });
    await page.waitForTimeout(300);
    const s = file === "workday-selfid.html" ? await readGuid(page) : await readStep(page);
    check(`${JSON.stringify(answer)} → ${want} (${file.includes("step") ? "role=checkbox" : "native boxes"})`,
      JSON.stringify(s.boxes) === want, JSON.stringify(s.boxes));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
