/**
 * Workday's apply flow: the account step, and values a late re-render wipes.
 *
 *   node test/workday-flow.spec.mjs
 *
 * Two reports:
 *
 *   1. Pressing Fill on the sign-in / create-account screen filled the email and
 *      nothing else — a password is not something to invent — which looks like
 *      the fill worked when nothing has happened.
 *
 *   2. Fields were filled, then Next reported them required, first and last name
 *      most often. Workday hydrates after first paint and re-renders those
 *      sections from its own still-empty model, wiping whatever was written
 *      before it finished. The fill had already reported success and never
 *      looked again.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", phone: "+1 630 555 0142" },
  workAuth: {}, eeo: {}, education: [], experience: [], documents: [],
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

async function load(fixture) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(m, cb) {
          const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
            : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
            : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile: PROFILE });
  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/" + fixture)).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(250);
  return page;
}

/* --- 1. the account step is left to the applicant --------------------- */
{
  const page = await load("workday-auth.html");
  const res = await page.evaluate(async () => await window.__applifill.run({ manual: true }));
  const vals = await page.evaluate(() => ({
    email: document.getElementById("a-email").value,
    pass: document.getElementById("a-pass").value,
    verify: document.getElementById("a-pass2").value,
  }));

  check("the account step gets the email filled in", vals.email === "madhu.ittech@gmail.com", `email = "${vals.email}"`);
  check("the run reports it as the account step", res?.data?.authPage === "createAccount", JSON.stringify(res?.data?.authPage));

  // A password Appli-Fill invented is a credential it cannot give back, so it never
  // writes one — that belongs to the browser or a password manager.
  check("no password is invented", vals.pass === "", `password = "${vals.pass}"`);
  check("no confirmation password is invented", vals.verify === "", `verify = "${vals.verify}"`);
  await page.close();
}

/* --- 2. values wiped by a late re-render come back -------------------- */
{
  const page = await load("workday-validate.html");
  await page.evaluate(async () => await window.__applifill.run({ manual: true }));

  // The fixture clears first and last name shortly after the first write, as
  // Workday does when it hydrates.
  await page.waitForTimeout(3200);

  check(
    "the page really did re-render and clear the fields",
    await page.evaluate(() => window.__hydrated === true),
    "the fixture never ran its wipe, so this case proves nothing"
  );

  check("first name survives the page's re-render", (await page.inputValue("#fn")) === "Madhu", `first = "${await page.inputValue("#fn")}"`);
  check("last name survives the page's re-render", (await page.inputValue("#ln")) === "Kumar", `last = "${await page.inputValue("#ln")}"`);

  await page.click("#next");
  await page.waitForTimeout(200);
  const errors = await page.evaluate(() => window.__validationErrors ?? []);
  check("Next reports no validation errors", errors.length === 0, `errors: ${errors.join(", ")}`);
  check("the page's own model has the names", await page.evaluate(() => Boolean(window.__model.fn && window.__model.ln)), await page.evaluate(() => JSON.stringify(window.__model)));

  // The restore must not fight the applicant.
  await page.fill("#fn", "Madhusudhan");
  await page.waitForTimeout(2600);
  check("a value the applicant typed is not overwritten", (await page.inputValue("#fn")) === "Madhusudhan", `first = "${await page.inputValue("#fn")}"`);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
