/**
 * Lever: "Current location" is filled, but the application will not submit.
 *
 *   node test/lever-location-pick.spec.mjs
 *
 * Reported from jobs.lever.co/palantir: the box read "Jacksonville, FL, USA"
 * after Fill, and Lever refused the application. Lever submits only a place
 * picked from its own list (the hidden `selectedLocation`); typed text is not
 * an answer. Three ways the pick was lost:
 *
 *   - Lever's lookup sits behind hCaptcha, and the first search of a page can
 *     wait on that check for longer than the 3.5s allowed; nothing was picked
 *     and the typed text was left looking like an answer;
 *   - the first keystrokes can arrive before the check has its token, and the
 *     search is then dropped without a word;
 *   - a box already holding typed text was taken as answered and skipped on
 *     every later Fill, however Lever regarded it.
 *
 * When Lever wants a human to pass its check first, nothing can be picked
 * during the fill: the box is outlined (not reported as filled), and the pick
 * is finished the moment the applicant clicks into it.
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

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456",
    city: "Jacksonville", state: "Florida", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes" },
  eeo: {},
  experience: [{ company: "Microsoft", title: "Senior DevOps Engineer", startDate: "2022-01", current: true }],
  education: [], documents: [],
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function openLever({ lever = {}, typedBefore = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, lever }) => {
    window.__APPLI_FILL_TEST = true;
    window.__lever = lever;
    window.__held = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile: PROFILE, lever });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://jobs.lever.co/palantir/51ea4a3b-7764-4c87-96e4-310e19c856d5/apply");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/lever-location.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  if (typedBefore) {
    // Typed into the box earlier (by hand, or by an earlier fill) and never
    // picked from the list.
    await page.evaluate((text) => { document.querySelector("[name=location]").value = text; }, typedBefore);
  }
  await page.waitForTimeout(150);
  return page;
}

const read = (page) => page.evaluate(() => {
  const form = document.getElementById("application-form");
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  const box = document.querySelector("[name=location]");
  return {
    location: box.value,
    selected: document.getElementById("selected-location").value,
    outlined: box.classList.contains("applifill-needs-you"),
    submitErrors: window.__submitErrors,
    held: window.__held.map((h) => `${h.question} = ${h.answer}`),
  };
});

const fill = (page) => page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});

console.log("\ntyped earlier and never picked");
{
  const page = await openLever({ typedBefore: "Jacksonville, FL, USA" });
  const result = await fill(page);
  await page.waitForTimeout(400);
  const s = await read(page);
  check("the box is not taken as answered", (result.keys ?? []).includes("location"), JSON.stringify(result.keys));
  check("Lever's own place is picked", s.location === "City of Jacksonville, FL, USA" && /Jacksonville/.test(s.selected), JSON.stringify(s));
  check("  the application submits", Array.isArray(s.submitErrors) && s.submitErrors.length === 0, JSON.stringify(s.submitErrors));
  await page.close();
}

console.log("\nLever's first lookup is slow (its check runs first)");
{
  const page = await openLever({ lever: { latency: 5200 } });
  const started = Date.now();
  await fill(page);
  const ms = Date.now() - started;
  await page.waitForTimeout(300);
  const s = await read(page);
  check("the list is waited for and the place picked", /Jacksonville, FL/.test(s.selected), JSON.stringify(s));
  check("  the application submits", Array.isArray(s.submitErrors) && s.submitErrors.length === 0, JSON.stringify(s.submitErrors));
  check(`  not outlined (${ms}ms)`, s.outlined === false);
  await page.close();
}

console.log("\nthe first keystrokes arrive before Lever's check is ready");
{
  const page = await openLever({ lever: { tokenAfter: 1400 } });
  await fill(page);
  await page.waitForTimeout(300);
  const s = await read(page);
  check("the search is asked for again and the place picked", s.location === "City of Jacksonville, FL, USA" && /Jacksonville/.test(s.selected), JSON.stringify(s));
  await page.close();
}

console.log("\nLever wants a human to pass its check first");
{
  const page = await openLever({ lever: { challenge: true } });
  const result = await fill(page);
  await page.waitForTimeout(300);
  let s = await read(page);
  check("the place is not reported as filled", !(result.keys ?? []).includes("location"), JSON.stringify(result.keys));
  check("  it is counted as needing the applicant", (result.unmatched ?? 0) >= 1, JSON.stringify(result));
  check("  and the box is outlined", s.outlined === true, JSON.stringify(s));
  check("  (Lever would refuse it as it stands)", Array.isArray(s.submitErrors) && s.submitErrors.length === 1, JSON.stringify(s.submitErrors));

  // The applicant passes the check and clicks into the box.
  await page.evaluate(() => window.__solveChallenge());
  await page.click("[name=location]");
  await page.waitForTimeout(3200);
  s = await read(page);
  check("clicking into the box finishes the pick", s.location === "City of Jacksonville, FL, USA" && /Jacksonville/.test(s.selected), JSON.stringify(s));
  check("  the outline goes", s.outlined === false);
  check("  the application submits", Array.isArray(s.submitErrors) && s.submitErrors.length === 0, JSON.stringify(s.submitErrors));
  check("  and Appli-Fill's pick is not offered as the applicant's answer", !s.held.some((h) => /location/i.test(h)), JSON.stringify(s.held));
  await page.close();
}

console.log("\nthe applicant types a different place themselves");
{
  const page = await openLever({ lever: { challenge: true } });
  await fill(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__solveChallenge());
  await page.click("[name=location]", { clickCount: 3 });
  await page.keyboard.type("Chicago");
  await page.waitForTimeout(2600);
  const s = await read(page);
  check("their own text is left for them to pick from", !/Jacksonville/.test(s.location), JSON.stringify(s));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
