/**
 * Oracle Recruiting Cloud — the Candidate Experience application, end to end.
 *
 *   node test/oracle-cx.spec.mjs
 *
 * Reported against 1.18.0 on eczd.fa.us2.oraclecloud.com (Yum! Brands,
 * …/CandidateExperience/en/sites/CX_1/job/5629/apply/section/1): Address Line 1
 * typed with its suggestion list left open, ZIP Code / City / State / County
 * empty and "required", every Yes/No question unanswered, "What compensation
 * are you seeking?" empty, and the Hispanic/Latino and race boxes unticked.
 *
 * What was wrong, one line each:
 *   - Oracle's Yes/No "pills" are option buttons in a listbox, or buttons each
 *     in their own wrapper; neither shape was collected as a question.
 *   - State, County, Tax District and Veteran Status are read-only boxes that
 *     open a list; every read-only box was refused as unfillable.
 *   - ZIP Code and City are type-to-search lists: typing then blurring threw
 *     the text away, and a third of a second was not long enough for the list.
 *   - The address suggestion was never picked (picking it fills the rest).
 *   - "races", a lone "I am Hispanic or Latino." box and "compensation … seeking"
 *     matched no rule.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const FIXTURE = join(ROOT, "test/fixtures/oracle-cx-apply.html");
const URL = "https://eczd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/5629/apply/section/1";

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pat", lastName: "Lee", email: "pat.lee@example.com", phone: "904-555-0147",
    address: "1200 Harbor View Dr Apt 305", city: "Jacksonville", state: "Florida", zip: "32205", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", previouslyEmployedHere: "No" },
  compensation: { desiredSalary: "$120,000" },
  eeo: { gender: "Male", hispanicLatino: "No", race: "Asian", veteranStatus: "I am not a protected veteran" },
  experience: [{ company: "Acme Cloud", title: "Site Reliability Engineer", startDate: "2021-03", current: true, location: "Jacksonville, FL" }],
  education: [],
};

/** Answered by hand on earlier applications. */
const SAVED = [
  {
    question: "Are you currently bound by a non-compete agreement, non-solicitation agreement or any other restrictive covenant with a current or former employer?",
    answer: "No", aliases: [], lastDomain: "ejzg.fa.us6.oraclecloud.com", inputType: "radio",
  },
  { question: "Do you have any relatives currently employed by GDIT?", answer: "No", aliases: [], lastDomain: "gdit.wd5.myworkdayjobs.com", inputType: "select" },
];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});

async function open({ profile = PROFILE, responses = SAVED, cx = {}, premium = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses, cx, premium }) => {
    window.__APPLI_FILL_TEST = true;
    window.__cx = cx;
    window.__held = [];
    window.__asked = [];
    const session = { profile, profiles: [profile], responses, premium,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    // The answer service, stubbed: it records what it is asked.
    const answerFor = (q) => {
      if (/non-compete/i.test(q.question)) return "No";
      if (/relatives/i.test(q.question)) return "No";
      if (/worked for|employed or contracted/i.test(q.question)) return "No";
      return "";
    };
    window.chrome = { runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage(m, cb) {
      if (m?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(m.items || []));
      let r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      let wait = 0;
      if (m?.type === "APPLI_FILL_ANSWER_BATCH") {
        window.__asked.push(...m.payload.questions);
        r = { ok: true, data: { answers: m.payload.questions.map((q) => ({ id: q.id, answer: answerFor(q) })) } };
        wait = 250;
      }
      setTimeout(() => cb && cb(r), wait);
    } } };
  }, { profile, responses, cx, premium });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(URL);
  await page.setContent(await readFile(FIXTURE, "utf8"));
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  return page;
}

async function fill(options) {
  const page = await open(options);
  const started = Date.now();
  const result = await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  const ms = Date.now() - started;
  // Past both settle passes (900ms and 2200ms).
  await page.waitForTimeout(2500);
  return { page, result, ms, state: await read(page) };
}

const read = (page) => page.evaluate(() => {
  const v = (id) => document.getElementById(id)?.value ?? null;
  const pills = {};
  document.querySelectorAll(".cx-select-pills-container").forEach((g) => { pills[g.dataset.q] = g.dataset.value || null; });
  return {
    first: v("firstName"), middle: v("middleNames"), last: v("lastName"), phone: v("phoneNumber"),
    addr1: v("addressLine1"), addr2: v("addressLine2"), zip: v("postalCode"), city: v("townOrCity"),
    state: v("region2"), county: v("region1"), tax: v("addlAddressAttribute3"),
    zipPicked: document.getElementById("postalCode").dataset.value || "",
    cityPicked: document.getElementById("townOrCity").dataset.value || "",
    pills,
    comp: v("q8"),
    gender: document.querySelector("#gender .oj-select-chosen").textContent,
    hispanic: document.getElementById("eth-hispanic").checked,
    races: Array.from(document.querySelectorAll("#race-group input:checked")).map((c) => c.nextElementSibling.textContent),
    veteran: v("veteran"),
    flagged: Array.from(document.querySelectorAll(".applifill-needs-you")).map((el) => el.id || el.closest("[data-q]")?.dataset.q || el.className),
    openLists: document.querySelectorAll(".cx-list, .cx-suggestions").length,
    log: window.__log.slice(),
    held: window.__held.map((h) => ({ q: h.question, a: String(h.answer) })),
  };
});

/* ------------------------------------------------------------------ */
console.log("\nwhat is collected");
{
  const page = await open();
  const fields = await page.evaluate(() => window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map((f) => ({
    tag: f.el.tagName, id: f.el.id, kind: f.kind, key: f.rule?.key ?? null,
    q: f.el.closest("[data-q]")?.dataset.q ?? null, label: f.label.split(" | ")[0],
  })));
  const pills = fields.filter((f) => f.q);
  check("every pill question is one field", pills.length === 8 && new Set(pills.map((f) => f.q)).size === 8,
    JSON.stringify(pills.map((f) => f.q)));
  check("  answered as a choice", pills.every((f) => f.kind === "radio"), JSON.stringify(pills.map((f) => f.kind)));
  check("  under its question, not \"Yes\"", pills.every((f) => f.label.length > 4 && !/^(yes|no|doctor)$/i.test(f.label)),
    JSON.stringify(pills.map((f) => f.label)));
  const byId = Object.fromEntries(fields.filter((f) => f.id).map((f) => [f.id, f]));
  for (const [id, key] of [["region2", "state"], ["region1", "county"], ["addlAddressAttribute3", "taxDistrict"], ["veteran", "veteranStatus"]]) {
    check(`read-only list "${id}" is collected (${key})`, byId[id]?.key === key && byId[id]?.kind === "select", JSON.stringify(byId[id]));
  }
  check("ZIP Code is the zip rule", byId.postalCode?.key === "zip", JSON.stringify(byId.postalCode));
  check("\"What compensation are you seeking?\" is the salary question", byId.q8?.key === "desiredSalary", JSON.stringify(byId.q8));
  check("\"I am Hispanic or Latino.\" is the Hispanic question", byId["eth-hispanic"]?.key === "hispanicLatino", JSON.stringify(byId["eth-hispanic"]));
  check("\"Select the races you identify with.\" is the race question", byId["race-1"]?.key === "race", JSON.stringify(byId["race-1"]));
  check("the prefilled read-only email is left alone", !byId.email, JSON.stringify(byId.email));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: the address suggestion is picked");
{
  const { page, result, ms, state } = await fill();
  check("First/Last name", state.first === "Pat" && state.last === "Lee", `${state.first} ${state.last}`);
  check("Middle Name left empty", state.middle === "", `= ${JSON.stringify(state.middle)}`);
  check("Phone uses national digits beside the country-code picker", state.phone === "9045550147", `= ${state.phone}`);
  check("Address Line 1 is Oracle's own suggestion", state.addr1 === "1200 HARBOR VIEW DR", `= ${state.addr1}`);
  check("  and the apartment it dropped is in Line 2", state.addr2 === "Apt 305", `= ${JSON.stringify(state.addr2)}`);
  check("  and the suggestion list is closed", state.openLists === 0, `${state.openLists} open`);
  check("ZIP Code", state.zip === "32205" && state.zipPicked === "32205", `= ${state.zip} (picked ${state.zipPicked})`);
  check("City", state.city === "JACKSONVILLE", `= ${state.city}`);
  check("State", state.state === "Florida", `= ${state.state}`);
  check("County", state.county === "DUVAL", `= ${state.county}`);
  check("Tax District — the only one offered for the address", state.tax === "JACKSONVILLE-DUVAL CONSOLIDATED", `= ${state.tax}`);
  check("the address is searched once, never retyped over the pick",
    state.log.filter((l) => l.startsWith("address search")).length === 1, JSON.stringify(state.log));

  // From 1.26.0 every field is answered: Title is the one that goes with the
  // gender the applicant gave (Male), never guessed without it.
  check("Title is Mr., from the gender in the profile", state.pills.title === "Mr.", `= ${state.pills.title}`);
  check("non-compete: the saved answer", state.pills.noncompete === "No", `= ${state.pills.noncompete}`);
  check("worked for YUM! Brands: No (not in the history)", state.pills.workedhere === "No", `= ${state.pills.workedhere}`);
  check("legally authorized: Yes", state.pills.auth === "Yes", `= ${state.pills.auth}`);
  check("sponsorship: No", state.pills.sponsor === "No", `= ${state.pills.sponsor}`);
  check("at least 18: Yes", state.pills.over18 === "Yes", `= ${state.pills.over18}`);
  check("employed or contracted by Yum! in six months: No", state.pills.recent === "No", `= ${state.pills.recent}`);
  check("relatives at Yum!: the answer given for GDIT", state.pills.relatives === "No", `= ${state.pills.relatives}`);
  check("compensation", state.comp === "$120,000", `= ${JSON.stringify(state.comp)}`);

  check("Gender", state.gender === "Male", `= ${state.gender}`);
  check("not Hispanic: the box stays clear", state.hispanic === false);
  check("race: Asian, and only Asian", JSON.stringify(state.races) === JSON.stringify(["Asian"]), JSON.stringify(state.races));
  check("Veteran Status", state.veteran === "I am not a protected veteran", `= ${state.veteran}`);

  check("nothing left outlined (Title and Middle Name are optional)", state.flagged.length === 0, JSON.stringify(state.flagged));
  check("reported: nothing left unanswered", result.unmatched === 0, `unmatched=${result.unmatched}`);
  check("nothing Appli-Fill filled is offered as a pending answer", state.held.length === 0, JSON.stringify(state.held));
  check(`done in ${ms}ms`, ms < 6000, `${ms}ms`);

  console.log("\nchanging a pill by hand");
  await page.click("[data-q=noncompete] button >> text=Yes");
  await page.waitForTimeout(700);
  const after = await read(page);
  const held = after.held.filter((h) => /non-compete/i.test(h.q)).pop();
  check("is held under its question", held?.a === "Yes", JSON.stringify(after.held));
  check("  and nothing else is", after.held.every((h) => /non-compete/i.test(h.q)), JSON.stringify(after.held));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: no address suggestions; the ZIP Code fills City, State and County");
{
  const { page, state } = await fill({ cx: { suggestions: false } });
  check("Address Line 1 keeps the typed street", state.addr1 === "1200 Harbor View Dr Apt 305", `= ${state.addr1}`);
  check("ZIP Code picked from its list", state.zipPicked === "32205", `= ${state.zip} (picked ${state.zipPicked})`);
  check("City, State, County as the page set them", state.city === "JACKSONVILLE" && state.state === "Florida" && state.county === "DUVAL",
    `${state.city} / ${state.state} / ${state.county}`);
  check("  and City is not searched again over it", !state.log.some((l) => l.startsWith("search townOrCity")), JSON.stringify(state.log));
  check("nothing outlined", state.flagged.length === 0, JSON.stringify(state.flagged));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: every list answered by Appli-Fill, on a slow server");
{
  const { page, state, ms } = await fill({ cx: { suggestions: false, autopopulate: false, latency: 1400 } });
  check("ZIP Code picked", state.zipPicked === "32205", `= ${state.zip} (picked ${state.zipPicked})`);
  check("City picked — JACKSONVILLE, not JACKSONVILLE BEACH", state.cityPicked === "JACKSONVILLE", `= ${state.city} (picked ${state.cityPicked})`);
  check("  and not thrown away when the box lost focus", !state.log.some((l) => l.startsWith("cleared")), JSON.stringify(state.log));
  check("State", state.state === "Florida", `= ${state.state}`);
  check("County — the one the list offers for the ZIP Code", state.county === "DUVAL", `= ${state.county}`);
  check("Tax District", state.tax === "JACKSONVILLE-DUVAL CONSOLIDATED", `= ${state.tax}`);
  check(`done in ${ms}ms`, ms < 12000, `${ms}ms`);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: suggestions offered, none of them the applicant's address");
{
  const profile = { ...PROFILE, personal: { ...PROFILE.personal, address: "1200 Harbor Point Ln" } };
  const { page, state } = await fill({ profile });
  check("no other address is picked", state.addr1 === "1200 Harbor Point Ln", `= ${state.addr1}`);
  check("  the list is closed", state.openLists === 0, `${state.openLists} open`);
  check("  and the rest still fills", state.zipPicked === "32205" && state.city === "JACKSONVILLE" && state.state === "Florida",
    `${state.zip} / ${state.city} / ${state.state}`);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: a Hispanic applicant, and a Tax District with two choices");
{
  const profile = {
    ...PROFILE,
    personal: { ...PROFILE.personal, address: "1200 Harbor View Rd", zip: "32073", city: "Orange Park" },
    eeo: { ...PROFILE.eeo, hispanicLatino: "Yes", race: "White" },
  };
  const { page, state } = await fill({ profile, cx: { suggestions: false, autopopulate: false } });
  check("the Hispanic box is ticked", state.hispanic === true);
  check("race: White", JSON.stringify(state.races) === JSON.stringify(["White"]), JSON.stringify(state.races));
  check("County from the ZIP Code's list", state.county === "CLAY", `= ${state.county}`);
  check("Tax District with two choices is left for the applicant", state.tax === "", `= ${state.tax}`);
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nfill: nothing saved — the pills go to the answer service with their choices");
{
  const profile = { ...PROFILE, workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes" } };
  const { page, state } = await fill({ profile, responses: [], premium: true });
  const asked = await page.evaluate(() => window.__asked.map((q) => ({ q: q.question, options: q.options })));
  const pillQs = asked.filter((a) => /non-compete|worked for|employed or contracted|relatives/i.test(a.q));
  // Non-compete is an applicant declaration: missing answers do not go to AI.
  check("each open Yes/No question is asked once", pillQs.length === 3 && !pillQs.some((a) => /non-compete/i.test(a.q)),
    JSON.stringify(asked.map((a) => a.q)));
  check("  with its choices", pillQs.every((a) => JSON.stringify(a.options) === '["Yes","No"]'), JSON.stringify(pillQs));
  check("  and never Title, eligibility or the diversity questions",
    !asked.some((a) => /^title$|authorized|sponsor|18 years|gender|hispanic|race|veteran/i.test(a.q)), JSON.stringify(asked.map((a) => a.q)));
  check("known answers are clicked; unknown non-compete stays unanswered", state.pills.noncompete === null && state.pills.relatives === "No" &&
    state.pills.workedhere === "No" && state.pills.recent === "No", JSON.stringify(state.pills));
  await page.close();
}

/* ------------------------------------------------------------------ */
console.log("\nother shapes of the same controls");
{
  const page = await open();
  await page.evaluate(() => {
    document.querySelector("main").insertAdjacentHTML("beforeend", `
      <section id="shapes">
        <div class="input-row" id="s1">
          <label class="input-row__label">Are you willing to relocate? <a href="#policy">See policy</a></label>
          <ul role="listbox" class="pills">
            <li role="option" aria-selected="false">Yes</li>
            <li role="option" aria-selected="false">No</li>
          </ul>
        </div>
        <div class="input-row" id="s2">
          <p class="question">Do you have a valid driver's license?</p>
          <div class="pills"><span><button type="button">Yes</button></span><span><button type="button">No</button></span></div>
        </div>
        <div id="toolbar"><div><button type="button">Bold</button></div><div><button type="button">Italic</button></div></div>
        <div class="input-row" id="s3"><label for="when">Available from</label>
          <input id="when" type="text" readonly aria-haspopup="dialog"></div>
        <ul id="menu" role="listbox" style="position:absolute;top:0;left:0">
          <li role="option">Alpha</li><li role="option">Beta</li>
        </ul>
        <div class="input-row" id="s4">
          <label class="input-row__label" id="s4-label">Veteran Status</label>
          <ul role="listbox" aria-labelledby="s4-label" class="pills">
            <li role="none"><button type="button" role="option" aria-selected="false">I identify as one or more of the classifications of protected veteran</button></li>
            <li role="none"><button type="button" role="option" aria-selected="false">I am not a protected veteran</button></li>
            <li role="none"><button type="button" role="option" aria-selected="false">I do not wish to self-identify</button></li>
          </ul>
        </div>
      </section>`);
    // The page's own handler: one choice at a time.
    document.querySelectorAll("#s4 button").forEach((b, _, all) => b.addEventListener("click", () =>
      all.forEach((x) => x.setAttribute("aria-selected", String(x === b)))));
  });
  const shapes = await page.evaluate(() => {
    const M = window.APPLI_FILL_MATCHER;
    const labelOf = (sel) => M.deriveLabel(document.querySelector(sel)).split(" | ")[0];
    return {
      liOptions: (M.choiceButtonGroup(document.querySelector("#s1 li")) || []).map((b) => b.textContent),
      liLabel: labelOf("#s1 li"),
      spans: (M.choiceButtonGroup(document.querySelector("#s2 button")) || []).map((b) => b.textContent),
      spansLabel: labelOf("#s2 button"),
      toolbar: M.choiceButtonGroup(document.querySelector("#toolbar button"))?.length ?? 0,
      floatingMenu: M.choiceButtonGroup(document.querySelector("#menu li"))?.length ?? 0,
      datePicker: M.isFillable(document.getElementById("when")),
      readOnlyList: M.isFillable(document.getElementById("region2")),
      readOnlyPlain: M.isFillable(document.getElementById("email")),
      veteran: (() => {
        const anchor = document.querySelector("#s4 button");
        const label = M.deriveLabel(anchor);
        const rule = M.matchRule(anchor, label, window.APPLI_FILL_FIELD_MAP);
        const ok = rule ? M.setRadioValue(anchor, "I am not a protected veteran", rule.options, label) : false;
        const picked = Array.from(document.querySelectorAll("#s4 button")).find((b) => b.getAttribute("aria-selected") === "true");
        return { key: rule?.key ?? null, ok, picked: picked?.textContent ?? null };
      })(),
    };
  });
  check("options drawn as <li role=option> are one question", JSON.stringify(shapes.liOptions) === '["Yes","No"]', JSON.stringify(shapes.liOptions));
  check("  labelled by the question even with a link in it", /willing to relocate/i.test(shapes.liLabel), shapes.liLabel);
  check("buttons each in a <span> are one question", JSON.stringify(shapes.spans) === '["Yes","No"]', JSON.stringify(shapes.spans));
  check("  labelled by the paragraph above them", /driver's license/i.test(shapes.spansLabel), shapes.spansLabel);
  check("a floating menu's options are not a question", shapes.floatingMenu === 0, `${shapes.floatingMenu}`);
  check("a read-only box that opens a list is fillable", shapes.readOnlyList === true);
  check("a read-only date box that opens a calendar is not", shapes.datePicker === false);
  check("a plain read-only box is not", shapes.readOnlyPlain === false);
  check("veteran status drawn as long pills is answered", shapes.veteran.key === "veteranStatus" &&
    shapes.veteran.ok && shapes.veteran.picked === "I am not a protected veteran", JSON.stringify(shapes.veteran));

  const parsed = await page.evaluate(() => {
    const M = window.APPLI_FILL_MATCHER;
    if (typeof M.parseStreet !== "function" || typeof M.addressScore !== "function") return { missing: true };
    const want = M.parseStreet("8451 GATE PKWY W APT 128");
    return {
      want,
      same: M.addressScore("8451 Gate Parkway West, Jacksonville, FL 32256", want, { zip: "32256", city: "Jacksonville" }),
      noUnit: M.addressScore("8451 Gate Pkwy W", want, {}),
      otherStreet: M.addressScore("8451 Gate Pkwy E, Jacksonville, FL 32256", want, {}),
      otherNumber: M.addressScore("8415 Gate Pkwy W, Jacksonville, FL 32256", want, {}),
      otherZip: M.addressScore("8451 Gate Pkwy W, Jacksonville, FL 32216", want, { zip: "32256" }),
      otherCity: M.addressScore("8451 Gate Pkwy W, Orlando, FL", want, { city: "Jacksonville" }),
    };
  });
  check("the street is read apart from its apartment", parsed.want?.number === "8451" && parsed.want?.unit === "APT 128" &&
    parsed.want?.words.join(" ") === "GATE PARKWAY WEST", JSON.stringify(parsed.want));
  check("  and matches the same street spelled out", parsed.same > 0 && parsed.noUnit > 0, JSON.stringify(parsed));
  check("  but not another street, number, ZIP Code or city", !parsed.missing &&
    !parsed.otherStreet && !parsed.otherNumber && !parsed.otherZip && !parsed.otherCity, JSON.stringify(parsed));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
