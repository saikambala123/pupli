/**
 * Workday: SEI's "Application Questions" step.
 *
 *   node test/workday-sei-questions.spec.mjs
 *
 * Reported from seic.wd1.myworkdayjobs.com: with "Immediately" as the profile's
 * available start date, Available Start Date came back "01/DD/2022" and Workday
 * said "Error: Invalid Date: 01//2022"; "Do you wish to be considered for other
 * opportunities?" and the base-salary question were left for the applicant.
 *
 * Workday prints each question's label in an element that passes for a
 * heading, and the question's block is short enough to pass for a heading's
 * wrapper. "Employment Type Desired" was therefore read as the heading of every
 * question below it: its "employment" denied Available Start Date to the
 * availability rule and gave it to the work-history date rule, which wrote the
 * current job's start (January 2022) — month and year, no day. And
 * "Immediately" itself was never understood as a date.
 *
 * Reported again on 1.20.0: Available Start Date came back "01/01/2000". Each
 * of the three boxes had been handed the whole date, so the first box wrote
 * all three in one go — and Workday's date widget, a React component, applies
 * each box's change to the date as it last rendered, which it does not do
 * again until the script yields. The boxes written in one go were lost. The
 * fixture's widget now behaves that way; each box gets its own part and is
 * written on its own, and a profile with no start date (or none a calendar
 * can hold) gets today's date.
 *
 * Reported a third time on 1.21.0, still "01/01/2000", identically. That is
 * what a saved answer does: a start date banked off an earlier Workday form
 * answered the exact question on every application after it, ahead of the
 * profile. Start-date boxes now take only the profile's date or today's, a
 * date already past in the boxes is replaced, and the date is typed like a
 * person types it and read back — never left wrong.
 *
 * Reported on 1.23.0: Available Start Date empty. The real cause of all of it
 * was another box. SEI's questions can sit inside one role="group", and every
 * box in that group was taken for part of the date. The bonus question's
 * answer, "20000", was read as the year 20000 and typed over the date as
 * 01/01/0000, which Workday shows as 01/01/2000 (1.21.0). From 1.22.0 on, the
 * date read back wrong and was emptied (1.23.0). Only the date's own boxes are
 * the date now, "20000" is not a date, and a date that will not show is left
 * for the applicant to see — never emptied.
 *
 * Reported again on 1.24.0: 01/01/2000, with no other box involved. When the
 * date did not take on Workday, 1.24.0 tried the arrow keys — and from an
 * empty box Workday's ArrowUp gives the box its first value: 01, 01, 2000.
 * The arrow keys are gone. The date is picked from Workday's own calendar
 * (today is `datePickerSelectedToday`), which is the page setting its own
 * date; typing follows only when there is no calendar, each keystroke whole
 * (keydown, keypress, beforeinput, textInput, input, keyup). A date already in
 * the boxes — the 01/01/2000 left by 1.24.0 — is cleared first, so the
 * calendar opens on this month; boxes that refuse Backspace keep it, and the
 * calendar is turned from January 2000 to this month instead.
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

const profileWith = (availableStartDate) => ({
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", email: "pradeepbeeram91@gmail.com", phone: "516-205-8456",
    city: "Jacksonville", state: "FL", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", availableStartDate },
  compensation: { desiredSalary: "165000" },
  eeo: {},
  experience: [
    { company: "Microsoft", title: "Senior DevOps Engineer", employmentType: "Full-time", startDate: "2022-01", current: true },
    { company: "Infosys", title: "DevOps Engineer", employmentType: "Contract", startDate: "2018-03", endDate: "2021-12" },
  ],
  education: [], documents: [],
});

const pad = (n) => String(n).padStart(2, "0");
const mdy = (d) => ({ m: pad(d.getMonth() + 1), d: pad(d.getDate()), y: String(d.getFullYear()) });
const inDays = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function open({ variant = "formLabel", profile, responses = [], widget = null, prefill = null, grouped = false, noCalendar = false }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, variant, responses, widget, prefill, grouped, noCalendar }) => {
    window.__APPLI_FILL_TEST = true;
    window.__SEI_VARIANT = variant;
    if (widget) window.__DATE_WIDGET = widget;
    if (prefill) window.__DATE_PREFILL = prefill;
    if (grouped) window.__SEI_GROUPED = true;
    if (noCalendar) window.__NO_CALENDAR = true;
    window.__held = [];
    const session = { profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
  }, { profile, variant, responses, widget, prefill, grouped, noCalendar });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(join(ROOT, "test/fixtures/workday-sei-questions.html"), "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(150);
  return page;
}

const readPage = (page) => page.evaluate(() => {
  const q = (kind) => document.querySelector(`[data-q="${kind}"]`);
  const boxes = Array.from(document.querySelectorAll(".wd-date input")).map((b) => b.value);
  return {
    emptype: q("emptype").querySelector("button").textContent.trim(),
    shift: q("shift").querySelector("button").textContent.trim(),
    shiftOutlined: q("shift").querySelector("button").classList.contains("applifill-needs-you"),
    other: q("other").querySelector("button").textContent.trim(),
    otherDrafted: q("other").querySelector("button").classList.contains("applifill-drafted"),
    salary: q("salary").querySelector("input").value,
    bonus: q("bonus").querySelector("input").value,
    date: boxes,
    dateError: document.getElementById("start-err").textContent,
    dateOutlined: Array.from(document.querySelectorAll(".wd-date input")).some((b) => b.classList.contains("applifill-needs-you")),
    held: window.__held.map((h) => `${h.question} = ${h.answer}`),
  };
});

for (const variant of ["formLabel", "legend"]) {
  console.log(`\nquestion labels drawn as ${variant === "legend" ? "<legend>" : "formLabel labels"}, "Immediately"`);
  const page = await open({ variant, profile: profileWith("Immediately") });

  const rules = await page.evaluate(() => window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map((f) => ({
    q: f.el.closest("[data-q]")?.dataset.q ?? null, rule: f.rule?.key ?? null,
    auto: f.el.getAttribute("data-automation-id") || "",
  })).filter((f) => f.q));
  const ruleOf = (q) => rules.filter((f) => f.q === q).map((f) => f.rule);
  check("Employment Type Desired is the employment-type question", ruleOf("emptype")[0] === "employmentType", JSON.stringify(rules));
  check("Shift Preference is not taken for an employment question", ruleOf("shift")[0] !== "employmentType", JSON.stringify(ruleOf("shift")));
  check("every Available Start Date box is the availability question", ruleOf("start").length === 3 && ruleOf("start").every((r) => r === "startDate"),
    JSON.stringify(ruleOf("start")));
  check("the other-opportunities question is recognised", ruleOf("other")[0] === "otherOpportunities", JSON.stringify(ruleOf("other")));
  check("the base-salary question is the desired-salary question", ruleOf("salary")[0] === "desiredSalary", JSON.stringify(ruleOf("salary")));
  check("the bonus question is not the salary question", ruleOf("bonus")[0] !== "desiredSalary", JSON.stringify(ruleOf("bonus")));

  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(500);
  await page.click("#save");
  await page.waitForTimeout(100);
  const s = await readPage(page);
  const today = mdy(inDays(0));
  check("Employment Type Desired = Full-Time (the current job's type)", s.emptype === "Full-Time", `= ${s.emptype}`);
  check("Available Start Date = today, in all three boxes", s.date.join("/") === `${today.m}/${today.d}/${today.y}`, `= ${s.date.join("/")}`);
  check("  and Workday reports no Invalid Date", s.dateError === "", `error: ${s.dateError}`);
  check("considered for other opportunities = Yes", s.other === "Yes", `= ${s.other}`);
  check("  shown as a draft to check", s.otherDrafted === true);
  check("base salary expectation from the profile", s.salary === "165000", `= ${s.salary}`);
  check("the bonus box is left alone", s.bonus === "", `= ${s.bonus}`);
  check("Shift Preference is left for the applicant, outlined", s.shift === "Select One" && s.shiftOutlined, JSON.stringify(s));
  check("nothing Appli-Fill filled is offered back as the applicant's", s.held.length === 0, JSON.stringify(s.held));
  await page.close();
}

console.log("\nother ways of saying when");
for (const [said, expect, label] of [
  ["ASAP", inDays(0), "ASAP is today"],
  ["2 weeks", inDays(14), "\"2 weeks\" is two weeks from today"],
  ["Two weeks' notice", inDays(14), "\"Two weeks' notice\" too"],
  ["2030-03-15", new Date(2030, 2, 15), "a date is that date"],
  ["2020-01-10", inDays(0), "a date already past is today"],
  ["", inDays(0), "nothing in the profile: today"],
  ["Negotiable", inDays(0), "words no calendar can hold: today"],
]) {
  const page = await open({ profile: profileWith(said) });
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await readPage(page);
  const want = mdy(expect);
  check(label, s.date.join("/") === `${want.m}/${want.d}/${want.y}` && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
  await page.close();
}

console.log("\nthe questions inside one group, a number in another box (reported on 1.23.0)");
{
  const bonus = [{ question: "What is your desired Annual bonus?", answer: "20000", aliases: [], inputType: "text", lastDomain: "seic.wd1.myworkdayjobs.com" }];
  for (const [salaryAlready, label] of [[false, "salary from the profile"], [true, "salary already answered (as when the page is filled again)"]]) {
    const page = await open({ profile: profileWith("Immediately"), responses: bonus, grouped: true });
    if (salaryAlready) await page.evaluate(() => { document.querySelector('[data-q="salary"] input').value = "120000"; });
    const shared = await page.evaluate(() => {
      const { M } = window.__applifill;
      return ["salary", "bonus"].map((q) => M.dateSegmentNodes(document.querySelector(`[data-q="${q}"] input`)));
    });
    check(`${label}: the salary and bonus boxes are not part of the date`, shared.every((x) => x === null), JSON.stringify(shared));
    await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
    await page.waitForTimeout(400);
    await page.click("#save");
    await page.waitForTimeout(80);
    const s = await readPage(page);
    const today = mdy(inDays(0));
    check(`  Available Start Date = today, never 01/01/2000 or empty`, s.date.join("/") === `${today.m}/${today.d}/${today.y}` && s.dateError === "",
      `= ${s.date.join("/")} ${s.dateError}`);
    check(`  the bonus box holds the saved "20000"`, s.bonus === "20000", `= ${s.bonus}`);
    check(`  the salary box holds ${salaryAlready ? "what it had" : "the profile's salary"}`, s.salary === (salaryAlready ? "120000" : "165000"), `= ${s.salary}`);
    await page.close();
  }
  const page = await open({ profile: profileWith("Immediately") });
  const read = await page.evaluate(() => {
    const { M } = window.__applifill;
    return Object.fromEntries(["20000", "120000", "10%", "Marketing 2019", "13/01/2026", "October 1, 2026", "2026-10-01", "12/2019"]
      .map((v) => [v, M.dateParts(v)]));
  });
  check("an amount, a percentage or a word is never read as a date",
    ["20000", "120000", "10%", "Marketing 2019", "13/01/2026"].every((v) => read[v] === null), JSON.stringify(read));
  check("  while real dates still are",
    read["October 1, 2026"]?.year === "2026" && read["October 1, 2026"]?.month === "10" && read["2026-10-01"]?.day === "01" && read["12/2019"]?.month === "12",
    JSON.stringify(read));
  await page.close();
}

console.log("\na start date saved off an earlier application");
{
  // An answer banked for the exact question on an earlier Workday form is
  // never replayed into the date either.
  const saved = [
    { question: "Available Start Date", answer: "01/01/2000", aliases: [], inputType: "text", lastDomain: "seic.wd1.myworkdayjobs.com" },
    { question: "Available Start Date Month", answer: "01", aliases: [], inputType: "text", lastDomain: "seic.wd1.myworkdayjobs.com" },
    { question: "Available Start Date Year", answer: "2000", aliases: [], inputType: "text", lastDomain: "seic.wd1.myworkdayjobs.com" },
  ];
  for (const [said, label] of [["Immediately", "\"Immediately\" in the profile"], ["", "nothing in the profile"], ["2030-03-15", "a date in the profile"]]) {
    const page = await open({ profile: profileWith(said), responses: saved });
    await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
    await page.waitForTimeout(400);
    await page.click("#save");
    await page.waitForTimeout(80);
    const s = await readPage(page);
    const want = mdy(said === "2030-03-15" ? new Date(2030, 2, 15) : inDays(0));
    check(`${label}: the profile's date (or today's), never the saved 01/01/2000`,
      s.date.join("/") === `${want.m}/${want.d}/${want.y}` && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
    await page.close();
  }
}

console.log("\na date already in the boxes");
for (const [prefill, expectToday, label] of [
  ["01/01/2000", true, "01/01/2000 left by an earlier fill is replaced with today's date"],
  ["12/01/2030", false, "a start date still ahead is left as it is"],
]) {
  const page = await open({ profile: profileWith("Immediately"), prefill });
  await page.waitForTimeout(50);
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await readPage(page);
  const today = mdy(inDays(0));
  const want = expectToday ? `${today.m}/${today.d}/${today.y}` : prefill;
  check(label, s.date.join("/") === want && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
  await page.close();
}

console.log("\nthe same question asked in words, in a plain box");
for (const [answer, expect, label] of [
  ["01/01/2000", null, "a saved date is never replayed: today's date instead"],
  ["Two weeks", "Two weeks", "a saved answer in words is still used"],
]) {
  const page = await open({
    profile: profileWith(""),
    responses: [{ question: "What is your earliest available start date?", answer, aliases: [], inputType: "text", lastDomain: "boards.greenhouse.io" }],
  });
  await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.dataset.q = "starttext";
    wrap.innerHTML = '<label for="start-text">What is your earliest available start date?</label><input id="start-text" type="text">';
    document.getElementById("primary").appendChild(wrap);
  });
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => document.getElementById("start-text").value);
  const today = mdy(inDays(0));
  const want = expect ?? `${today.m}/${today.d}/${today.y}`;
  check(label, got === want, `= ${got}`);
  await page.close();
}

console.log("\nWorkday's boxes that take nothing typed (reported again on 1.24.0)");
{
  const today = mdy(inDays(0));
  for (const [said, prefill, want, label] of [
    ["Immediately", null, today, "\"Immediately\": today, picked from Workday's calendar"],
    ["Immediately", "01/01/2000", today, "01/01/2000 left by 1.24.0 is replaced with today, from the calendar"],
    ["2027-03-15", null, { m: "03", d: "15", y: "2027" }, "a date in the profile: its month turned to and its day picked"],
  ]) {
    const page = await open({ profile: profileWith(said), widget: "picker", prefill });
    await page.waitForTimeout(50);
    await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
    await page.waitForTimeout(400);
    await page.click("#save");
    await page.waitForTimeout(80);
    const s = await readPage(page);
    const picked = await page.evaluate(() => ({ picked: window.__pickedFromCalendar ?? null, open: Boolean(document.querySelector('[data-automation-id="datePicker"]')) }));
    check(label, s.date.join("/") === `${want.m}/${want.d}/${want.y}` && s.dateError === "", `= ${s.date.join("/")} ${s.dateError} ${JSON.stringify(picked)}`);
    check("  and the calendar is closed again", !picked.open, JSON.stringify(picked));
    await page.close();
  }
  {
    // Boxes that do take Backspace: the old date is taken out first, so the
    // calendar opens on this month and today is picked there.
    const page = await open({ profile: profileWith("Immediately"), prefill: "01/01/2000" });
    await page.waitForTimeout(50);
    await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
    await page.waitForTimeout(400);
    await page.click("#save");
    await page.waitForTimeout(80);
    const s = await readPage(page);
    const how = await page.evaluate(() => ({ picked: window.__pickedFromCalendar ?? null, openedOn: window.__calendarOpenedOn ?? null }));
    const monthNow = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
    check("01/01/2000 in boxes that take Backspace: cleared, then today picked from this month's calendar",
      s.date.join("/") === `${today.m}/${today.d}/${today.y}` && s.dateError === "" && how.picked && how.openedOn === monthNow,
      `= ${s.date.join("/")} ${s.dateError} ${JSON.stringify(how)}`);
    await page.close();
  }
  const page = await open({ profile: profileWith("Immediately"), widget: "picker", noCalendar: true });
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  const s = await readPage(page);
  check("with no calendar either, the arrow keys are never pressed: never 01/01/2000", s.date.join("/") !== "01/01/2000", `= ${s.date.join("/")}`);
  check("  the date is outlined for the applicant, not reported as filled",
    s.dateOutlined && !(result.keys ?? []).includes("startDate"), JSON.stringify({ outlined: s.dateOutlined, keys: result.keys }));
  await page.close();
}

console.log("\na widget that reads keystrokes itself (no calendar)");
{
  const page = await open({ profile: profileWith("Immediately"), widget: "keys", noCalendar: true });
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await readPage(page);
  const want = mdy(inDays(0));
  check("today's date, typed a keystroke at a time", s.date.join("/") === `${want.m}/${want.d}/${want.y}` && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
  await page.close();
}

console.log("\na widget that only takes the arrow keys");
{
  const page = await open({ profile: profileWith("Immediately"), widget: "spin" });
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  await page.click("#save");
  await page.waitForTimeout(80);
  const s = await readPage(page);
  const want = mdy(inDays(0));
  check("today's date, from its calendar", s.date.join("/") === `${want.m}/${want.d}/${want.y}` && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
  await page.close();
}

console.log("\na widget that will not show the date");
{
  const page = await open({ profile: profileWith("Immediately"), widget: "sticky", noCalendar: true });
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(400);
  const s = await readPage(page);
  check("the boxes are never emptied (an emptied date reads as nothing filled)", s.date.some((v) => v !== ""), `= ${s.date.join("/")}`);
  check("  and outlined for the applicant, not reported as filled",
    s.dateOutlined && !(result.keys ?? []).includes("startDate"), JSON.stringify({ outlined: s.dateOutlined, keys: result.keys }));
  check("  the rest of the page still fills", s.other === "Yes" && s.salary === "165000", JSON.stringify(s));
  await page.close();
}

console.log("\nhow the boxes are written (no calendar)");
{
  const page = await open({ profile: profileWith("Immediately"), noCalendar: true });
  const today = mdy(inDays(0));
  const whole = `${today.m}/${today.d}/${today.y}`;
  const planned = await page.evaluate((profile) => {
    const { RULES, M } = window.__applifill;
    const rule = RULES.find((r) => r.key === "startDate");
    return ["Month", "Day", "Year"].map((part) => {
      const box = document.querySelector(`[data-automation-id="dateSection${part}-input"]`);
      return rule.value(profile, box, M.deriveLabel(box), 0);
    });
  }, profileWith("Immediately"));
  check("each box is planned with the whole date, so whichever box is reached first writes it", planned.every((v) => v === whole), JSON.stringify(planned));

  // This widget loses boxes written in one go (Workday's does not, but some do)…
  await page.evaluate((value) => {
    window.__applifill.M.setTextValue(document.querySelector('[data-automation-id="dateSectionMonth-input"]'), value);
  }, whole);
  await page.waitForTimeout(60);
  await page.click("#save");
  await page.waitForTimeout(60);
  let s = await readPage(page);
  check("  (a date written into all three boxes in one go is lost by this widget)", s.date.join("/") !== whole, `= ${s.date.join("/")}`);

  // …and typed a keystroke at a time, it is not.
  const ok = await page.evaluate(async (value) =>
    window.__applifill.M.setSegmentedDateAsync(document.querySelector('[data-automation-id="dateSectionMonth-input"]'), value), whole);
  await page.waitForTimeout(80);
  await page.click("#save");
  await page.waitForTimeout(60);
  s = await readPage(page);
  check("a whole date handed to one box still fills MM, DD and YYYY: each box is read back and tried again", ok === true && s.date.join("/") === whole && s.dateError === "", `= ${s.date.join("/")} ${s.dateError}`);
  const shows = await page.evaluate((value) => {
    const { M } = window.__applifill;
    const box = document.querySelector('[data-automation-id="dateSectionMonth-input"]');
    return { right: M.segmentedDateShows(box, M.dateParts(value)), wrong: M.segmentedDateShows(box, M.dateParts("01/01/2000")) };
  }, whole);
  check("  and it is read back to be sure", shows.right === "match" && shows.wrong === "mismatch", JSON.stringify(shows));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
