/**
 * Repeat sections are only created once one of them has been answered.
 *
 *   node test/greenhouse-rows.spec.mjs
 *
 * Reported on a Greenhouse embed: pressing Fill left the form with block after
 * block of Education, every School / Degree / Discipline reading "Select...".
 *
 * Rows were created up front, from the number of entries in the profile alone,
 * before anything had been written. Greenhouse's newer embed renders those three
 * as comboboxes whose options are fetched remotely, so none of them could be
 * driven — the rows were added, never filled, and left for the applicant to
 * delete one by one. Each empty row also cost another three fruitless dropdown
 * attempts, which is where the time went.
 *
 * Against the original code: 5 blocks from 4 Add clicks, 66s.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com" },
  workAuth: {}, eeo: {}, experience: [],
  education: Array.from({ length: 5 }, (_, i) => ({
    school: `University ${i + 1}`, degree: "Master's Degree", fieldOfStudy: "Computer Science",
  })),
  documents: [],
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
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
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/greenhouse-edu.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(250);

const started = Date.now();
const res = await page.evaluate(async () => await window.__applifill.run({ manual: true }));
const elapsed = Date.now() - started;
await page.waitForTimeout(3000);   // the settle passes, if any, run in here

const after = await page.evaluate(() => ({
  blocks: document.querySelectorAll(".edu-block").length,
  adds: window.__addClicks,
  opened: Array.from(document.querySelectorAll(".sel")).filter((s) => s.getAttribute("aria-expanded") === "true").length,
}));

check("the form keeps the one Education block it came with", after.blocks === 1, `${after.blocks} blocks`);
check("no row is added for a section that can't be answered", after.adds === 0, `${after.adds} Add clicks`);
check("the fields it can answer are still answered", (await page.inputValue("#fn")) === "Madhu" && (await page.inputValue("#ln")) === "Kumar");
check("email is filled", (await page.inputValue("#em")) === "madhu.ittech@gmail.com");
check("the run reports what it filled", (res?.data?.filled ?? 0) >= 3, `filled ${res?.data?.filled}`);

// The original spent 66s here, almost all of it on empty rows it had created.
check("a form of unanswerable pickers doesn't take a minute", elapsed < 30000, `took ${(elapsed / 1000).toFixed(1)}s`);

/* --- an unreadable picker is attempted once, not again by the settle pass --- */
const settleTouched = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".sel")).map((s) => s.__applifillSettleFixes ?? 0)
);
check(
  "a picker that couldn't be read is not re-opened by the settle passes",
  settleTouched.every((n) => n === 0),
  `settle attempts: ${settleTouched.join(", ")}`
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
