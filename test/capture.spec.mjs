/**
 * Recording answers the applicant gives by hand.
 *
 *   node test/capture.spec.mjs
 *
 * Four ways this used to lose an answer:
 *
 *   1. The capture listeners were attached only at the END of a fill, so
 *      answers typed on a page where Fill was never pressed were never seen.
 *   2. `watchUnmatched` skipped every field a rule had matched
 *      (`if (field.rule) return`), so correcting a notice period or flipping a
 *      work-authorisation answer was never recorded — the stale answer stayed
 *      in the dashboard, which is the "it doesn't update" report.
 *   3. A setter marks a control as ours for 1.5s. Typing over an AI draft
 *      inside that window was treated as our own write and dropped.
 *   4. The stored question was the joined label — "Why are you interested in
 *      this role? | q why" — which is what the Saved Answers tab displayed.
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
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", willingToRelocate: "Yes", noticePeriod: "2 weeks" },
  eeo: {}, experience: [], education: [], documents: [],
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
        const reply = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/capture.html")).href);
for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}
await page.waitForTimeout(300);   // let boot() attach the watchers

const queued = () => page.evaluate(() => window.__queued.map((q) => ({ q: q.question, a: String(q.answer) })));
// The newest answer for a question is the one that counts: the fill queues its
// own answer first, and a correction is queued after it. The background queue
// keeps the last one, so the assertions read the last one too.
const answerFor = (rows, needle) => {
  const matches = rows.filter((r) => r.q.includes(needle));
  return matches.length ? matches[matches.length - 1].a : null;
};

/* --- 1. typed with no fill ever run ------------------------------------- */
await page.click("#q-custom");
await page.type("#q-custom", "I admire the mission");
await page.click("body");
await page.waitForTimeout(150);
const beforeFill = await queued();
check("an answer typed before any fill is recorded", answerFor(beforeFill, "excites you most") === "I admire the mission", JSON.stringify(beforeFill));
check("the question is stored as written, without the machine name", beforeFill.some((r) => r.q === "What excites you most about this opportunity?"), JSON.stringify(beforeFill.map((r) => r.q)));

/* --- 2. now fill, then edit what the profile answered -------------------- */
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(200);
check("the profile answered the notice period", (await page.inputValue("#q-notice")) === "2 weeks");

await page.fill("#q-why", "Because I care about transportation security.");
await page.click("body");
await page.waitForTimeout(150);
check("an unmatched free-text answer is recorded", answerFor(await queued(), "interested in this role") === "Because I care about transportation security.");

// Immediately — inside the 1.5s window a setter holds the control for.
await page.fill("#q-notice", "30 days");
await page.click("body");
await page.waitForTimeout(150);
check(
  "correcting a profile-filled answer is recorded",
  answerFor(await queued(), "notice period") === "30 days",
  JSON.stringify(await queued())
);

await page.waitForTimeout(1600);
await page.selectOption("#q-auth", "No");
await page.waitForTimeout(150);
check(
  "changing a choice the profile answered is recorded",
  answerFor(await queued(), "legally authorized") === "No",
  JSON.stringify(await queued())
);

/* --- 3. changing the same answer again supersedes it -------------------- */
await page.fill("#q-notice", "Immediately");
await page.click("body");
await page.waitForTimeout(150);
const rows = await queued();
const noticeAnswers = rows.filter((r) => r.q.includes("notice period")).map((r) => r.a);
check("a re-edit is queued as the newer answer", noticeAnswers[noticeAnswers.length - 1] === "Immediately", JSON.stringify(noticeAnswers));

/* --- 4. identity fields stay out of the question bank ------------------- */
await page.fill("#f-first", "Madhusudhan");
await page.click("body");
await page.waitForTimeout(150);
const finalRows = await queued();
check("the applicant's name is not stored as a saved answer", !finalRows.some((r) => /first name/i.test(r.q)), JSON.stringify(finalRows.map((r) => r.q)));
check("no answer is queued twice in a row", new Set(finalRows.map((r) => `${r.q}|${r.a}`)).size === finalRows.length, JSON.stringify(finalRows.map((r) => r.q)));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
