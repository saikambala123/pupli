/**
 * Ashby: a Location question that only takes one of its own suggestions.
 *
 *   node test/ashby-location.spec.mjs
 *
 * Reported from jobs.ashbyhq.com/brellium: Location was left empty. Three
 * things stopped it:
 *
 *   - the location rule's denials ("office", "job", "role"…) were tested
 *     against the question's description as well as its label, and Ashby's
 *     description reads "…four days a week from our Flatiron office";
 *   - the box is an <input role="combobox">, so it was treated as a dropdown —
 *     opened, found to offer nothing before anything was typed, and left;
 *   - its list can hold only countries (typing "uni" offers United States,
 *     United Kingdom, United Arab Emirates, Tanzania, US Virgin Islands), and
 *     only a suggestion naming the applicant's city was ever accepted.
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

const profileFor = ({ city = "Jacksonville", state = "Florida", country = "United States" } = {}) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "pradeep@example.com", city, state, country },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "Yes" },
  eeo: {}, experience: [], education: [], documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill({ mode, profile = profileFor() }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, mode }) => {
    window.__APPLI_FILL_TEST = true;
    window.__LOCATION_MODE = mode;
    window.__held = [];
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, mode });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://jobs.ashbyhq.com/brellium/3b053466-38c2-4ff6-af3e-997d2bd6f896/application");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/ashby-location.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  // The applicant moves on to the next question.
  await page.click("#_systemfield_name");
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    value: document.getElementById("_systemfield_location").value,
    picked: window.__picked,
    rule: window.__applifill.state.allFields.find((f) => f.el.id === "_systemfield_location")?.rule?.key ?? null,
    held: window.__held.map((h) => h.question),
    flagged: document.getElementById("_systemfield_location").classList.contains("applifill-needs-you"),
  }));
  return { page, result, ms, ...state };
}

console.log("\nA list of countries (typing \"uni\" offers United States, United Kingdom, …)");
{
  const run = await fill({ mode: "countries" });
  check("the Location question is recognised despite \"office\" in its description", run.rule === "location", `rule=${run.rule}`);
  check("United States is picked from the list", run.picked === "United States", `picked=${run.picked} value=${run.value}`);
  check("…and stays after leaving the box", run.value === "United States", `value=${run.value}`);
  check("never a look-alike (US Virgin Islands, Minor Outlying Islands)", !/Virgin|Outlying/.test(run.value));
  check(`done in ${run.ms}ms`, run.ms < 6500, `${run.ms}ms`);
  check("not offered as an answer the applicant typed", !run.held.some((q) => /location/i.test(q)), JSON.stringify(run.held));
  await run.page.close();
}
{
  const run = await fill({ mode: "countries", profile: profileFor({ city: "Hyderabad", state: "Telangana", country: "India" }) });
  check("an applicant in India gets India", run.picked === "India", `picked=${run.picked}`);
  await run.page.close();
}

console.log("\nA list of places (cities, states and countries)");
{
  const run = await fill({ mode: "places" });
  check("the applicant's city in the applicant's state is picked", run.picked === "Jacksonville, Florida, United States", `picked=${run.picked}`);
  check("not Jacksonville Beach, nor another state's Jacksonville", !/Beach|North Carolina|Texas/.test(run.value), run.value);
  await run.page.close();
}
{
  const run = await fill({ mode: "places", profile: profileFor({ city: "Stanley", state: "NC" }) });
  check("a state stored as a code still finds the right Stanley", run.picked === "Stanley, North Carolina, United States", `picked=${run.picked}`);
  await run.page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
