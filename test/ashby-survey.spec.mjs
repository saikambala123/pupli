/**
 * Ashby: the voluntary demographic survey.
 *
 *   node test/ashby-survey.spec.mjs
 *
 * Reported from jobs.ashbyhq.com/chainalysis-careers: Veteran Status filled,
 * but "Do you live with a disability?" was left blank for a profile holding
 * "No, I don't have a disability", and "Sexual Orientation" (a type-to-search
 * list) was outlined — the profile had nowhere to keep it.
 *
 * Chainalysis words the No as "No, I don’t have a disability or have a
 * history/record of having a disability". The Yes patterns were tested first,
 * "or have a history" is one of them, and the No option was read as a Yes:
 * both options sat on the Yes branch and a No answer matched neither. The
 * survey's introduction ("If you need an accommodation because of a
 * disability…") also travelled with every question under it, and the
 * disability rule refused anything whose label mentioned an accommodation.
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

const profileWith = (eeo) => ({
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", country: "United States" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No" },
  eeo,
  experience: [], education: [], documents: [],
});

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function open(profile, { orientations = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, orientations }) => {
    window.__APPLI_FILL_TEST = true;
    window.__held = [];
    if (orientations) window.__ORIENTATIONS = orientations;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, orientations });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://jobs.ashbyhq.com/chainalysis-careers/81cc6986-9330-441a-8611-0edd84cea5b1/application?jr_id=6ab6ee6f81e327c4bf201ded");
  await page.setContent(await readFile(join(ROOT, "test/fixtures/ashby-survey.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  return page;
}

async function fillAndSubmit(page) {
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(500);
  await page.click(".ashby-application-form-submit-button");
  await page.waitForTimeout(100);
  return page.evaluate((result) => ({
    ...window.__submitted,
    result,
    outlined: Array.from(document.querySelectorAll(".applifill-needs-you")).map((n) => n.closest("[data-q]")?.dataset.q ?? n.id),
    held: window.__held.map((h) => `${h.question} = ${h.answer}`),
  }), result);
}

const NO_DISABILITY = "No, I don’t have a disability or have a history/record of having a disability";
const YES_DISABILITY = "Yes, I have a disability or have a history/ record of having a disability";
const DECLINE = "I don’t wish to answer";

console.log("\nreading the survey's answers");
{
  const page = await open(profileWith({}));
  const ids = await page.evaluate(({ NO_DISABILITY, YES_DISABILITY, DECLINE }) => {
    const { M } = window.__applifill;
    const hint = "Do you live with a disability?";
    return {
      no: M.eeoId(NO_DISABILITY, hint), yes: M.eeoId(YES_DISABILITY, hint), decline: M.eeoId(DECLINE, hint),
      profileNo: M.eeoId("No, I don't have a disability", hint), profileYes: M.eeoId("Yes, I have a disability", hint),
      longNo: M.eeoId("No, I do not have a disability and have not had one in the past", hint),
      longYes: M.eeoId("Yes, I have a disability (or previously had a disability)", hint),
    };
  }, { NO_DISABILITY, YES_DISABILITY, DECLINE });
  check("\"No, I don’t have a disability or have a history/record…\" is a No", ids.no === "disability:no", JSON.stringify(ids));
  check("\"Yes, I have a disability or have a history/ record…\" is a Yes", ids.yes === "disability:yes", JSON.stringify(ids));
  check("\"I don’t wish to answer\" (typographic apostrophe) is a decline", ids.decline === "decline", JSON.stringify(ids));
  check("the profile's own wordings keep their meaning", ids.profileNo === "disability:no" && ids.profileYes === "disability:yes" &&
    ids.longNo === "disability:no" && ids.longYes === "disability:yes", JSON.stringify(ids));

  const rules = await page.evaluate(() => window.__applifill.collectFields(window.APPLI_FILL_ATS.detect())
    .map((f) => ({ q: f.el.closest("[data-q]")?.dataset.q ?? null, rule: f.rule?.key ?? null }))
    .filter((f) => f.q));
  const ruleOf = (q) => rules.find((f) => f.q === q)?.rule ?? null;
  check("Do you live with a disability? is the disability question, under an introduction about accommodations",
    ruleOf("disability") === "disabilityStatus", JSON.stringify(rules));
  check("Sexual Orientation is its own question", ruleOf("orientation") === "sexualOrientation", JSON.stringify(rules));
  check("Do you identify as transgender? is its own question", ruleOf("trans") === "transgender", JSON.stringify(rules));
  check("Gender Identity is still the gender question", ruleOf("gender") === "gender", JSON.stringify(rules));
  check("Veteran Status is still the veteran question", ruleOf("veteran") === "veteranStatus", JSON.stringify(rules));
  check("the feedback question about the survey is not an EEO question",
    !["disabilityStatus", "sexualOrientation", "transgender", "gender", "veteranStatus"].includes(ruleOf("feedback")), JSON.stringify(rules));

  // Where the introduction does travel with the question in its label.
  const ruled = await page.evaluate(() => {
    const { M, RULES } = window.__applifill;
    const el = document.querySelector('input[name="2d44-survey-disability"]');
    const key = (label) => M.matchRule(el, label, RULES)?.key ?? null;
    return {
      leaked: key("Do you live with a disability? | Voluntary Self-Identification | If you need an accommodation because of a disability at any point in the hiring process, contact accommodations@chainalysis.com."),
      request: key("Will you need a reasonable accommodation during the interview process? | Disability"),
      own: key("Do you have a disability that requires an accommodation?"),
    };
  });
  check("an introduction about accommodations does not take the disability question away", ruled.leaked === "disabilityStatus", JSON.stringify(ruled));
  check("  an accommodation request is still not the disability question", ruled.request !== "disabilityStatus" && ruled.own !== "disabilityStatus", JSON.stringify(ruled));
  await page.close();
}

console.log("\na profile with every answer");
{
  const page = await open(profileWith({
    gender: "Male", veteranStatus: "I am not a protected veteran", disabilityStatus: "No, I don't have a disability",
    sexualOrientation: "Heterosexual", transgender: "No",
  }));
  const s = await fillAndSubmit(page);
  check("Do you live with a disability? = No", s.disability === NO_DISABILITY, `= ${s.disability}`);
  check("Sexual Orientation = Heterosexual, picked from Ashby's list", s.orientation === "Heterosexual", `= ${s.orientation}`);
  check("Do you identify as transgender? = No", s.trans === "No", `= ${s.trans}`);
  check("Gender Identity = Man", s.gender === "Man", `= ${s.gender}`);
  check("Veteran Status = I am not a protected Veteran", s.veteran === "I am not a protected Veteran", `= ${s.veteran}`);
  check("the feedback question is left alone", s.feedback === null, `= ${s.feedback}`);
  check("no survey question is outlined", !s.outlined.some((q) => ["disability", "orientation", "trans", "gender", "veteran"].includes(q)), JSON.stringify(s.outlined));
  check("nothing Appli-Fill answered is offered as the applicant's", s.held.length === 0, JSON.stringify(s.held));
  await page.close();
}

console.log("\nYes to the disability question");
{
  const page = await open(profileWith({ disabilityStatus: "Yes, I have a disability" }));
  const s = await fillAndSubmit(page);
  check("Do you live with a disability? = Yes", s.disability === YES_DISABILITY, `= ${s.disability}`);
  await page.close();
}

console.log("\ndeclining to self-identify");
{
  const page = await open(profileWith({ declineToSelfIdentify: true }));
  const s = await fillAndSubmit(page);
  check("disability declined", s.disability === DECLINE, `= ${s.disability}`);
  check("sexual orientation declined", s.orientation === DECLINE, `= ${s.orientation}`);
  check("transgender declined", s.trans === DECLINE, `= ${s.trans}`);
  check("veteran status declined", s.veteran === DECLINE, `= ${s.veteran}`);
  check("gender declined", s.gender === DECLINE, `= ${s.gender}`);
  check("the feedback question is still left alone", s.feedback === null, `= ${s.feedback}`);
  await page.close();
}

console.log("\n\"Prefer not to say\" for the two new questions only");
{
  const page = await open(profileWith({ sexualOrientation: "Prefer not to say", transgender: "Prefer not to say" }));
  const s = await fillAndSubmit(page);
  check("sexual orientation: I don’t wish to answer", s.orientation === DECLINE, `= ${s.orientation}`);
  check("transgender: I don’t wish to answer", s.trans === DECLINE, `= ${s.trans}`);
  await page.close();
}

console.log("\nanother survey's wording of the orientations");
for (const [value, expect] of [["Gay", "Gay or Lesbian"], ["Heterosexual", "Straight/Heterosexual"], ["Pansexual", "Bisexual and/or pansexual"]]) {
  const page = await open(profileWith({ sexualOrientation: value }), {
    orientations: ["Asexual", "Bisexual and/or pansexual", "Gay or Lesbian", "Queer", "Straight/Heterosexual",
      "I prefer to self-describe", "I don’t wish to answer"],
  });
  const s = await fillAndSubmit(page);
  check(`${value} → ${expect}`, s.orientation === expect, `= ${s.orientation}`);
  await page.close();
}

console.log("\nnothing saved for the survey");
{
  const page = await open(profileWith({}));
  const s = await fillAndSubmit(page);
  check("nothing is guessed", [s.disability, s.orientation, s.trans, s.veteran, s.gender, s.feedback].every((v) => v === null),
    JSON.stringify(s));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
