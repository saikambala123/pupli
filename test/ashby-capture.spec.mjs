/**
 * Capturing answers on an Ashby-shaped form.
 *
 *   node test/ashby-capture.spec.mjs
 *
 * The reported failures, all from one Superhuman/Ashby application:
 *
 *   1. A ticked checkbox group was banked under the humanized uuid of its
 *      `name` attribute — "edb 0c17 447a b4c5 8a5afa5ba1a9 gh quest labeled
 *      checkbox 2" — instead of the question printed above it.
 *   2. A group whose options each carry their own `name` was banked under
 *      "i prefer to self describe", an option label that the exact-match
 *      options test missed because humanize() had dropped its hyphen.
 *   3. An answer written by the AI, never touched by the applicant, was
 *      offered in the unsaved list.
 *   4. A question banked under a machine name never matched the same question
 *      on the next form, so it was asked again after syncing.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com", country: "United States" },
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  window.__held = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(msg.items || []));
        const reply = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/ashby-demographics.html")).href);
for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}
await page.waitForTimeout(400);

const held = () => page.evaluate(() =>
  window.__held.map((h) => ({ q: h.question, a: String(h.answer), t: h.inputType, n: (h.options || []).length }))
);
const latest = async (match) => (await held()).filter((h) => match.test(h.a)).pop();

/* ---- 1. ethnicity checkboxes: uuid name must not become the question ---- */
await page.click('input[value="South Asian"]');
await page.waitForTimeout(600);

const ethnicity = await latest(/South Asian/);
check(
  "a ticked checkbox is captured at all",
  Boolean(ethnicity),
  `held = ${JSON.stringify(await held())}`
);
check(
  "the ethnicity group is saved under its printed question",
  ethnicity?.q === "How would you describe your racial/ethnic background? (mark all that apply)",
  `q = ${JSON.stringify(ethnicity?.q)}`
);
check(
  "no uuid fragment reaches the question text",
  !/\b[0-9a-f]{4,}\b/i.test(ethnicity?.q || "") && !/gh quest|checkbox \d/i.test(ethnicity?.q || ""),
  `q = ${JSON.stringify(ethnicity?.q)}`
);
check(
  "the group's other choices are kept beside the answer",
  (ethnicity?.n ?? 0) >= 10,
  `options = ${ethnicity?.n}`
);
check("the ethnicity answer is typed as a checkbox", ethnicity?.t === "checkbox", `t = ${ethnicity?.t}`);

/* ---- 2. per-option names: the option label must not become the question ---- */
await page.click('input[value="Man"]');
await page.waitForTimeout(600);
const gender = await latest(/Man/);
check(
  "the gender group is saved under its printed question",
  gender?.q === "How would you describe your gender identity? (mark all that apply)",
  `q = ${JSON.stringify(gender?.q)}`
);

await page.click('#q_gender_identity_i_prefer_to_self_describe');
await page.waitForTimeout(600);
const selfDescribe = (await held()).pop();
check(
  "'I prefer to self-describe' is never stored as a question",
  !/prefer to self[-\s]?describe/i.test(selfDescribe?.q || ""),
  `q = ${JSON.stringify(selfDescribe?.q)}`
);

/* ---- 3. radio group with a uuid name ---- */
await page.click('input[type="radio"][value="No"]');
await page.waitForTimeout(600);
const trans = await latest(/^No$/);
check(
  "the radio group is saved under its printed question",
  trans?.q === "Do you identify as transgender?",
  `q = ${JSON.stringify(trans?.q)}`
);
check("the radio answer is typed as a radio", trans?.t === "radio", `t = ${trans?.t}`);

/* ---- 4. native select ---- */
await page.selectOption("select", "Jacksonville, Florida, United States");
await page.waitForTimeout(600);
const location = await latest(/Jacksonville/);
check(
  "the dropdown is saved under its printed question",
  location?.q === "Which location are you applying to?",
  `q = ${JSON.stringify(location?.q)}`
);
check("the dropdown answer is typed as a select", location?.t === "select", `t = ${location?.t}`);
check(
  "the dropdown's placeholder row is not kept as a choice",
  (location?.n ?? 0) === 4,
  `options = ${location?.n}`
);

/* ---- 5. an AI draft nobody touched must not be offered ---- */
await page.evaluate(() => {
  const box = document.getElementById("q_why_superhuman");
  const draft = "I have long admired Superhuman's focus on speed.";

  // What applyValue does on the AI path: the native setter, the events a React
  // form needs, the written-value marker, and the drafted set.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(box, draft);
  box.__applifillWrittenValue = draft;
  box.__applifillUserEdited = false;
  window.__applifill.state.drafted.add(box);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("change", { bubbles: true }));

  // The settle pass runs 2200ms after a fill — long past the 1500ms window
  // that used to be the only thing separating our writing from theirs.
  window.__applifillSettleReplay = () => {
    setter.call(box, draft);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
});
await page.waitForTimeout(1800);
await page.evaluate(() => window.__applifillSettleReplay());
await page.waitForTimeout(700);
check(
  "an untouched AI draft is not offered as an unsaved answer",
  !(await held()).some((h) => /Superhuman's focus/.test(h.a)),
  `held = ${JSON.stringify(await held())}`
);

/* ---- 6. typing over that draft is the applicant's answer ---- */
await page.click("#q_why_superhuman");
await page.fill("#q_why_superhuman", "");
await page.type("#q_why_superhuman", "I want to build fast tools.");
await page.click("h1");
await page.waitForTimeout(600);
check(
  "an answer the applicant types is offered",
  (await held()).some((h) => /build fast tools/.test(h.a)),
  `held = ${JSON.stringify(await held())}`
);

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
