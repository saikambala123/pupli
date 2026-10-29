/**
 * Saved answers: what gets captured, under what question, and what comes back.
 *
 *   node test/saved-answers.spec.mjs
 *
 * Reported, with a screenshot: a demographic radio group was banked as
 * question "Prefer not to say" with answer "No" — an option's own label stored
 * as the question — while the unsaved list simultaneously filled up with every
 * field on the page, including ones the applicant had never touched.
 *
 * Four separate faults produced that:
 *
 *   1. The question search accepted a sibling `<label for=…>` — which is an
 *      option's label — as a heading. "Yes" and "No" were under the 8-character
 *      floor so they slipped through; "Prefer not to say" did not.
 *   2. A choice group was resolved four different ways by four callers, so a
 *      group with no shared `name` reported one option to one caller and three
 *      to another, and the value read did not match the options stored with it.
 *   3. An option's text was read from its siblings, which in an ARIA radiogroup
 *      are the other options — so picking "Prefer not to say" recorded "No",
 *      the shortest neighbouring text.
 *   4. Capture treated arriving at a field as answering it, so a pre-filled
 *      form was banked wholesale on the first fill and tabbing through was
 *      enough to queue the rest.
 *
 * The round trip at the end is the point of the feature: an answer given on one
 * application has to come back on the next one.
 */

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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

/** A page with the extension loaded and its messages captured. */
async function open(html, responses = []) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    const session = {
      profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          if (msg?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(msg.items || []));
          const r = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
            : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
            : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile: PROFILE, responses });

  const file = join(tmpdir(), `applifill-sa-${Math.random().toString(36).slice(2)}.html`);
  await writeFile(file, html);
  await page.goto(pathToFileURL(file).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(300);
  return page;
}

const held = (page) =>
  page.evaluate(() => window.__held.map((x) => ({
    q: x.question, a: String(x.answer), t: x.inputType, o: x.options || [],
  })));

/* ================================================================== */
/*  1. The question is the question, whatever the markup               */
/* ================================================================== */

console.log("\nthe question stored is the question, not an option");

const QUESTION = "Are you the first member of your immediate family to attend university?";

const SHAPES = {
  "a shared name and a sibling <label for>": {
    html: `<div class="field"><div class="text--question">${QUESTION}</div>
      <div><input type="radio" id="a1" name="dq" value="Yes"><label for="a1">Yes</label></div>
      <div><input type="radio" id="a2" name="dq" value="No"><label for="a2">No</label></div>
      <div><input type="radio" id="a3" name="dq" value="Prefer not to say"><label for="a3">Prefer not to say</label></div></div>`,
    click: "#a3", expect: "Prefer not to say",
  },
  "no name attribute at all": {
    html: `<div class="field" role="group"><div class="text--question">${QUESTION}</div>
      <div><input type="radio" id="b1" value="Yes"><label for="b1">Yes</label></div>
      <div><input type="radio" id="b2" value="No"><label for="b2">No</label></div>
      <div><input type="radio" id="b3" value="Prefer not to say"><label for="b3">Prefer not to say</label></div></div>`,
    click: "#b3", expect: "Prefer not to say",
  },
  "a unique name per option": {
    html: `<div class="field"><div class="text--question">${QUESTION}</div>
      <div><input type="radio" id="c1" name="dq[0]" value="Yes"><label for="c1">Yes</label></div>
      <div><input type="radio" id="c2" name="dq[1]" value="No"><label for="c2">No</label></div>
      <div><input type="radio" id="c3" name="dq[2]" value="Prefer not to say"><label for="c3">Prefer not to say</label></div></div>`,
    click: "#c2", expect: "No",
  },
  "an ARIA radiogroup of divs": {
    html: `<div class="field"><div class="text--question">${QUESTION}</div>
      <div role="radiogroup"><div role="radio" id="d1" aria-checked="false" tabindex="0">Yes</div>
      <div role="radio" id="d2" aria-checked="false" tabindex="0">No</div>
      <div role="radio" id="d3" aria-checked="false" tabindex="0">Prefer not to say</div></div></div>
      <script>document.querySelectorAll('[role=radio]').forEach(r=>r.addEventListener('click',()=>{
        r.closest('[role=radiogroup]').querySelectorAll('[role=radio]').forEach(x=>x.setAttribute('aria-checked','false'));
        r.setAttribute('aria-checked','true');}));<\/script>`,
    click: "#d3", expect: "Prefer not to say",
  },
};

for (const [name, shape] of Object.entries(SHAPES)) {
  const page = await open(`<!doctype html><html><body><form id="application_form">${shape.html}</form></body></html>`);
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  await page.waitForTimeout(600);
  await page.click(shape.click, { force: true });
  await page.waitForTimeout(800);

  const rows = await held(page);
  const row = rows[rows.length - 1];
  check(`${name}: stored under the question`, row?.q === QUESTION, JSON.stringify(rows));
  check(`${name}: the chosen option is the answer`, row?.a === shape.expect, JSON.stringify(rows));
  check(`${name}: captured once, not once per option`, rows.length === 1, `${rows.length} entries`);
  check(
    `${name}: every option is stored beside it`,
    (row?.o ?? []).length === 3,
    JSON.stringify(row?.o)
  );
  await page.close();
}

/* ================================================================== */
/*  2. Only what the applicant actually did                            */
/* ================================================================== */

console.log("\nonly answers the applicant gave reach the unsaved list");

const PREFILLED = `<!doctype html><html><body><form id="application_form">
  <div><label for="p1">What is your preferred pronoun?</label><input id="p1" name="pronoun" value="They/Them"></div>
  <div><label for="p2">Describe your ideal team culture</label><textarea id="p2" name="culture">Collaborative and low-ego.</textarea></div>
  <div><label for="p3">How many years of Python?</label><select id="p3" name="py"><option>1</option><option selected>5</option></select></div>
  <div><label for="p4">What is your notice period?</label><input id="p4" name="notice"></div>
</form></body></html>`;

let page = await open(PREFILLED);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(800);
check("a fill does not bank the fields the portal pre-filled", (await held(page)).length === 0, JSON.stringify(await held(page)));

await page.click("#p1");
await page.click("body");
await page.waitForTimeout(600);
check("visiting a field without changing it banks nothing", (await held(page)).length === 0, JSON.stringify(await held(page)));

await page.fill("#p4", "30 days");
await page.click("body");
await page.waitForTimeout(600);
let rows = await held(page);
check("an answer the applicant types is banked", rows.length === 1 && rows[0].a === "30 days", JSON.stringify(rows));

await page.fill("#p2", "Actually, I prefer strong written communication.");
await page.click("body");
await page.waitForTimeout(600);
rows = await held(page);
check(
  "editing a value that was already there banks the edit",
  rows.some((r) => /ideal team culture/i.test(r.q) && /written communication/.test(r.a)),
  JSON.stringify(rows)
);
await page.close();

console.log("\nidentity fields stay in the profile, never in Saved Answers");
page = await open(`<!doctype html><html><body><form id="application_form">
  <div><label for="n1">First Name</label><input id="n1" name="first_name"></div>
  <div><label for="n2">Email</label><input id="n2" name="email" type="email"></div>
</form></body></html>`);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(700);
await page.fill("#n1", "Madhusudhan");
await page.click("body");
await page.waitForTimeout(600);
check("correcting an autofilled name is not banked as an answer", (await held(page)).length === 0, JSON.stringify(await held(page)));
await page.close();

/* ================================================================== */
/*  3. A neighbouring question's answer never leaks across             */
/* ================================================================== */

console.log("\na question is read from its own field, not the one next to it");

page = await open(
  `<!doctype html><html><body><form id="application_form"><div id="block">
    <div class="field"><label for="s1">Address</label><input id="s1" name="address"></div>
    <div class="field"><label for="s2">City</label><input id="s2" name="city"></div>
    <div class="field"><label for="s3">How did you hear about us?</label><input id="s3" name="hear"></div>
  </div></form></body></html>`,
  [{ question: "How did you hear about us?", normalizedKey: "how hear about us", answer: "LinkedIn", aliases: [] }]
);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(800);
check(
  "the neighbour's saved answer did not land in Address",
  (await page.evaluate(() => document.getElementById("s1").value)) === "",
  `address = ${await page.evaluate(() => document.getElementById("s1").value)}`
);
check(
  "the neighbour's saved answer did not land in City",
  (await page.evaluate(() => document.getElementById("s2").value)) === "",
  `city = ${await page.evaluate(() => document.getElementById("s2").value)}`
);
check(
  "it did land in the question it belongs to",
  (await page.evaluate(() => document.getElementById("s3").value)) === "LinkedIn",
  `hear = ${await page.evaluate(() => document.getElementById("s3").value)}`
);
await page.close();

/* ================================================================== */
/*  4. The round trip                                                  */
/* ================================================================== */

console.log("\nan answer given on one application comes back on the next");

const FORM_A = `<!doctype html><html><body><form id="application_form">
  <div class="field"><div class="text--question">${QUESTION}</div>
    <div><input type="radio" id="r1" name="fg" value="Yes"><label for="r1">Yes</label></div>
    <div><input type="radio" id="r2" name="fg" value="No"><label for="r2">No</label></div>
    <div><input type="radio" id="r3" name="fg" value="Prefer not to say"><label for="r3">Prefer not to say</label></div></div>
  <div class="field"><label for="sel">What is your notice period?</label>
    <select id="sel" name="notice"><option value="">Select…</option><option>Immediately</option><option>30 days</option></select></div>
</form></body></html>`;

page = await open(FORM_A);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(600);
await page.click("#r3", { force: true });
await page.waitForTimeout(500);
await page.selectOption("#sel", "30 days");
await page.waitForTimeout(700);
const captured = await held(page);
await page.close();

check("both answers were captured on the first application", captured.length === 2, JSON.stringify(captured));

// Exactly what Save + Sync would store, and what the next fill is handed back.
const synced = captured.map((c) => ({
  question: c.q, answer: c.a, inputType: c.t, options: c.o, aliases: [],
}));

// The next application words the same questions differently and uses different
// markup for them — a dropdown where the first used radios.
const FORM_B = `<!doctype html><html><body><form id="application_form">
  <div class="field"><div class="text--question">${QUESTION}</div>
    <div><input type="radio" id="x1" value="Yes"><label for="x1">Yes</label></div>
    <div><input type="radio" id="x2" value="No"><label for="x2">No</label></div>
    <div><input type="radio" id="x3" value="Prefer not to say"><label for="x3">Prefer not to say</label></div></div>
  <div class="field"><label for="ns">What is your notice period?</label>
    <select id="ns" name="notice"><option value="">Select…</option><option>2 weeks</option><option>30 days</option></select></div>
</form></body></html>`;

page = await open(FORM_B, synced);
await page.evaluate(() => window.__applifill.run({ manual: true }));
await page.waitForTimeout(900);
check(
  "the radio answer is replayed onto the next application",
  (await page.evaluate(() => document.getElementById("x3").checked)) === true,
  await page.evaluate(() => ["x1", "x2", "x3"].filter((i) => document.getElementById(i).checked).join(",") || "(none checked)")
);
check(
  "the dropdown answer is replayed onto the next application",
  (await page.evaluate(() => document.getElementById("ns").value)) === "30 days",
  `notice = ${await page.evaluate(() => document.getElementById("ns").value)}`
);
check(
  "replaying does not put the replayed answers straight back in the unsaved list",
  (await held(page)).length === 0,
  JSON.stringify(await held(page))
);
await page.close();

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
