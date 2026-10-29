/**
 * Ashby: Yes / No questions drawn as two buttons.
 *
 *   node test/ashby-yesno.spec.mjs
 *
 * Reported from jobs.ashbyhq.com/chainalysis-careers: "Are you legally
 * authorized to work…", "Will you now or in the future require sponsorship…"
 * and "Have you been previously employed by Chainalysis…" were left blank, and
 * not even outlined. Ashby draws each one as a Yes and a No <button> with a
 * zero-size checkbox beside them that mirrors the pressed button; that
 * checkbox made the row look like "buttons plus another control", so it was
 * never recognised as one question. The fixture paints the pressed button on
 * the next render, as Ashby does, and refuses to submit an unanswered row.
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
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", previouslyEmployedHere: "No" },
  eeo: {},
  experience: [{ company: "Microsoft", title: "Senior DevOps Engineer", startDate: "2022-01", current: true }],
  education: [], documents: [],
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));
await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  window.__held = [];
  const session = { profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
  window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
    if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
    const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
      : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
    setTimeout(() => cb && cb(r), 0);
  }, onMessage: { addListener() {} } } };
}, { profile: PROFILE });
await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
await page.goto("https://jobs.ashbyhq.com/chainalysis-careers/81cc6986-9330-441a-8611-0edd84cea5b1/application");
await page.setContent(await readFile(join(ROOT, "test/fixtures/ashby-yesno.html"), "utf8"));
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(150);

console.log("\nwhat is collected");
const collected = await page.evaluate(() =>
  window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map((f) => ({
    tag: f.el.tagName, type: f.el.type || "", kind: f.kind, rule: f.rule?.key ?? null,
    q: f.el.closest("[data-q]")?.dataset.q ?? null,
  })));
const row = (q) => collected.filter((f) => f.q === q);
check("each Yes / No row is one question", ["auth", "sponsor", "prior", "other", "noncompete"].every((q) => row(q).length === 1),
  JSON.stringify(collected.filter((f) => f.q && f.q !== "tz")));
check("  collected as a choice, not as buttons", ["auth", "sponsor", "prior", "other"].every((q) => row(q)[0]?.kind === "radio"),
  JSON.stringify(collected));
check("  the mirror checkbox is never a field of its own", !collected.some((f) => f.type === "checkbox"), JSON.stringify(collected));
check("work authorization is read as such", row("auth")[0]?.rule === "authorizedToWork", JSON.stringify(row("auth")));
check("sponsorship is read as such", row("sponsor")[0]?.rule === "requireSponsorship", JSON.stringify(row("sponsor")));
check("\"previously employed by Chainalysis\" is read as such", row("prior")[0]?.rule === "previouslyEmployed", JSON.stringify(row("prior")));
check("\"considered for other opportunities\" is read as such", row("other")[0]?.rule === "otherOpportunities", JSON.stringify(row("other")));

console.log("\nfill");
const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
await page.waitForTimeout(400);
const s = await page.evaluate(() => {
  const pressed = (q) => {
    const b = document.querySelector(`[data-q="${q}"] button._active_1v5e2_12`);
    return b ? b.textContent.trim() : null;
  };
  const outlined = (q) => Boolean(document.querySelector(`[data-q="${q}"] .applifill-needs-you`));
  const drafted = (q) => Boolean(document.querySelector(`[data-q="${q}"] .applifill-drafted`));
  return {
    auth: pressed("auth"), sponsor: pressed("sponsor"), prior: pressed("prior"), other: pressed("other"),
    noncompete: pressed("noncompete"),
    mirrors: Array.from(document.querySelectorAll("._yesno_hkyf8_143 input")).map((i) => i.checked),
    noncompeteOutlined: outlined("noncompete"), otherDrafted: drafted("other"),
    authOutlined: outlined("auth"),
    name: document.getElementById("_systemfield_name").value,
    held: window.__held.map((h) => `${h.question} = ${h.answer}`),
  };
});
check("Are you legally authorized… = Yes", s.auth === "Yes", `pressed=${s.auth}`);
check("Will you require sponsorship… = No", s.sponsor === "No", `pressed=${s.sponsor}`);
check("Previously employed by Chainalysis… = No", s.prior === "No", `pressed=${s.prior}`);
check("Considered for other opportunities = Yes", s.other === "Yes", `pressed=${s.other}`);
check("  shown as a draft to check", s.otherDrafted === true);
check("a question the profile cannot answer is left alone", s.noncompete === null, `pressed=${s.noncompete}`);
check("  and outlined for the applicant", s.noncompeteOutlined === true);
check("answered questions are not outlined", s.authOutlined === false);
check("the rest of the form still fills", s.name === "Pradeep Reddy", `name=${s.name}`);
check("nothing Appli-Fill pressed is offered as the applicant's answer", s.held.length === 0, JSON.stringify(s.held));
check("filled count includes the Yes / No rows", (result.filled ?? 0) >= 6, JSON.stringify(result));

console.log("\nsubmit");
await page.click("[data-q=noncompete] button:nth-of-type(2)");
await page.waitForTimeout(150);
await page.click(".ashby-application-form-submit-button");
await page.waitForTimeout(150);
const errors = await page.evaluate(() => window.__submitErrors);
check("the form submits with every Yes / No answered", Array.isArray(errors) && errors.length === 0, JSON.stringify(errors));

console.log("\nwhat the applicant changes by hand is still theirs");
await page.click("[data-q=other] button:nth-of-type(2)");
await page.waitForTimeout(700);
const held = await page.evaluate(() => window.__held.map((h) => ({ q: h.question, a: String(h.answer) })));
const other = held.filter((h) => /other opportunities/i.test(h.q)).pop();
check("changing Yes to No is held as their answer", other?.a === "No", JSON.stringify(held));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
