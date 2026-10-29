/**
 * Lever: Phone and Current location, and what Pending Saved Answers offers.
 *
 *   node test/lever-location.spec.mjs
 *
 * Reported from jobs.lever.co/virtualitics: after Fill, Phone read
 * "516-205-8456Jacksonville, Florida, United StatesJacksonville, Flori…" and
 * Current location sat with its suggestion list open ("City of Jacksonville,
 * FL, USA") and nothing picked. Lever puts `data-qa` on the <li> and <div>
 * around every question as well as on the inputs; each wrapper was collected
 * as a text box, "typing" at a <div> went to whichever box held the caret —
 * Phone, which the applicant had just checked — and each <li> (whose `value`
 * is its list number) was held in Pending Saved Answers as an answer of "0".
 *
 * Also locks in the pending rule the report asked for: what Appli-Fill fills is
 * never offered as the applicant's answer; what they change by hand is.
 *
 * 1.19.0: reported again against jobs.lever.co/hasi — "Current location" left
 * empty after Fill. The fixture now behaves as the live page does: the search
 * runs a moment after typing stops, the server takes most of a second
 * ("Loading" meanwhile), and the list is only shown while the box has focus.
 * 1.18.0 typed the place and blurred the box in the same breath, so the list
 * never appeared and nothing was picked.
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

const profileFor = ({ city = "Jacksonville", state = "Florida" } = {}) => ({
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeep@example.com", phone: "516-205-8456",
    city, state, country: "United States",
  },
  workAuth: { authorizedToWork: "Yes" },
  eeo: {},
  experience: [{ company: "Microsoft", title: "DevOps Engineer", startDate: "2022-01", current: true }],
  education: [], documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

/** One Lever page, with the applicant's caret left in Phone. */
async function openLever(profile, { caretInPhone = true, lever = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, lever }) => {
    window.__APPLI_FILL_TEST = true;
    window.__lever = lever;
    window.__held = [];
    window.__discarded = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      if (m?.type === "APPLI_FILL_DISCARD_HELD") window.__discarded.push(...(m.questions || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, lever });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://jobs.lever.co/virtualitics/b1168d1c-2066-4962-8bf0-68da04a10155/apply");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/lever-location.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(200);
  // Lever parsed the résumé into name and email; the applicant clicked into
  // Phone to check the number and typed it.
  await page.fill("[name=name]", "Pradeep Reddy");
  await page.fill("[name=email]", "pradeep@example.com");
  if (caretInPhone) {
    await page.click("#phone-input");
    await page.keyboard.type("516-205-8456");
  }
  await page.waitForTimeout(250);
  return page;
}

const read = (page) => page.evaluate(() => ({
  phone: document.querySelector("[name=phone]").value,
  location: document.querySelector("[name=location]").value,
  selected: document.getElementById("selected-location").value,
  org: document.querySelector("[name=org]").value,
  auth: document.querySelector("[name='cards[auth][field0]']:checked")?.value ?? null,
  needsYou: document.querySelector("[name=location]").classList.contains("applifill-needs-you"),
  held: window.__held.map((h) => ({ q: h.question, a: String(h.answer) })),
  discarded: window.__discarded.slice(),
}));

/* ------------------------------------------------------------------ */
console.log("\nonly real controls are fields");
{
  const page = await openLever(profileFor());
  const collected = await page.evaluate(() =>
    window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map((f) => f.el.tagName));
  check("no wrapper is collected", collected.every((t) => ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t)),
    JSON.stringify(collected));
  check("the boxes themselves are", collected.filter((t) => t === "INPUT").length >= 5, JSON.stringify(collected));

  /* ---------------------------------------------------------------- */
  console.log("\nfill with the caret left in Phone");
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  // Past both settle passes (900ms and 2200ms).
  await page.waitForTimeout(2800);
  let s = await read(page);
  check("Phone keeps exactly the number", s.phone === "516-205-8456", `= ${JSON.stringify(s.phone)}`);
  check("Current location is Lever's own suggestion", s.location === "City of Jacksonville, FL, USA", `= ${JSON.stringify(s.location)}`);
  check("  and the place Lever submits is set", /City of Jacksonville, FL, USA/.test(s.selected), `selectedLocation = ${JSON.stringify(s.selected)}`);
  check("  and the box is not left outlined", s.needsYou === false);
  check("Current company is the current employer", s.org === "Microsoft", `= ${JSON.stringify(s.org)}`);
  check("the work-authorization question is answered", s.auth === "Yes", `= ${s.auth}`);
  check("nothing Appli-Fill filled is offered as a pending answer", s.held.length === 0, JSON.stringify(s.held));
  check("no answer of \"0\" from a wrapper", !s.held.some((h) => h.a === "0"), JSON.stringify(s.held));

  /* ---------------------------------------------------------------- */
  console.log("\na click elsewhere on the page is not an edit");
  await page.click("h4");
  await page.click("[name=org]");
  await page.click("h4");
  await page.waitForTimeout(600);
  s = await read(page);
  check("still nothing pending after clicking around", s.held.length === 0, JSON.stringify(s.held));

  /* ---------------------------------------------------------------- */
  console.log("\nwhat the applicant changes by hand is pending");
  await page.click("[name='cards[auth][field0]'][value='No']");
  await page.waitForTimeout(600);
  s = await read(page);
  const auth = s.held.filter((h) => /legally authorized/i.test(h.q)).pop();
  check("changing a filled answer is held", auth?.a === "No", JSON.stringify(s.held));

  await page.click("[name='cards[why][field0]']");
  await page.keyboard.type("The analytics platform and the team.");
  await page.click("h4");
  await page.waitForTimeout(500);
  s = await read(page);
  check("typing an answer by hand is held",
    s.held.some((h) => /interests you/i.test(h.q) && h.a === "The analytics platform and the team."), JSON.stringify(s.held));
  check("only what was changed is held", s.held.every((h) => /legally authorized|interests you/i.test(h.q)), JSON.stringify(s.held));

  console.log("\nputting Appli-Fill's answer back");
  await page.click("[name='cards[auth][field0]'][value='Yes']");
  await page.waitForTimeout(600);
  s = await read(page);
  check("withdraws the answer held for the detour", s.discarded.some((q) => /legally authorized/i.test(q)), JSON.stringify(s.discarded));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nthe right Jacksonville");
{
  const page = await openLever(profileFor({ city: "Jacksonville", state: "Texas" }), { caretInPhone: false });
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  await page.waitForTimeout(1200);
  const s = await read(page);
  check("Texas picks Jacksonville, TX — not Florida, not the beach", s.location === "Jacksonville, TX, USA", `= ${JSON.stringify(s.location)}`);
  check("  and sets the submitted place", /Jacksonville, TX, USA/.test(s.selected), s.selected);
  check("  after narrowing a search that found nothing", (await page.evaluate(() => window.__searches.length)) >= 2);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nno suggestion is the applicant's place");
{
  const page = await openLever(profileFor({ city: "Springfield", state: "Oregon" }), { caretInPhone: true });
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  await page.waitForTimeout(1200);
  const s = await read(page);
  check("a different state's Springfield is never picked", !/IL|MO|MA/.test(s.location) && s.selected === "", `= ${JSON.stringify(s.location)} / ${s.selected}`);
  check("  the box keeps the applicant's full answer", s.location === "Springfield, Oregon, United States", `= ${JSON.stringify(s.location)}`);
  check("  and is outlined for them to choose", s.needsYou === true);
  check("  and Phone is untouched", s.phone === "516-205-8456", `= ${JSON.stringify(s.phone)}`);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\na slow location search");
{
  // The server takes over two seconds, and shows "Loading" meanwhile.
  const page = await openLever(profileFor(), { caretInPhone: false, lever: { latency: 2300 } });
  const started = Date.now();
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  const ms = Date.now() - started;
  const s = await read(page);
  check("Lever's own suggestion is still picked", s.location === "City of Jacksonville, FL, USA", `= ${JSON.stringify(s.location)} after ${ms}ms`);
  check("  and the place Lever submits is set", /City of Jacksonville/.test(s.selected), s.selected);
  check("  with a single search, not one per retry", (await page.evaluate(() => window.__searches.length)) === 1,
    JSON.stringify(await page.evaluate(() => window.__searches)));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nthe caret stays in the box until a place is picked");
{
  // The list only shows while the box has focus, and the box keeps nothing
  // that was not picked from it.
  const page = await openLever(profileFor(), { caretInPhone: false, lever: { latency: 700, clearsUnpicked: true } });
  await page.evaluate(() => window.__applifill.run({ manual: true }));
  await page.waitForTimeout(600);
  const s = await read(page);
  check("the suggestion is picked while the list is up", s.location === "City of Jacksonville, FL, USA", `= ${JSON.stringify(s.location)}`);
  check("  and survives leaving the box", /City of Jacksonville/.test(s.selected), s.selected);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
