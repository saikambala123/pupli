/**
 * Workday: "How Did You Hear About Us?" answered from the profile.
 *
 *   node test/workday-source-prompt.spec.mjs
 *
 * Reported from seic.wd1.myworkdayjobs.com (My Information): the question has
 * to be answered by picking an entry — a pill such as "× LinkedIn" — from a
 * prompt whose list is in categories ("Job Board ›", "Social Media ›"). The
 * extension typed the profile's answer into the search box and moved on; text
 * in the box is not an answer, and Save and Continue refused the step.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const URL = "https://seic.wd1.myworkdayjobs.com/en-US/sei_global_services/job/USA---Chicago/Senior-DevOps-SRE-Engineer_JR123/apply/applyManually";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const profileWith = (howDidYouHear) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", city: "Jacksonville", state: "FL", country: "United States" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", previouslyEmployedHere: "No", ...(howDidYouHear ? { howDidYouHear } : {}) },
  eeo: {}, experience: [], education: [], documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill(howDidYouHear, { search = true, tree = null, prefill = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, search, tree, prefill }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    window.__SOURCE_SEARCH = search;
    if (tree) window.__SOURCE_TREE = tree;
    if (prefill) window.__SOURCE_PREFILL = prefill;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile: profileWith(howDidYouHear), search, tree, prefill });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(join(ROOT, "test/fixtures/workday-source-prompt.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  await page.waitForTimeout(300);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await page.evaluate(() => {
    const input = document.getElementById("source--source");
    return {
      pills: Array.from(document.querySelectorAll('[data-automation-id="selectedItemList"] [data-automation-id="selectedItem"]'))
        .map((p) => p.getAttribute("title")),
      searchText: input.value,
      error: window.__sourceError,
      outlined: input.classList.contains("applifill-needs-you"),
      popupOpen: Boolean(document.querySelector('[data-automation-id="activeListContainer"]')),
      searches: window.__searches, opened: window.__opened,
      previousWorker: document.querySelector('input[name="candidateIsPreviousWorker"]:checked')?.value ?? null,
      held: window.__held.map((h) => `${h.question} = ${h.answer}`),
    };
  });
  await page.close();
  return { ...s, result, ms };
}

console.log("\nLinkedIn in the profile, found by searching");
{
  const s = await fill("LinkedIn");
  check("LinkedIn is picked, as a pill", s.pills.join("|") === "LinkedIn", JSON.stringify(s));
  check("  searched by the profile's own answer", s.searches[0] === "LinkedIn", JSON.stringify(s.searches));
  check("  Save and Continue accepts it", s.error === "", `error: ${s.error}`);
  check("  no search text is left in the box", s.searchText === "", JSON.stringify(s.searchText));
  check("  the list is closed", s.popupOpen === false);
  check("  reported as filled, not outlined", (s.result.keys ?? []).includes("howDidYouHear") && !s.outlined, JSON.stringify(s.result));
  check("  not offered back as the applicant's answer", s.held.length === 0, JSON.stringify(s.held));
  check("the rest of the step still fills (previously employed = No)", s.previousWorker === "false", `= ${s.previousWorker}`);
  check(`done in ${s.ms}ms`, s.ms < 8000);
}

console.log("\nIndeed in the profile");
{
  const s = await fill("Indeed");
  check("Indeed is picked", s.pills.join("|") === "Indeed" && s.error === "", JSON.stringify(s));
}

console.log("\na list that is browsed, not searched");
{
  const s = await fill("LinkedIn", { search: false });
  check("LinkedIn is found inside its category and picked", s.pills.join("|") === "LinkedIn" && s.error === "", JSON.stringify(s));
  check("  Social Media was opened first (LinkedIn is a social network before a job board)", s.opened[0] === "Social Media", JSON.stringify(s.opened));
}

console.log("\nthe company's own careers site");
{
  const s = await fill("Company Website");
  check("\"SEI Careers Website\" is picked for Company Website", s.pills.join("|") === "SEI Careers Website" && s.error === "", JSON.stringify(s));
}

console.log("\na list of categories only");
{
  const s = await fill("LinkedIn", {
    search: false,
    tree: [{ name: "Job Board" }, { name: "Social Media" }, { name: "Referral" }, { name: "Other" }],
  });
  check("the category LinkedIn belongs to is picked (Social Media)", s.pills.join("|") === "Social Media" && s.error === "", JSON.stringify(s));
}

console.log("\nan answer already there");
{
  const s = await fill("LinkedIn", { prefill: "Indeed" });
  check("a pill already given is left as it is", s.pills.join("|") === "Indeed" && s.searches.length === 0, JSON.stringify(s));
}

console.log("\nnothing in the profile");
{
  const s = await fill(null);
  check("nothing is picked", s.pills.length === 0, JSON.stringify(s));
  check("  the question is outlined for the applicant", s.outlined === true, JSON.stringify(s));
  check("  and no text is typed into it", s.searchText === "" && s.searches.length === 0, JSON.stringify(s));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
