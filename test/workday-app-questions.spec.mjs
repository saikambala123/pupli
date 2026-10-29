/**
 * A Workday "Application Questions" page, filled end to end.
 *
 *   node test/workday-app-questions.spec.mjs
 *
 * Reported against 1.16.0: "application questions are not filling … they
 * should fill accurate values using profile data and saved answers data and
 * using AI accurate answers by analyzing fastly, should not delay".
 *
 * What the old build did with this page: five questions left blank, three
 * answered wrongly (worked at Leidos → "No", relatives at Leidos → "Yes",
 * currently employed → "No"), twelve separate AI requests taking 17 seconds
 * at a realistic model latency — and several of those requests carried the
 * options of a *different* menu, because four Workday menus were opened at
 * once to read them.
 *
 * The answer service is stubbed here: it answers from a fixed table and
 * records what it was asked, so these checks pin the contract — which
 * questions reach the model, with which options, in how many requests — and
 * what is done with the replies.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const FIXTURE = join(ROOT, "test/fixtures/workday-app-questions.html");
const URL = "https://leidos.wd5.myworkdayjobs.com/en-US/External/job/Reston-VA/Cloud-Engineer_R-00123456/apply/applyManually";

const Q = (n) => `primaryQuestionnaire--4c7d1e2f3a4b5c6d7e8f9a0b1c2d3e${String(n).padStart(2, "0")}`;
const WHY = "secondaryQuestionnaire--9a1b0c2d3e4f5a6b7c8d9e0f1a2b3c03";
const SALARY = "secondaryQuestionnaire--9a1b0c2d3e4f5a6b7c8d9e0f1a2b3c04";

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com", phone: "6305550142",
    city: "Stanley", state: "NC", zip: "28164", country: "United States", citizenship: "United States",
  },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", previouslyEmployedHere: "No",
    willingToRelocate: "Yes", willingToDrugTest: "Yes", willingToBackgroundCheck: "Yes",
    securityClearance: "None", workAuthType: "U.S. Citizen",
  },
  compensation: { desiredSalary: "145000" },
  eeo: {},
  experience: [
    { company: "Amazon Web Services", title: "Cloud Engineer", startDate: "2021-05", current: true, location: "" },
    { company: "Leidos, Inc.", title: "Systems Engineer", startDate: "2018-06", endDate: "2021-04", location: "Reston, VA" },
    { company: "U.S. Army", title: "Signal Support Specialist", startDate: "2012-01", endDate: "2016-12" },
  ],
  education: [{ school: "University of North Carolina at Charlotte", degree: "Master of Science", fieldOfStudy: "Computer Science", endDate: "2018-05" }],
  skills: ["AWS", "Kubernetes", "Terraform", "Python"],
};

/** Saved on an earlier GDIT application. */
const SAVED = [
  { question: "Do you have any relatives currently employed by GDIT?", answer: "No", aliases: [], lastDomain: "gdit.wd5.myworkdayjobs.com", inputType: "select" },
];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});

/**
 * `service`: "batch" (the current route), "legacy" (a worker that predates
 * batches: the batch message is unknown), "down" (the batch fails outright).
 */
async function fill({ profile = PROFILE, responses = SAVED, settings = {}, premium = true, delay = 300, service = "batch", others = [], scoreDelay = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  // The profile's dates were written in September 2026 ("2021 to now" is five
  // years and four months), so the years questions are asked on that day —
  // not on whatever day the suite happens to run.
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00"));
  await page.addInitScript(({ profile, responses, settings, premium, delay, service, others, scoreDelay }) => {
    window.__APPLI_FILL_TEST = true;
    window.__calls = [];
    window.__writes = [];
    window.__scores = 0;
    const session = {
      profile, profiles: [profile, ...others], responses, premium,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false, ...settings },
    };
    const answerFor = (q) => {
      const text = String(q.question || "");
      if (/travel/i.test(text)) return "Yes";
      if (/essential functions/i.test(text)) return "Yes";
      if (/non-compete|non-solicitation/i.test(text)) return "No";
      if (/years of professional cloud/i.test(text)) return "6-10 years";   // answered from the profile instead
      if (/work arrangement/i.test(text)) return "Hybrid";
      if (/why are you interested/i.test(text)) return "I run production AWS platforms and want to bring that to Leidos's cloud programs.";
      if (/on-site/i.test(text)) return "Yes";
      if (/cloud platforms/i.test(text)) return ["Amazon Web Services"];
      if (/felony/i.test(text)) return "No";   // must never be asked
      return "";
    };
    window.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage(m, cb) {
          let reply = { ok: true, data: {} };
          let wait = 0;
          if (m?.type === "APPLI_FILL_GET_SESSION") reply = { ok: true, data: session };
          else if (m?.type === "APPLI_FILL_CHECK") reply = { ok: true, data: { duplicate: false } };
          else if (m?.type === "APPLI_FILL_SCORE") {
            // Profile scoring prefers the last profile on the account.
            window.__scores++;
            const best = session.profiles[session.profiles.length - 1];
            reply = { ok: true, data: { best: { profileId: best._id, score: 91, reason: "closest match" } } };
            wait = scoreDelay;
          }
          else if (m?.type === "APPLI_FILL_ANSWER_BATCH") {
            window.__calls.push({ type: m.type, at: performance.now(), questions: m.payload.questions });
            wait = delay;
            if (service === "legacy") reply = { ok: false, error: "Unknown message." };
            else if (service === "down") reply = { ok: false, error: "Too many attempts. Try again in 12 minutes." };
            else reply = { ok: true, data: { answers: m.payload.questions.map((q) => ({ id: q.id, answer: answerFor(q) })) } };
          } else if (m?.type === "APPLI_FILL_ANSWER") {
            window.__calls.push({ type: m.type, at: performance.now(), questions: [m.payload] });
            wait = delay;
            reply = { ok: true, data: { answer: answerFor(m.payload) } };
          }
          setTimeout(() => cb && cb(reply), wait);
        },
      },
    };
  }, { profile, responses, settings, premium, delay, service, others, scoreDelay });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(FIXTURE, "utf8"), { waitUntil: "domcontentloaded" });
  // When each menu got its value, to see what overlapped with what. Attached
  // after setContent, which replaces the document and its listeners.
  await page.evaluate(() => {
    document.addEventListener("change", (e) => {
      const id = e.target?.id || e.target?.name || "";
      window.__writes.push({ id, at: performance.now() });
    }, true);
  });
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  const shown = (id) => page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) return null;
    return el.tagName === "BUTTON" ? el.textContent.trim() : el.value;
  }, id);
  const state = await page.evaluate(() => ({
    calls: window.__calls,
    writes: window.__writes,
    flagged: Array.from(document.querySelectorAll(".applifill-needs-you")).map((el) => el.id || el.name),
    drafted: Array.from(document.querySelectorAll(".applifill-drafted")).map((el) => el.id || el.name),
    onsite: document.querySelector("input[name^='secondaryQuestionnaire--9a1b']:checked")?.nextElementSibling?.textContent ?? null,
    clouds: Array.from(document.querySelectorAll("input[name=clouds]:checked")).map((c) => c.nextElementSibling.textContent),
  }));
  return { page, result, ms, shown, ...state };
}

const asked = (run) => run.calls.flatMap((c) => c.questions.map((q) => q.question));

/* ------------------------------------------------------------------ */
console.log("\nFrom the profile and saved answers — no model needed");

{
  const run = await fill({ premium: false });
  const v = (n) => run.shown(Q(n));
  check("work authorization → Yes", (await v(1)) === "Yes", `got ${await v(1)}`);
  check("Workday's sponsorship wording → No (from the profile)", (await v(2)) === "No", `got ${await v(2)}`);
  check("at least 18 → Yes", (await v(3)) === "Yes", `got ${await v(3)}`);
  check("previously employed by Leidos → Yes (Leidos is on the work history)", (await v(4)) === "Yes", `got ${await v(4)}`);
  check("federal government, military or civilian → Yes (U.S. Army on the history)", (await v(5)) === "Yes", `got ${await v(5)}`);
  check("active clearance, profile None → No", (await v(6)) === "No", `got ${await v(6)}`);
  check("able to obtain a clearance, U.S. citizen → Yes", (await v(7)) === "Yes", `got ${await v(7)}`);
  check("relatives at Leidos → No (the answer saved for GDIT's identical question)", (await v(9)) === "No", `got ${await v(9)}`);
  check("currently employed → Yes (a current job on the history)", (await v(11)) === "Yes", `got ${await v(11)}`);
  check("highest education → Master's Degree", (await v(12)) === "Master's Degree", `got ${await v(12)}`);
  check("years of cloud engineering → 2-5 years (the Cloud Engineer role, 2021 to now)",
    (await v(13)) === "2-5 years", `got ${await v(13)}`);
  check("salary expectations → the desired salary", (await run.shown(SALARY)) === "145000", `got ${await run.shown(SALARY)}`);
  check("an answer read off the history is shown as a draft to review", run.drafted.includes(Q(5)), `drafted: ${run.drafted.join(", ")}`);
  check("without Premium the model is never called", run.calls.length === 0, `${run.calls.length} calls`);
  check("the questions only the applicant or the model can answer are highlighted",
    [8, 10, 14, 15, 16].every((n) => run.flagged.includes(Q(n))), `flagged: ${run.flagged.join(", ")}`);
  check("the popup is told why they were not drafted", run.result.aiSkipped === "premium", `aiSkipped=${run.result.aiSkipped}`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nThe rest in one request, while the form fills");

{
  const run = await fill({ delay: 1500 });
  const v = (n) => run.shown(Q(n));
  check("one request for the whole page", run.calls.length === 1 && run.calls[0].type === "APPLI_FILL_ANSWER_BATCH",
    run.calls.map((c) => c.type).join(", "));
  const questions = run.calls[0]?.questions ?? [];
  const sent = questions.map((q) => q.question);
  check("it carries only what the profile and saved answers could not answer",
    sent.length === 6 && sent.every((q) => !/authorized|sponsor|18 years|Leidos or any|Federal|security clearance|relatives|currently employed\?|highest level|years of professional|felony|salary|non-compete/i.test(q)),
    JSON.stringify(sent));
  check("a felony question is never put to the model", !sent.some((q) => /felony/i.test(q)));
  const arrangement = questions.find((q) => /work arrangement/i.test(q.question));
  check("each menu is sent with its own options",
    JSON.stringify(arrangement?.options) === JSON.stringify(["On-site", "Hybrid", "Remote"]),
    JSON.stringify(arrangement?.options));
  check("every yes/no menu is sent with Yes and No",
    questions.filter((q) => q.fieldType === "select" && !/arrangement/i.test(q.question)).every((q) => JSON.stringify(q.options) === '["Yes","No"]'),
    JSON.stringify(questions.map((q) => q.options)));
  check("the checkbox list is sent as a multi-select", questions.some((q) => /cloud platforms/i.test(q.question) && q.multiple === true));
  check("travel → Yes (drafted)", (await v(8)) === "Yes", `got ${await v(8)}`);
  check("non-compete without a profile or saved answer stays unanswered", (await v(10)) === "Select One", `got ${await v(10)}`);
  check("work arrangement → Hybrid (drafted)", (await v(16)) === "Hybrid", `got ${await v(16)}`);
  check("essential functions → Yes (drafted)", (await v(14)) === "Yes", `got ${await v(14)}`);
  check("on-site radio → Yes", run.onsite === "Yes", `got ${run.onsite}`);
  check("cloud platforms → Amazon Web Services", JSON.stringify(run.clouds) === '["Amazon Web Services"]', JSON.stringify(run.clouds));
  check("why this role → the drafted paragraph", /AWS platforms/.test(await run.shown(WHY)), await run.shown(WHY));
  check("felony stays blank and highlighted", (await v(15)) === "Select One" && run.flagged.includes(Q(15)), `got ${await v(15)}`);
  check("the drafted answers are marked as drafts", [8, 14, 16].every((n) => run.drafted.includes(Q(n))) && !run.drafted.includes(Q(10)), run.drafted.join(", "));
  check("six answers drafted, two declarations left for the applicant",
    run.result.drafted === 6 && run.result.unmatched === 2, `drafted=${run.result.drafted} unmatched=${run.result.unmatched}`);

  // Known answers finish before AI option collection can open unknown menus.
  // The model still overlaps the source picker and reconciliation work.
  const sentAt = run.calls[0]?.at ?? Infinity;
  const profileWrites = run.writes.filter((w) => [Q(1), Q(2), Q(3), Q(4), Q(12)].includes(w.id));
  check("known profile answers finish before the AI request",
    profileWrites.length >= 3 && profileWrites.every((w) => w.at < sentAt),
    `sent ${Math.round(sentAt)}ms; writes ${profileWrites.map((w) => Math.round(w.at)).join(", ")}`);
  check(`the whole page fills in ${run.ms}ms with a 1.5s model — well under the old per-question wait`, run.ms < 6000, `${run.ms}ms`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nThe applicant's own answers come first");

{
  const run = await fill({
    responses: [
      ...SAVED,
      { question: "Are you willing to travel up to 25% of the time?", answer: "No", aliases: [] },
      { question: "Have you ever been employed by the U.S. Federal Government (military or civilian)?", answer: "No", aliases: [] },
    ],
  });
  check("an exact saved answer beats the model", (await run.shown(Q(8))) === "No", `got ${await run.shown(Q(8))}`);
  check("an exact saved answer beats the history", (await run.shown(Q(5))) === "No", `got ${await run.shown(Q(5))}`);
  check("and the model is not asked about either", !asked(run).some((q) => /travel|Federal/i.test(q)), JSON.stringify(asked(run)));
  await run.page.close();
}

{
  // A saved answer from another employer is carried only as a choice, and
  // only when the question is the same once the names are set aside.
  const run = await fill({
    premium: false,
    responses: [
      { question: "Do you have any relatives currently employed by GDIT?", answer: "Yes — my brother works at GDIT", aliases: [], lastDomain: "gdit.wd5.myworkdayjobs.com" },
      { question: "Are you bound by a non-compete agreement with GDIT?", answer: "No", aliases: [], lastDomain: "gdit.wd5.myworkdayjobs.com" },
    ],
  });
  check("an answer that names the other employer is not carried across",
    (await run.shown(Q(9))) === "Select One", `got ${await run.shown(Q(9))}`);
  check("a different question is not matched just because a name was removed",
    (await run.shown(Q(10))) === "Select One", `got ${await run.shown(Q(10))}`);
  await run.page.close();
}

{
  const run = await fill({
    premium: false,
    responses: [{ question: "Do you have any relatives currently employed by GDIT?", answer: "No", aliases: [], lastDomain: "gdit.wd5.myworkdayjobs.com" }],
    profile: { ...PROFILE, experience: [{ company: "GDIT", title: "Analyst", startDate: "2015-01", endDate: "2016-01" }] },
  });
  check("a history without Leidos → the stored No for Leidos", (await run.shown(Q(4))) === "No", `got ${await run.shown(Q(4))}`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nWhen the answer service is unavailable or older");

{
  const run = await fill({ service: "legacy", delay: 200 });
  const single = run.calls.filter((c) => c.type === "APPLI_FILL_ANSWER");
  check("an older service is asked one question at a time", single.length === 6, `${single.length} single calls`);
  check("…each with its own menu's options",
    single.every((c) => {
      const q = c.questions[0];
      if (/work arrangement/i.test(q.question)) return JSON.stringify(q.options) === '["On-site","Hybrid","Remote"]';
      if (q.fieldType === "select") return JSON.stringify(q.options) === '["Yes","No"]';
      return true;
    }), JSON.stringify(single.map((c) => [c.questions[0].question.slice(0, 30), c.questions[0].options])));
  check("…and the answers still land", (await run.shown(Q(8))) === "Yes" && (await run.shown(Q(16))) === "Hybrid");
  await run.page.close();
}

{
  const run = await fill({ service: "down" });
  check("a refused request is not retried question by question", run.calls.length === 1, `${run.calls.length} calls`);
  check("the reason is reported", /Too many attempts/.test(run.result.aiError ?? ""), `aiError=${run.result.aiError}`);
  check("the profile's answers are all still there", (await run.shown(Q(4))) === "Yes" && (await run.shown(Q(12))) === "Master's Degree");
  check("the rest are highlighted", [8, 10, 14, 16].every((n) => run.flagged.includes(Q(n))), run.flagged.join(", "));
  await run.page.close();
}

{
  const run = await fill({ settings: { aiAnswers: false } });
  check("switched off → never called", run.calls.length === 0 && run.result.aiSkipped === "off", `calls=${run.calls.length} skipped=${run.result.aiSkipped}`);
  await run.page.close();
}

{
  const run = await fill({ settings: {} });
  check("a sync without the setting reads as on", run.calls.length === 1, `calls=${run.calls.length}`);
  await run.page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nChoosing between profiles never holds up the fill");

{
  const OTHER = { ...PROFILE, _id: "p2", label: "Contract roles", compensation: { desiredSalary: "95/hour" } };
  const slow = await fill({ others: [OTHER], scoreDelay: 12000, delay: 100 });
  check(`a slow scoring call is not waited on (${slow.ms}ms)`, slow.ms < 8000, `${slow.ms}ms`);
  check("…the active profile is used meanwhile", (await slow.shown(SALARY)) === "145000", `salary ${await slow.shown(SALARY)}`);
  const again = await slow.page.evaluate(async () => {
    await window.__applifill.run({ manual: true });
    return window.__scores;
  });
  check("the next step of the same application does not score again", again === 1, `${again} scoring calls`);
  await slow.page.close();

  const quick = await fill({ others: [OTHER], scoreDelay: 50, delay: 100 });
  check("a prompt score picks the better-matching profile", (await quick.shown(SALARY)) === "95/hour", `salary ${await quick.shown(SALARY)}`);
  await quick.page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
