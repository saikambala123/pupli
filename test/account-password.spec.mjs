/**
 * Workday Create Account: the saved password, Pending, and the consent box.
 *
 *   node test/account-password.spec.mjs
 *
 * Reported from centric.wd501 with a screenshot: after Fill put the saved
 * password into Password and Verify New Password, the popup listed both as
 * "2 manual edits to review" — "Question: Password* · unsaved · Answer:
 * Pradeep@123" — the password in clear text. The boxes were written directly,
 * without the bookkeeping that marks a value as Appli-Fill's, so the applicant
 * having clicked into the box earlier was enough to make it "theirs".
 *
 * The same screenshot shows "Error: Please check the box to continue": the
 * form was submitted before the required "I consent" box was ticked.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  personal: { firstName: "Pradeep", lastName: "Beeram", email: "pradeep@example.com" },
  workAuth: {}, eeo: {}, experience: [], education: [], documents: [],
};
const SAVED_PASSWORD = { question: "Password", normalizedKey: "password", answer: "Pradeep@123", aliases: [] };

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-background-networking"] });

async function open({ responses = [SAVED_PASSWORD] } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    const session = { profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = {
      storage: { local: { get(_k, cb) { cb({ applifillAutoSubmitAccount: true }); }, set() {} } },
      runtime: { lastError: null, sendMessage(m, cb) {
        if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
        const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : m?.type === "APPLI_FILL_GET_ACCOUNT_SETTINGS" ? { ok: true, data: { applifillAutoSubmitAccount: true } }
          : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      }, onMessage: { addListener() {} } },
    };
  }, { profile: PROFILE, responses });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://centric.wd501.myworkdayjobs.com/en-US/centric/job/Senior-DevOps-Engineer_JR347/apply/applyManually");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/workday-create-account.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  return page;
}

const run = (page) => page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
const heldQuestions = (page) => page.evaluate(() => window.__held.map((h) => `${h.question} = ${h.inputType}`));

/* ------------------------------------------------------------------ */
console.log("\nThe saved password, filled by Appli-Fill, is not offered back as an edit");
{
  const page = await open();
  // The applicant clicked into Password before pressing Fill.
  await page.click("#a-pass");
  const result = await run(page);
  await page.waitForTimeout(3000);   // past the settle passes
  const values = await page.evaluate(() => [document.getElementById("a-pass").value, document.getElementById("a-pass2").value]);
  check("both password boxes get the saved password", values.every((v) => v === "Pradeep@123"), JSON.stringify(values));
  const held = await heldQuestions(page);
  check("neither is held as a manual edit", !held.some((q) => /password/i.test(q)), JSON.stringify(held));
  check("the form is not submitted while \"I consent\" is clear", (await page.evaluate(() => window.__rejected + window.__submits)) === 0);
  check("…and the popup is told why", result.consentNeeded === true && result.autoSubmitted === false, JSON.stringify(result));
  // Moving on through the form afterwards still does not make them edits.
  await page.click("#a-consent");
  await page.click("#a-email");
  await page.waitForTimeout(400);
  check("clicking around the form afterwards changes nothing", !(await heldQuestions(page)).some((q) => /password/i.test(q)));
  await page.close();
}

{
  const page = await open();
  await page.click("#a-consent");
  const result = await run(page);
  await page.waitForTimeout(300);
  check("with consent already ticked, Create Account is pressed once", (await page.evaluate(() => window.__submits)) === 1 && result.autoSubmitted === true,
    JSON.stringify(result));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nA password the applicant types is held once, as \"Password\"");
{
  // No saved password yet: Fill does the email, the applicant types the rest.
  const page = await open({ responses: [] });
  await run(page);
  await page.click("#a-pass");
  await page.keyboard.type("Fresh#Pass9");
  await page.click("#a-pass2");
  await page.keyboard.type("Fresh#Pass9");
  await page.click("#a-email");
  await page.waitForTimeout(600);
  const held = await heldQuestions(page);
  check("one entry, filed under \"Password\"", held.filter((q) => /password/i.test(q)).length === 1 && held.includes("Password = password"),
    JSON.stringify(held));
  check("the verify box is never held on its own", !held.some((q) => /verify/i.test(q)), JSON.stringify(held));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nThe popup never shows a password");
{
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.addInitScript(() => {
    const store = {
      apiBase: "https://applifill.test", stats: { applications: 1 },
      heldAnswers: [{ question: "Password", answer: "Pradeep@123", inputType: "password", options: [], editedAt: 1 }],
      pendingResponses: [],
    };
    const session = { premium: false, profile: { _id: "p1", label: "Default" }, profiles: [{ _id: "p1", label: "Default" }],
      responses: [], settings: {} };
    window.chrome = {
      runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage(msg, cb) {
        const reply = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_GET_HELD" ? { ok: true, data: { held: store.heldAnswers } }
          : msg?.type === "APPLI_FILL_GET_PENDING" ? { ok: true, data: { responses: [] } } : { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      } },
      storage: { local: { get(_k, cb) { cb(store); }, set() {}, remove() {} }, onChanged: { addListener() {} } },
      tabs: { query: () => Promise.resolve([{ id: 1, url: "https://centric.wd501.myworkdayjobs.com/x" }]),
        sendMessage(_i, _m, cb) { cb && cb({ ok: true, isApplication: false }); }, create() {} },
    };
  });
  await page.goto(pathToFileURL(join(EXT, "popup/popup.html")).href);
  await page.waitForTimeout(500);
  const text = await page.evaluate(() => document.getElementById("pending-list")?.innerText ?? "");
  check("the held password is listed", /Password/.test(text), text);
  check("…but its value is masked", !text.includes("Pradeep@123") && /•{8,}/.test(text), text);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
