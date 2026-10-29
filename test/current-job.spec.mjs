/**
 * "I currently work here" belongs to one job, not to every job.
 *
 *   node test/current-job.spec.mjs
 *
 * Reported as: the box is ticked on every Work Experience block, when only the
 * role the profile marks as current should have it.
 *
 * The cause was that three things in the engine grouped choice controls without
 * asking which repeated row they were in. A shared `name`, or one
 * `[role="group"]` around the section, made all three boxes one question — so
 * only the first was collected as a field, rows two and three were never
 * answered, and a single write set every box in the group at once.
 *
 * The run is repeated with each of the three jobs marked current in turn, plus
 * once with none, because a fix that always ticks the first box would pass a
 * single-case test. Section C of the fixture is a real multi-answer checkbox
 * group, which must keep working exactly as before.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const jobs = (currentAt) => [
  { title: "Senior DevOps Engineer", company: "Northern Trust", location: "Chicago, IL",
    startDate: "2025-02", endDate: "2025-08", current: currentAt === 0 },
  { title: "DevOps Engineer", company: "One Trust LLC", location: "Austin, TX",
    startDate: "2021-06", endDate: "2022-02", current: currentAt === 1 },
  { title: "Cloud Engineer", company: "Cognizant", location: "Hyderabad, India",
    startDate: "2019-03", endDate: "2021-05", current: currentAt === 2 },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});

/** Fill the fixture with one job marked current, and read every box back. */
async function runWith(currentAt) {
  return runWithJobs(jobs(currentAt));
}

/** The same, for a hand-built job list — the data cases below vary that. */
async function runWithJobs(experience) {
  const profile = {
    _id: "p1", label: "Default",
    personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com" },
    websites: {}, workAuth: {}, eeo: {},
    experience, education: [], documents: [],
  };
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
    };
    window.chrome = { runtime: { lastError: null,
      sendMessage(m, cb) {
        const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      }, onMessage: { addListener() {} } } };
  }, { profile });

  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/current-job.html")).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(220);
  await page.evaluate(async () => await window.__applifill.run({ manual: true }));
  await page.waitForTimeout(1100);

  const out = await page.evaluate(() => {
    const on = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      return el.getAttribute("role") === "checkbox"
        ? el.getAttribute("aria-checked") === "true"
        : Boolean(el.checked);
    };
    const val = (id) => document.getElementById(id)?.value ?? null;
    return {
      a: [on("a1cur"), on("a2cur"), on("a3cur")],
      b: [on("b1cur"), on("b2cur"), on("b3cur")],
      companiesA: [val("a1c"), val("a2c"), val("a3c")],
      companiesB: [val("b1c"), val("b2c"), val("b3c")],
      fields: window.__applifill.collectFields()
        .filter((f) => f.rule?.key === "currentJob")
        .map((f) => `${f.el.id}:${f.index}`),
    };
  });
  await page.close();
  return out;
}

const expected = (currentAt) => [0, 1, 2].map((i) => i === currentAt);

for (const currentAt of [0, 1, 2]) {
  const label = `job ${currentAt + 1} is the current one`;
  console.log(`\n${label}`);
  const out = await runWith(currentAt);
  const want = expected(currentAt);

  check(
    `shared name: only row ${currentAt + 1} is ticked`,
    JSON.stringify(out.a) === JSON.stringify(want),
    `got ${JSON.stringify(out.a)}, expected ${JSON.stringify(want)}`
  );
  check(
    `role="checkbox" in one group: only row ${currentAt + 1} is ticked`,
    JSON.stringify(out.b) === JSON.stringify(want),
    `got ${JSON.stringify(out.b)}, expected ${JSON.stringify(want)}`
  );
  check(
    "every row's box is collected as its own field",
    out.fields.length === 6,
    `collected: ${JSON.stringify(out.fields)}`
  );
  check(
    "each row still gets its own employer",
    JSON.stringify(out.companiesA) === JSON.stringify(["Northern Trust", "One Trust LLC", "Cognizant"]) &&
    JSON.stringify(out.companiesB) === JSON.stringify(["Northern Trust", "One Trust LLC", "Cognizant"]),
    `A: ${JSON.stringify(out.companiesA)}  B: ${JSON.stringify(out.companiesB)}`
  );
}

console.log("\nno job is marked current");
{
  const out = await runWith(-1);
  check("nothing is ticked when the profile says no job is current",
    out.a.every((x) => x === false) && out.b.every((x) => x === false),
    `A: ${JSON.stringify(out.a)}  B: ${JSON.stringify(out.b)}`);
}

/* ================================================================== */
/*  The data, not the markup                                           */
/* ================================================================== */

/**
 * Every markup variant above fills correctly from a clean profile, which is
 * why the reported case is here instead: the flag itself arrives on more than
 * one role. A resume parser sets it that way whenever "Present" or "Till Date"
 * appears against more than one entry, which overlapping and contract roles
 * routinely do. Answering each box from its own row's flag then ticked all of
 * them — and Workday drops the To date for a role marked current, so the end
 * date of the whole employment history went with it.
 */
const A = { title: "Senior DevOps Engineer", company: "Northern Trust", location: "Chicago, IL", startDate: "2022-03" };
const B = { title: "DevOps Engineer", company: "One Trust LLC", location: "Austin, TX", startDate: "2021-06" };
const C = { title: "Cloud Engineer", company: "Cognizant", location: "Hyderabad, India", startDate: "2019-01" };

console.log("\nevery role carries the flag — the reported case");
{
  const out = await runWithJobs([
    { ...A, endDate: "", current: true },
    { ...B, endDate: "", current: true },
    { ...C, endDate: "", current: true },
  ]);
  const ticked = out.a.filter(Boolean).length;
  check("exactly one row says 'I currently work here'", ticked === 1, `${ticked} ticked: ${JSON.stringify(out.a)}`);
  check("it is the most recent role", out.a[0] === true, JSON.stringify(out.a));
  check("the same holds for the grouped widgets", JSON.stringify(out.b) === JSON.stringify([true, false, false]), JSON.stringify(out.b));
}

console.log("\na finished role also carrying the flag");
{
  const out = await runWithJobs([
    { ...A, endDate: "", current: true },
    { ...B, endDate: "2022-02", current: true },
    { ...C, endDate: "2021-05", current: false },
  ]);
  const ticked = out.a.filter(Boolean).length;
  check("still only one row is ticked", ticked === 1, `${ticked} ticked: ${JSON.stringify(out.a)}`);
  check("and it is not the finished one", out.a[1] === false, JSON.stringify(out.a));
}

console.log("\nno flag anywhere, newest role has no end date");
{
  const out = await runWithJobs([
    { ...A, endDate: "", current: false },
    { ...B, endDate: "2022-02", current: false },
    { ...C, endDate: "2021-05", current: false },
  ]);
  // The To box for a role with no end date is left blank either way — there is
  // no date to write. Ticking the box is what explains the blank to the page,
  // instead of leaving a required field empty for no visible reason.
  check("the open role is ticked", out.a[0] === true, JSON.stringify(out.a));
  check("the closed roles are left alone", out.a[1] === false && out.a[2] === false, JSON.stringify(out.a));
}

console.log("\nan older role missing its end date is missing data, not a job");
{
  const out = await runWithJobs([
    { ...A, endDate: "2025-01", current: false },
    { ...B, endDate: "2022-02", current: false },
    { ...C, endDate: "", current: false },
  ]);
  check("nothing is ticked", out.a.every((x) => x === false), JSON.stringify(out.a));
}

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
