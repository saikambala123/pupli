/**
 * Workday Voluntary Disclosures: ethnicity as a list of checkboxes.
 *
 *   node test/workday-disclosures.spec.mjs
 *
 * Reported from uchicago.wd5 with a screenshot: gender, "Are you Hispanic or
 * Latino?" and veteran status were filled, and the ethnicity list — "Asian
 * (Not Hispanic/Latino) (United States of America)" and so on — was left with
 * nothing ticked, although the profile has the applicant's ethnicity.
 *
 * The race rule refuses a field that is only about Hispanic/Latino, and told
 * the two apart with /ethnicit\b/ — which can never match "ethnicity". Every
 * option on this list says "Hispanic/Latino", so the list was refused.
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

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-background-networking"] });

async function fill(eeo) {
  const profile = { _id: "p1", label: "Default", personal: { firstName: "Pradeep", lastName: "Beeram" }, workAuth: {},
    eeo, experience: [], education: [], documents: [] };
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    } } };
  }, { profile });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://uchicago.wd5.myworkdayjobs.com/en-US/external/job/Chicago%2C-IL/Senior-Dev-Ops-Engineer_JR35197/apply/applyManually");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/workday-disclosures.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(2600);   // past the settle passes
  const state = await page.evaluate(() => ({
    gender: document.getElementById("personalInfoUS--gender").textContent.trim(),
    hispanic: document.getElementById("personalInfoUS--hispanicOrLatino").textContent.trim(),
    veteran: document.getElementById("personalInfoUS--veteranStatus").textContent.trim(),
    ticked: Array.from(document.querySelectorAll("#ethnicity-list input")).filter((b) => b.checked)
      .map((b) => b.closest(".cb").querySelector("label").textContent),
    held: window.__held.map((h) => h.question),
  }));
  await page.close();
  return { result, ...state };
}

const BASE = { gender: "Male", hispanicLatino: "No", veteranStatus: "I am not a protected veteran" };

console.log("\nThe page from the report");
{
  const run = await fill({ ...BASE, race: "Asian" });
  check("Asian is ticked", JSON.stringify(run.ticked) === JSON.stringify(["Asian (Not Hispanic/Latino) (United States of America)"]), JSON.stringify(run.ticked));
  check("gender, Hispanic and veteran are still answered",
    run.gender === "Male" && run.hispanic === "No" && run.veteran === "I AM NOT A PROTECTED VETERAN", JSON.stringify(run));
  check("nothing is left needing the applicant", run.result.unmatched === 0, `unmatched=${run.result.unmatched}`);
  check("nothing Appli-Fill ticked is offered as a manual edit", run.held.length === 0, JSON.stringify(run.held));
}

console.log("\nHowever the profile words it");
for (const [race, want] of [
  ["White", "White (Not Hispanic/Latino) (United States of America)"],
  ["Black or African American", "Black or African American (Not Hispanic/Latino) (United States of America)"],
  ["American Indian or Alaska Native", "American Indian or Alaskan Native (Not Hispanic/Latino) (United States of America)"],
  ["Native Hawaiian or Other Pacific Islander", "Native Hawaiian or Other Pacific Islander (Not Hispanic/Latino) (United States of America)"],
  ["Asian (Not Hispanic or Latino)", "Asian (Not Hispanic/Latino) (United States of America)"],
]) {
  const run = await fill({ ...BASE, race });
  check(`"${race}" ticks its own box only`, JSON.stringify(run.ticked) === JSON.stringify([want]), JSON.stringify(run.ticked));
}
{
  const run = await fill({ ...BASE, race: "Two or More Races" });
  check("a category the list does not offer ticks nothing", run.ticked.length === 0, JSON.stringify(run.ticked));
}
{
  const run = await fill({ ...BASE, race: "Hispanic or Latino", hispanicLatino: "Yes" });
  check("Hispanic is answered by its own question, and no box is guessed", run.hispanic === "Yes" && run.ticked.length === 0,
    JSON.stringify({ hispanic: run.hispanic, ticked: run.ticked }));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
