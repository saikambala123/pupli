/**
 * Every kind of answer reaches the sync queue, not just typing.
 *
 *   node test/capture-types.spec.mjs
 *
 * Reported: only empty fields and plain typing produced anything to sync;
 * choosing from a dropdown, a radio group, a checkbox group or a custom
 * combobox produced nothing at all.
 *
 * Three causes:
 *   1. Listeners only ever fired for typing. A custom dropdown paints its answer
 *      into a button while the click lands on an option elsewhere in the
 *      document, and a radio group fires on whichever member was clicked rather
 *      than the one the field was anchored to.
 *   2. Whole categories of question were excluded from watching because a
 *      profile rule had matched them (education, work type, EEO, country).
 *   3. A choice was stored under the *option* text — "Referral" — because a
 *      radio's wrapping <label> holds the option, not the question.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", country: "United States" },
  workAuth: {}, eeo: {}, experience: [], education: [], documents: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
      sendMessage(msg, cb) {
        // Capture holds an answer for review before anything is queued for
        // sync, so a spec that listens only for the queue message sees nothing
        // and passes vacuously. Both messages count as "captured" here.
        if (msg?.type === "APPLI_FILL_QUEUE_RESPONSES") window.__queued.push(...(msg.responses || []));
        if (msg?.type === "APPLI_FILL_HOLD_ANSWERS") window.__queued.push(...(msg.items || []));
        const r = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/capture-types.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(400);

await page.fill("#q-text", "The mission");                    await page.click("body"); await page.waitForTimeout(150);
await page.selectOption("#q-select", "Master's Degree");      await page.waitForTimeout(500);
await page.check('input[name="source"][value="Referral"]');   await page.waitForTimeout(500);
await page.check('input[name="shifts"][value="Evenings"]');   await page.waitForTimeout(500);
await page.click("#dl-yes");                                  await page.waitForTimeout(500);
await page.click("#q-combo");
await page.click('#q-combo-menu [role="option"]:nth-child(2)');
await page.click("body");                                     await page.waitForTimeout(600);

const rows = await page.evaluate(() => window.__queued.map((x) => ({ q: x.question, a: String(x.answer), t: x.inputType })));
const find = (needle) => rows.find((r) => r.q.toLowerCase().includes(needle));

check("a typed answer is queued", find("excites")?.a === "The mission", JSON.stringify(rows));
check("a native dropdown answer is queued", find("highest level")?.a === "Master's Degree", JSON.stringify(rows));
check("a radio answer is queued", find("hear about")?.a === "Referral", JSON.stringify(rows));
check("a checkbox answer is queued", find("shifts")?.a === "Evenings", JSON.stringify(rows));
check("a segmented button answer is queued", find("driver")?.a === "Yes", JSON.stringify(rows));
check("a custom combobox answer is queued", find("country")?.a === "India", JSON.stringify(rows));

check(
  "a radio is stored under the question, not the option picked",
  Boolean(find("hear about")) && !rows.some((r) => /^(referral|linkedin|job board)$/i.test(r.q)),
  JSON.stringify(rows.map((r) => r.q))
);
check(
  "a checkbox is stored under the question, not the option picked",
  Boolean(find("shifts")) && !rows.some((r) => /^(mornings|evenings|weekends)$/i.test(r.q)),
  JSON.stringify(rows.map((r) => r.q))
);
check("every queued question appears once", new Set(rows.map((r) => r.q)).size === rows.length, JSON.stringify(rows.map((r) => r.q)));

/* --- re-answering supersedes, and Appli-Fill's own writing is never banked --- */
const before = rows.length;
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(800);
const afterFill = await page.evaluate(() => window.__queued.length);
check("running a fill does not queue Appli-Fill's own answers", afterFill === before, `queue grew from ${before} to ${afterFill}`);

await page.selectOption("#q-select", "Bachelor's Degree");
await page.waitForTimeout(600);
const finalRows = await page.evaluate(() => window.__queued.map((x) => ({ q: x.question, a: String(x.answer) })));
const degrees = finalRows.filter((r) => r.q.toLowerCase().includes("highest level")).map((r) => r.a);
check("re-answering queues the newer answer", degrees[degrees.length - 1] === "Bachelor's Degree", JSON.stringify(degrees));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
