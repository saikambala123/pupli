/**
 * Work experience, education, and answers that don't fit the field.
 *
 *   node test/workday-experience.spec.mjs
 *
 * Three reports from a Workday application:
 *
 *   1. "The field Company is required and must have a value" — with the company
 *      name plainly visible in the box. The value reached the DOM but never the
 *      framework's model, so the page did not believe it was there.
 *
 *   2. The LinkedIn box was filled with "I do not have a LinkedIn profile or
 *      social network account" and rejected as an invalid URL. That sentence is
 *      a drafted answer: a sensible reply, and completely unusable in a field
 *      that wants a link.
 *
 *   3. Education names and dates.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", city: "Stanley" },
  websites: {},   // no LinkedIn, deliberately
  workAuth: {}, eeo: {},
  experience: [{
    title: "IAM/PAM Analyst", company: "Northern Trust Bank", location: "Chicago, IL",
    startDate: "2022-01", endDate: "2024-06", current: false,
    description: "Governed identity and access.",
  }],
  education: [{ school: "University of Texas", degree: "Masters", fieldOfStudy: "Computer Science", startDate: "2016-08", endDate: "2018-05" }],
  documents: [],
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

/** `aiAnswer` stands in for the model, so the drafted-answer path is exercised. */
async function fill({ premium = false, aiAnswer = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, premium, aiAnswer }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses: [], premium,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false, aiAnswers: premium },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(m, cb) {
          let r = { ok: true, data: {} };
          if (m?.type === "APPLI_FILL_GET_SESSION") r = { ok: true, data: session };
          else if (m?.type === "APPLI_FILL_CHECK") r = { ok: true, data: { duplicate: false } };
          else if (m?.type === "APPLI_FILL_ANSWER") r = aiAnswer ? { ok: true, data: { answer: aiAnswer } } : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile: PROFILE, premium, aiAnswer });
  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/workday-experience.html")).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(250);
  await page.evaluate(async () => await window.__applifill.run({ manual: true }));
  await page.waitForTimeout(900);
  return page;
}

/* --- 1. the values land, and the page believes they did --- */
{
  const page = await fill();
  const v = (id) => page.inputValue("#" + id);

  check("job title is filled", (await v("w1t")) === "IAM/PAM Analyst", `got "${await v("w1t")}"`);
  check("company is filled", (await v("w1c")) === "Northern Trust Bank", `got "${await v("w1c")}"`);
  /* The two date boxes carry placeholder="MM/YYYY", so MM/YYYY is what they take.
   This used to assert the ISO spelling, which is what Workday rejects with
   "Invalid Date" — the very failure the date work was about. The To box was
   separately blank: From and To were being read as two different jobs. */
check(
  "work dates are filled",
  (await v("w1f")) === "01/2022" && (await v("w1to")) === "06/2024",
  `${await v("w1f")} → ${await v("w1to")}`
);
  check("school is filled", (await v("e1s")) === "University of Texas", `got "${await v("e1s")}"`);
  check("degree is filled", (await v("e1d")) === "Masters", `got "${await v("e1d")}"`);
  check("field of study is filled", (await v("e1fld")) === "Computer Science", `got "${await v("e1fld")}"`);
  check("education start year is filled", (await v("e1from")) === "2016", `got "${await v("e1from")}"`);
  check("education end year is filled", (await v("e1to")) === "2018", `got "${await v("e1to")}"`);
  check("the two education years differ", (await v("e1from")) !== (await v("e1to")));

  await page.click("#save");
  await page.waitForTimeout(200);
  const errs = await page.evaluate(() => window.__modelErrors ?? []);
  check(
    "the page's own model has every required value",
    errs.length === 0,
    `still required: ${errs.join(", ")} — visible in the box but never registered`
  );

  /* --- 2. no LinkedIn in the profile means no LinkedIn on the form --- */
  check("the LinkedIn box is left blank when the profile has no URL", (await v("li")) === "", `got "${await v("li")}"`);
  await page.close();
}

/* --- 3. a drafted sentence never reaches a URL field --- */
{
  const page = await fill({ premium: true, aiAnswer: "I do not have a LinkedIn profile or social network account" });
  check(
    "a drafted sentence is not written into the LinkedIn box",
    (await page.inputValue("#li")) === "",
    `got "${await page.inputValue("#li")}" — Workday rejects this as an invalid URL`
  );
  await page.close();
}

/* --- 4. a real URL from the model is still accepted --- */
{
  const page = await fill({ premium: true, aiAnswer: "https://www.linkedin.com/in/madhu-kumar" });
  check(
    "a real URL from the model is accepted",
    (await page.inputValue("#li")) === "https://www.linkedin.com/in/madhu-kumar",
    `got "${await page.inputValue("#li")}"`
  );
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
