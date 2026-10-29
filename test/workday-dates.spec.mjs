/**
 * Workday's segmented dates, and what reaches the pending list.
 *
 *   node test/workday-dates.spec.mjs
 *
 * Reported with a screenshot of a Workday application: both `From *` and
 * `To *` showing "Error: Invalid Date: /2021" under a box reading `MM/2021`.
 * The year had landed; the month never had.
 *
 * `From *` is not one box. It is two spinbuttons, `MM` and `YYYY`, inside a
 * wrapper, and five separate faults were stacked on it:
 *
 *   1. The month was written as a word. Only a number input or a select of
 *      numbers was counted as numeric, and Workday's segments are text inputs, so
 *      "March" was offered to a two-character box that refused it.
 *   2. `el.maxLength` is -1 when the attribute is absent, which Workday's
 *      segments are. That -1 was taken as the segment's capacity, so every
 *      value was trimmed to its last two characters and 2022 was written "22".
 *   3. `new Date("12")` is 1 December 2001, so a month written on its own could
 *      overwrite the year beside it.
 *   4. A number written at one segment was spread across the whole widget,
 *      blanking its neighbour.
 *   5. The row indexer used the date parts as its row anchors when no Company
 *      repeated, read one job's four date boxes as four jobs, and left `To`
 *      blank because the profile has no fourth job.
 *
 * The second half covers the pending list: an edit to a repeated row used to
 * collide with the identical label in the row above it, so one of two
 * corrections silently disappeared before the applicant ever saw it.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com", city: "Stanley" },
  websites: {}, workAuth: {}, eeo: {},
  experience: [
    { title: "Senior DevOps Engineer", company: "Northern Trust", location: "Chicago, IL",
      startDate: "2022-03", endDate: "2025-01", current: false, description: "Ran the platform." },
    { title: "DevOps Engineer", company: "One Trust LLC", location: "Austin, TX",
      startDate: "2021-06", endDate: "2022-02", current: false, description: "Managed Azure." },
    { title: "Data Engineer", company: "Lenora Systems Inc", location: "Hyderabad, India",
      startDate: "2017-01", endDate: "2018-06", current: false, description: "Built dashboards." },
  ],
  education: [],
  documents: [{ kind: "resume", name: "cv.pdf", isDefault: true, dataUrl: "data:application/pdf;base64,JVBERi0=" }],
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));
await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  window.__held = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = { runtime: { lastError: null,
    sendMessage(msg, cb) {
      if (msg?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(msg.items || []));
      const r = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
        : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/workday-dates.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(250);
await page.evaluate(async () => await window.__applifill.run({ manual: true }));
await page.waitForTimeout(1200);

const v = (id) => page.inputValue("#" + id);

console.log("\nboth halves of every date are written");
check("row 1 start month", (await v("w1f-m")) === "03", `= "${await v("w1f-m")}"`);
check("row 1 start year", (await v("w1f-y")) === "2022", `= "${await v("w1f-y")}"`);
check("row 1 end month", (await v("w1to-m")) === "01", `= "${await v("w1to-m")}"`);
check("row 1 end year", (await v("w1to-y")) === "2025", `= "${await v("w1to-y")}"`);

console.log("\nthe second row is the second job, and To is not a copy of From");
check("row 2 start month", (await v("w2f-m")) === "06", `= "${await v("w2f-m")}"`);
check("row 2 start year", (await v("w2f-y")) === "2021", `= "${await v("w2f-y")}"`);
check("row 2 end month", (await v("w2to-m")) === "02", `= "${await v("w2to-m")}"`);
check("row 2 end year", (await v("w2to-y")) === "2022", `= "${await v("w2to-y")}"`);
check("From and To are different dates", (await v("w2f-y")) !== (await v("w2to-y")));

console.log("\nthe year is not trimmed to two digits");
for (const id of ["w1f-y", "w1to-y", "w2f-y", "w2to-y"]) {
  check(`${id} holds four digits`, /^\d{4}$/.test(await v(id)), `= "${await v(id)}"`);
}

console.log("\nthe page raises no date error of its own");
const errors = await page.evaluate(() => {
  window.__validate();
  return [...document.querySelectorAll(".err")].map((n) => n.textContent).filter(Boolean);
});
check("no 'Invalid Date' anywhere on the form", errors.length === 0, errors.join(" | "));

/* ================================================================== */
/*  Pending answers: an edit in one row cannot displace another        */
/* ================================================================== */

console.log("\nan edit to each row is held separately");
await page.evaluate(() => { window.__held.length = 0; });

async function retype(sel, text) {
  await page.click(sel);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 12 });
  await page.click("h2");
  await page.waitForTimeout(450);
}

await retype("#w1c", "Acme Corporation");
await retype("#w2c", "Globex Limited");

const held = await page.evaluate(() => window.__held.map((x) => ({ q: x.question, a: String(x.answer) })));
const questions = held.map((h) => h.q);

check("both edits were held", held.length === 2, JSON.stringify(held));
check("under two different questions", new Set(questions).size === 2, JSON.stringify(questions));
check("each question names its row", questions.every((q) => /work experience [12]/i.test(q)), JSON.stringify(questions));
check(
  "the answers stayed with their own row",
  held.some((h) => /work experience 1/i.test(h.q) && h.a === "Acme Corporation") &&
  held.some((h) => /work experience 2/i.test(h.q) && h.a === "Globex Limited"),
  JSON.stringify(held)
);

console.log("\nediting a date segment is held rather than dropped");
await page.evaluate(() => { window.__held.length = 0; });
await retype("#w1to-m", "04");
const dateHeld = await page.evaluate(() => window.__held.map((x) => ({ q: x.question, a: String(x.answer) })));
check("the month edit reached the list", dateHeld.length === 1 && dateHeld[0].a === "04", JSON.stringify(dateHeld));
check(
  "a two-letter label still produced a usable question",
  Boolean(dateHeld[0]?.q && dateHeld[0].q.length >= 5),
  JSON.stringify(dateHeld)
);

/* ================================================================== */
/*  A widget that only believes keystrokes                             */
/* ================================================================== */

/**
 * Work Experience 3's segments keep their own buffer and fill it only from
 * `keydown`. Reported as: `From` reading 01/2017 while Save and Continue said
 * "The field From is required and must have a value." The box had the date; the
 * buffer Workday validates against was empty, because the fill assigned the
 * value and sent key events carrying no key.
 */
console.log("\na widget that fills its buffer from keystrokes");
{
  const display = {
    from: `${await v("w3f-m")}/${await v("w3f-y")}`,
    to: `${await v("w3to-m")}/${await v("w3to-y")}`,
  };
  const buffers = await page.evaluate(() => ({ ...window.__buffers }));
  const errors = await page.evaluate(() => {
    window.__validateStrict();
    return ["w3f-err", "w3to-err"].map((id) => document.getElementById(id).textContent).filter(Boolean);
  });

  check("the boxes show the dates", display.from === "01/2017" && display.to === "06/2018", JSON.stringify(display));
  check(
    "and the widget's own buffer holds them too",
    buffers["w3f-m"] === "01" && buffers["w3f-y"] === "2017" &&
    buffers["w3to-m"] === "06" && buffers["w3to-y"] === "2018",
    JSON.stringify(buffers)
  );
  check("so Save and Continue raises no required-field error", errors.length === 0, errors.join(" | "));
}

/* ================================================================== */
/*  Uploads are left alone                                             */
/* ================================================================== */

console.log("\nthe application-documents upload");
{
  const upload = await page.evaluate(() => ({
    files: document.getElementById("resume-file").files?.length ?? 0,
    marked: [...document.querySelectorAll(".applifill-needs-you")]
      .map((n) => n.id || n.getAttribute("data-automation-id") || n.tagName),
  }));
  check("no document is attached by the fill", upload.files === 0, `${upload.files} file(s) attached`);
  check(
    "and the upload is not flagged as needing an answer",
    !upload.marked.some((id) => /resume-file|fileUpload|select-files/i.test(id)),
    JSON.stringify(upload.marked)
  );
}

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
