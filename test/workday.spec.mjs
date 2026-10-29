/**
 * Workday-style forms: repeat rows, phone parts, source questions and dates.
 *
 *   node test/workday.spec.mjs
 *
 * Covers four reports:
 *   - the phone extension box was being filled with the email address;
 *   - clicking Fill opened section after section of Education;
 *   - "How did you hear about us?" answered with a generic category when a
 *     closer one was on offer;
 *   - "Today's Date" and "Signature Date" were never filled at all.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

// Nine education entries — a resume parser can easily produce this — so the
// row-adding pass has every opportunity to run away.
const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar",
    email: "madhu.ittech@gmail.com", phone: "+1 630 555 0142",
    city: "Stanley", country: "United States",
  },
  workAuth: { howDidYouHear: "LinkedIn" },
  eeo: {},
  education: Array.from({ length: 9 }, (_, i) => ({
    school: i === 0 ? "Northern Illinois University" : `Institution ${i + 1}`,
    degree: "Master's Degree", fieldOfStudy: "Computer Science",
  })),
  experience: [], documents: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  window.__queued = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(m, cb) {
        if (m?.type === "APPLI_FILL_QUEUE_RESPONSES") window.__queued.push(...(m.responses || []));
        // An edit is held for review before anything syncs, so a spec
        // watching only the sync message sees nothing and fails.
        if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__queued.push(...(m.items || []));
        const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/workday.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(300);
await page.evaluate(async () => await window.__applifill.run({ manual: true }));
await page.waitForTimeout(1400);

const out = await page.evaluate(() => ({
  queued: window.__queued.map((q) => ({ q: q.question, a: String(q.answer) })),
  // Was this dropdown even visible to the engine? Workday renders most of its
  // selects exactly like this one.
  locCollected: window.__applifill
    .collectFields(window.APPLI_FILL_ATS.detect())
    .some((f) => f.el.id === "loc"),
  addCollected: window.__applifill
    .collectFields(window.APPLI_FILL_ATS.detect())
    .some((f) => f.el.id === "add-edu"),
  addClicks: window.__addClicks,
  eduSections: document.querySelectorAll("[data-automation-id^='education-']").length,
  email: document.getElementById("em").value,
  phone: document.getElementById("ph").value,
  phoneCode: document.getElementById("cc").value,
  ext: document.getElementById("ext").value,
  hdyh: document.getElementById("hdyh").textContent.trim(),
  today: document.getElementById("today").value,
  sigdate: document.getElementById("sigdate").value,
}));

const now = new Date();
const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const us = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;

/* --- the email belongs in the email box and nowhere else --- */
check("email is filled", out.email === "madhu.ittech@gmail.com", `got "${out.email}"`);
check("the calling code is filled separately", out.phoneCode === "+1", `got "${out.phoneCode}"`);
check("the phone field contains the national number", out.phone === "6305550142", `got "${out.phone}"`);
check("the phone extension never receives the email address", out.ext !== out.email, `extension = "${out.ext}"`);
check("the phone extension is left alone when the profile has none", out.ext === "", `extension = "${out.ext}"`);

/* --- repeat rows stay under control --- */
check("education rows do not run away", out.eduSections <= 4, `${out.eduSections} sections, ${out.addClicks} Add clicks`);
check("Add is clicked at most three times", (out.addClicks ?? 0) <= 3, `${out.addClicks} clicks`);

/* --- the source question picks the closest category --- */
check("how-did-you-hear is answered", out.hdyh !== "Select One" && out.hdyh.length > 0, `got "${out.hdyh}"`);
check(
  "LinkedIn is selected when LinkedIn is an offered option",
  out.hdyh === "LinkedIn",
  `got "${out.hdyh}" — LinkedIn must beat generic categories whenever it is present`
);

/* --- today's date --- */
check("a text date field gets today in MM/DD/YYYY", out.today === us, `got "${out.today}", expected ${us}`);
check("a native date input gets today in ISO", out.sigdate === iso, `got "${out.sigdate}", expected ${iso}`);

/* --- a Workday select is a <button> with only aria-expanded --- */
check(
  "a dropdown carrying only aria-expanded is seen by the fill",
  out.locCollected === true,
  "Workday renders most of its selects as a <button> with nothing but aria-expanded"
);
check(
  "an \"Add\" control is still not treated as a dropdown",
  out.addCollected === false,
  "clicking it is what opened section after section of Education"
);

/* --- only an answer a person gave is offered for saving --- */
/**
 * This block asserted the opposite: that everything answered was offered for
 * saving, whoever answered it. That is the behaviour the hold model exists to
 * stop. A fill wrote "Social Media" into "How did you hear about us?" from the
 * profile, offered it straight back as though the applicant had chosen it, and
 * the unsaved list filled with the whole form on every click of Fill — so the
 * one entry that really was theirs was buried among twenty that were not.
 */
const q = (needle) => out.queued.filter((r) => r.q.toLowerCase().includes(needle)).pop();
check(
  "the fill's own dropdown answer is not offered as the applicant's",
  !q("hear about"),
  JSON.stringify(out.queued.map((r) => r.q))
);
check("identity fields are still not queued", !q("first name") && !q("email"), JSON.stringify(out.queued.map((r) => r.q)));
check(
  "identity fields are not queued as saved answers",
  !out.queued.some((r) => /email|phone number/i.test(r.q)),
  JSON.stringify(out.queued.map((r) => r.q))
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
