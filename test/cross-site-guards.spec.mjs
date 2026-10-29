/**
 * What the Oracle Recruiting and ADP work must not change anywhere else.
 *
 *   node test/cross-site-guards.spec.mjs
 *
 * 1.26.0 taught the extension Oracle Recruiting's and ADP's application pages:
 * new answers (the pay period of a salary, a title from the applicant's gender,
 * consent and preferred-name check boxes, the self-identification questions
 * Oracle asks), and new ways of reading a page (boxes drawn inside a
 * component's shadow root, radios drawn by their labels). Each is right on the
 * portal it was made for and wrong on an ordinary application page — a review
 * of the work found every case below answered differently than 1.25.0
 * answered it. Each is now limited to its own portal, and the ordinary pages
 * here are filled exactly as before.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const BOARD = "https://boards.example.com/acme/jobs/4471/apply";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${!pass && detail ? `\n         ${detail}` : ""}`);
};

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Pradeep", lastName: "Reddy", preferredName: "Pete", email: "pradeep@example.com", phone: "516-205-8456",
    address: "8451 Gate Pkwy W", city: "Jacksonville", state: "FL", zip: "32216", country: "United States",
  },
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", driversLicense: "Yes",
    willingToBackgroundCheck: "Yes", willingToDrugTest: "Yes",
  },
  compensation: { desiredSalary: "130000" },
  eeo: { gender: "Male", race: "Asian", hispanicLatino: "No", veteranStatus: "I am not a protected veteran" },
  experience: [
    { company: "Globex", title: "Senior SRE", startDate: "2021-03", endDate: "", current: true },
    { company: "Initech", title: "DevOps Engineer", startDate: "2018-06", endDate: "2021-02" },
  ],
  education: [], documents: [],
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

async function fill(html, probe, { url = BOARD, profile = PROFILE } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(({ profile }) => {
    window.__APPLI_FILL_TEST = true;
    const session = { profile, profiles: [profile], responses: [], premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, trackAutomatically: false } };
    window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
      const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
        : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
      setTimeout(() => cb && cb(r), 0);
    }, onMessage: { addListener() {} } } };
    // Every class the app root is given while the form is filled, flashes included.
    window.__rootClasses = new Set();
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target?.tagName === "APP-ROOT") String(r.target.className || "").split(/\s+/).filter(Boolean).forEach((c) => window.__rootClasses.add(c));
      }
    }).observe(document, { attributes: true, attributeFilter: ["class"], subtree: true });
  }, { profile });
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto(url);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(100);
  await page.evaluate(async () => (await window.__applifill.run({ manual: true }))?.data ?? {});
  await page.waitForTimeout(1500);
  const out = await page.evaluate(probe);
  await page.close();
  return { ...out, errors };
}

const contact = `
  <label for="fn">First Name</label><input id="fn" name="firstName">
  <label for="ln">Last Name</label><input id="ln" name="lastName">
  <label for="em">Email</label><input id="em" type="email" name="email">`;

console.log("\nA salary question whose choices are amounts");
{
  const html = `<!doctype html><html><body><h1>Apply</h1><form>${contact}
    <label for="sal">Desired salary</label>
    <select id="sal" name="q_sal"><option value="">Select...</option>
      <option value="1">$80,000 - $100,000 per year</option>
      <option value="2">$100,000 - $120,000 per year</option>
      <option value="3">$120,000 - $140,000 per year</option></select>
    <fieldset><legend>Expected compensation</legend>
      <label><input type="radio" name="q_comp" value="a"> $90k - $110k annually</label>
      <label><input type="radio" name="q_comp" value="b"> $110k - $130k annually</label>
      <label><input type="radio" name="q_comp" value="c"> $130k - $150k annually</label>
    </fieldset></form></body></html>`;
  const r = await fill(html, () => ({
    fn: document.getElementById("fn").value,
    select: document.getElementById("sal").value,
    radio: document.querySelector("input[name=q_comp]:checked")?.value ?? null,
  }));
  check("the form is filled (First Name)", r.fn === "Pradeep", JSON.stringify(r));
  check("a list of salary ranges is not answered with the first range", r.select === "", JSON.stringify(r.select));
  check("nor a row of salary-range radios", r.radio === null, JSON.stringify(r.radio));
}

console.log("\nYes / No radios whose question is the first radio's <label for>");
{
  const html = `<!doctype html><html><body><h1>Apply</h1><form>${contact}
    <div class="question">
      <label for="auth_1" class="q">Are you legally authorized to work in the United States?</label>
      <div><input type="radio" id="auth_1" name="auth" value="1"><label for="auth_1">Yes</label></div>
      <div><input type="radio" id="auth_2" name="auth" value="2"><label for="auth_2">No</label></div>
    </div>
    <div class="question">
      <label for="dl_1" class="q">Do you have a valid driver's license?</label>
      <div><input type="radio" id="dl_1" name="dl" value="1"><label for="dl_1">Yes</label></div>
      <div><input type="radio" id="dl_2" name="dl" value="2"><label for="dl_2">No</label></div>
    </div></form></body></html>`;
  const r = await fill(html, () => ({
    first: window.__applifill.M.radioOptionText(document.getElementById("dl_1")),
    auth: document.querySelector("input[name=auth]:checked")?.id ?? null,
    dl: document.querySelector("input[name=dl]:checked")?.id ?? null,
  }));
  check("the first radio reads as its choice (\"Yes\"), not as the question", r.first === "Yes", JSON.stringify(r.first));
  check("authorized to work: Yes", r.auth === "auth_1", JSON.stringify(r.auth));
  check("driver's license: Yes", r.dl === "dl_1", JSON.stringify(r.dl));
}

console.log("\nA \"Title\" under Licenses and Certifications, and a Prefix list, for a profile with no title of its own");
{
  const html = `<!doctype html><html><body><h1>Apply</h1><form>${contact}
    <section><h2>Licenses and Certifications</h2>
      <div><label for="t1">Title</label><input id="t1" name="cert_title"></div>
      <div><label for="t2">Issuing Organization</label><input id="t2" name="cert_org"></div>
    </section>
    <section><h2>Personal Information</h2>
      <div><label for="pfx">Prefix</label><select id="pfx" name="prefix"><option value="">Select</option><option>Mr.</option><option>Ms.</option><option>Mrs.</option><option>Dr.</option></select></div>
    </section></form></body></html>`;
  const r = await fill(html, () => ({ cert: document.getElementById("t1").value, prefix: document.getElementById("pfx").value }));
  check("the certification's Title is not given an honorific", !/^m[rsx]\.?$/i.test(r.cert), JSON.stringify(r.cert));
  check("the Prefix is not guessed from the applicant's gender", r.prefix === "", JSON.stringify(r.prefix));
}

console.log("\nCheck boxes: background check, drug test, a preferred name, declining to give one's race");
{
  const html = `<!doctype html><html><body><h1>Apply</h1><form>${contact}
    <div><input type="checkbox" id="bg" name="bg"><label for="bg">I authorize Acme to conduct a background check as a condition of employment.</label></div>
    <div><input type="checkbox" id="dt" name="dt"><label for="dt">I agree to submit to a pre-employment drug test.</label></div>
    <div><input type="checkbox" id="pn" name="pn"><label for="pn">I have a preferred or chosen name</label></div>
    <div><input type="checkbox" id="dr" name="dr"><label for="dr">I choose not to disclose my race or ethnicity</label></div>
  </form></body></html>`;
  const r = await fill(html, () => Object.fromEntries(["bg", "dt", "pn", "dr"].map((id) => [id, document.getElementById(id).checked])));
  check("the background-check box is left for the applicant to tick", r.bg === false, JSON.stringify(r));
  check("so is the drug-test box", r.dt === false, JSON.stringify(r));
  check("and \"I have a preferred or chosen name\"", r.pn === false, JSON.stringify(r));
  check("and \"I choose not to disclose my race\"", r.dr === false, JSON.stringify(r));
}

console.log("\nA form drawn inside the page's own shadow root, with two Work Experience rows");
{
  const html = `<!doctype html><html><body><h1>Apply</h1><app-root></app-root>
  <script>
    customElements.define("app-root", class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = \`<form>
          <label for="fn">First Name</label><input id="fn" name="firstName">
          <label for="ln">Last Name</label><input id="ln" name="lastName">
          <label for="em">Email</label><input id="em" type="email" name="email">
          <h3>Work Experience 1</h3>
          <div class="row"><label for="c1">Company</label><input id="c1" name="company_a">
            <label for="ti1">Title</label><input id="ti1" name="title_a"></div>
          <h3>Work Experience 2</h3>
          <div class="row"><label for="c2">Company</label><input id="c2" name="company_b">
            <label for="ti2">Title</label><input id="ti2" name="title_b"></div>
          <label for="zz">Favourite colour</label><input id="zz" name="zz">
        </form>\`;
      }
    });
  </script></body></html>`;
  const r = await fill(html, () => {
    const root = document.querySelector("app-root").shadowRoot;
    const v = (id) => root.getElementById(id).value;
    const fields = window.__applifill.state.allFields;
    const at = (id) => fields.find((f) => f.el.id === id);
    return {
      c1: v("c1"), c2: v("c2"), ti1: v("ti1"), ti2: v("ti2"),
      rows: ["c1", "c2", "ti1", "ti2"].map((id) => `${id}:${at(id)?.rule?.key}:${at(id)?.index}`),
      rootClasses: Array.from(window.__rootClasses),
    };
  }, { url: "https://careers.example.com/apply" });
  check("the job titles are read as job titles, one per row",
    r.rows.join(" ") === "c1:currentCompany:0 c2:currentCompany:1 ti1:currentTitle:0 ti2:currentTitle:1", JSON.stringify(r.rows));
  check("no job title box is given an honorific", !/^m[rsx]\.?$/i.test(r.ti1) && !/^m[rsx]\.?$/i.test(r.ti2), JSON.stringify([r.ti1, r.ti2]));
  check("the second job's box never takes the first job's company", r.c2 !== "Globex", JSON.stringify(r.c2));
  check("the page's own app element is never outlined or flashed", !r.rootClasses.some((c) => /^applifill-/.test(c)), JSON.stringify(r.rootClasses));
  check("no page errors", r.errors.length === 0, JSON.stringify(r.errors));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
