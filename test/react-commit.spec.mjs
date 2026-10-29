/**
 * Filled values are kept by the page, not only shown in the box.
 *
 *   node test/react-commit.spec.mjs
 *
 * Reported on 1.23.0 (1 October 2026):
 *   - Workday: "some name address and other filled fields by extension showing
 *     validation error" — boxes plainly holding the name and address, with
 *     "The field First Name is required and must have a value" under them.
 *   - Ashby (Chainalysis): the Yes / No buttons show the right answers, but
 *     submitting reports a validation error for the Name field.
 *   - Workday's Voluntary Self-Identification of Disability (Form CC-305):
 *     Name and Date left empty.
 *
 * A fill is started from the extension's popup, and while the popup is open
 * the page does not have the focus. Chrome then moves the caret silently:
 * focus() and blur() dispatch no focus, focusin, blur or focusout events, and
 * leaving a box dispatches no change event. React 17 and later hear about a
 * box being left only through focusout. So a box that hands its text to the
 * page's model when it is left never did — Workday's validated boxes work that
 * way — and the page's own check found it empty.
 *
 * The forms here are real React 18 components (the project's own React). Each
 * is filled twice: with the page focused, and as it is while the popup is open.
 * Then the page's own button is pressed and its own check has to pass.
 *
 * From 1.25.0 a Workday date with a calendar button is picked from the
 * calendar; the Self Identify step is also filled with one, both ways.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const require = createRequire(import.meta.url);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

/** A package's own folder, found through its entry point (its exports hide the rest). */
function packageDir(name) {
  let dir = dirname(require.resolve(name));
  while (!dir.endsWith(`node_modules/${name}`) && dir !== dirname(dir)) dir = dirname(dir);
  return dir;
}
const [REACT, REACT_DOM, FORMS] = await Promise.all([
  readFile(join(packageDir("react"), "umd/react.development.js"), "utf8"),
  readFile(join(packageDir("react-dom"), "umd/react-dom.development.js"), "utf8"),
  readFile(join(ROOT, "test/fixtures/react-forms.js"), "utf8"),
]);

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456",
    address: "4685 Old Oaks Dr", city: "Jacksonville", state: "Florida", zip: "32256", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No" },
  eeo: { disabilityStatus: "No, I don't have a disability" },
  experience: [], education: [], documents: [],
};

const WORKDAY = "https://seic.wd1.myworkdayjobs.com/en-US/sei_global_services/job/USA---Chicago/Senior-DevOps-SRE-Engineer_JR123/apply/applyManually";
const ASHBY = "https://jobs.ashbyhq.com/chainalysis-careers/81cc6986-9330-441a-8611-0edd84cea5b1/application";

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function open({ form, url, popup, calendar = false }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
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
  }, { profile: PROFILE });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(url);
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>${form}</title>
    <style>body{font-family:system-ui;padding:20px;max-width:760px}.field,.ashby-application-form-field-entry{margin:0 0 14px;position:relative}
    label{display:block;font-weight:600;margin-bottom:4px}input[type=text],input[type=email]{width:100%;padding:6px;box-sizing:border-box}
    .wd-date{display:inline-flex;gap:2px}.wd-date input{width:3.2em;text-align:center}._active_1v5e2_12{background:#223;color:#fff}.err{color:#b00}</style>
    </head><body><div id="root"></div></body></html>`);
  await page.evaluate(({ form, popup, calendar }) => { window.__FORM = form; window.__POPUP_OPEN = popup; window.__CALENDAR = calendar; }, { form, popup, calendar });
  for (const content of [REACT, REACT_DOM, FORMS]) await page.addScriptTag({ content });
  await page.waitForTimeout(60);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(120);
  return page;
}

/** Fill, let the settle passes run, close the popup (click the page), press the page's button. */
async function fillAndSubmit(page) {
  const res = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(2600);
  const shown = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input[type=text], input[type=email]"))
    .map((i) => [i.id, i.value])));
  await page.evaluate(() => { window.__POPUP_OPEN = false; });
  await page.click("#save");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ model: window.__model, errors: window.__errors }));
  return { res, shown, ...after };
}

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = { month: pad(now.getMonth() + 1), day: pad(now.getDate()), year: String(now.getFullYear()) };

for (const popup of [false, true]) {
  const how = popup ? "with the popup open (the page has no focus)" : "with the page focused";

  console.log(`\nWorkday My Information, ${how}`);
  {
    const page = await open({ form: "workday-info", url: WORKDAY, popup });
    const r = await fillAndSubmit(page);
    const want = {
      "legalName--firstName": "Pradeep", "legalName--lastName": "Reddy",
      "address--addressLine1": "4685 Old Oaks Dr", "address--city": "Jacksonville", "address--postalCode": "32256",
    };
    for (const [id, value] of Object.entries(want)) {
      check(`${id.split("--")[1]}: "${value}" in the box and kept by the page`, r.shown[id] === value && r.model[id] === value,
        JSON.stringify({ shown: r.shown[id], kept: r.model[id] }));
    }
    check("Save and Continue reports nothing missing", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
    await page.close();
  }

  console.log(`\nWorkday Voluntary Self-Identification of Disability, ${how}`);
  {
    const page = await open({ form: "workday-selfid", url: WORKDAY, popup });
    const r = await fillAndSubmit(page);
    check("Name is the applicant's name, kept by the page", r.shown.name === "Pradeep Reddy" && r.model.name === "Pradeep Reddy",
      JSON.stringify({ shown: r.shown.name, kept: r.model.name }));
    check("Employee ID is left blank", !r.shown.employeeId, JSON.stringify(r.shown.employeeId));
    const d = r.model.date || {};
    check(`Date is today, ${today.month}/${today.day}/${today.year}`, d.month === today.month && d.day === today.day && d.year === today.year,
      JSON.stringify(d));
    check("Save and Continue reports nothing missing", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
    await page.close();
  }

  console.log(`\nthe same Self-Identification step, its Date with Workday's calendar, ${how}`);
  {
    const page = await open({ form: "workday-selfid", url: WORKDAY, popup, calendar: true });
    const r = await fillAndSubmit(page);
    const d = r.model.date || {};
    const picked = await page.evaluate(() => ({ picked: window.__pickedFromCalendar ?? null, open: Boolean(document.querySelector('[data-automation-id="datePicker"]')) }));
    check(`Date is today, ${today.month}/${today.day}/${today.year}, picked from the calendar`,
      d.month === today.month && d.day === today.day && d.year === today.year && picked.picked === true, JSON.stringify({ d, ...picked }));
    check("  and the calendar is closed again", !picked.open, JSON.stringify(picked));
    check("Save and Continue reports nothing missing", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
    await page.close();
  }

  console.log(`\nAshby (Chainalysis), ${how}`);
  {
    const page = await open({ form: "ashby", url: ASHBY, popup });
    const r = await fillAndSubmit(page);
    check("Name in the box and kept by the form", r.shown._systemfield_name === "Pradeep Reddy" && r.model._systemfield_name === "Pradeep Reddy",
      JSON.stringify({ shown: r.shown._systemfield_name, kept: r.model._systemfield_name }));
    check("Email kept by the form", r.model._systemfield_email === "pradeepbeeram91@gmail.com", JSON.stringify(r.model._systemfield_email));
    check("the Yes / No answers are the profile's", r.model["q-auth"] === "Yes" && r.model["q-sponsor"] === "No",
      JSON.stringify({ auth: r.model["q-auth"], sponsor: r.model["q-sponsor"] }));
    const pressed = await page.evaluate(() => Array.from(document.querySelectorAll("._yesno_hkyf8_143")).map((row) =>
      row.querySelector("._active_1v5e2_12")?.textContent ?? ""));
    check("  and pressed on screen", pressed.join(",") === "Yes,No", JSON.stringify(pressed));
    check("Submit reports no validation error", Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
    await page.close();
  }
}

console.log("\nthe page is told nothing extra when it has the focus");
{
  const page = await open({ form: "workday-info", url: WORKDAY, popup: false });
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  const blurs = await page.evaluate(() => window.__blurs);
  check("each box is left exactly once (no second blur on top of the browser's)", blurs === 5, `onBlur ran ${blurs} times`);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
