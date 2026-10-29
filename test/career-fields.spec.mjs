/** Screenshot regressions. Offline Chromium DOM/model tests, no live applications. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixture, PROFILE } from "./portals/harness.mjs";

const dir = await mkdtemp(join(tmpdir(), "applifill-career-fields-"));
let failures = 0, total = 0;
const check = (name, actual, expected) => {
  total++;
  try { assert.deepEqual(actual, expected); console.log(`PASS ${name}`); }
  catch { failures++; console.error(`FAIL ${name}: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`); }
};
const input = (id, label, attrs = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
const select = (id, label, options, placeholder = "No Selection") => `<div class="field"><label for="${id}">${label}</label><select id="${id}"><option value="-1">${placeholder}</option>${options.map((v) => `<option>${v}</option>`).join("")}</select></div>`;
const pageHTML = (body) => `<!doctype html><html><head><title>Career application regression</title><style>body{font:16px sans-serif;margin:30px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.field{margin:10px 0}label{display:block}input,select{font:inherit;width:90%;padding:7px}button{padding:10px}h2{margin-top:30px}</style></head><body><h1>Career application</h1><form>${body}<button type="submit">Apply</button></form><script>window.model={};window.submitted=0;document.addEventListener('change',e=>{if(e.target.id)window.model[e.target.id]=e.target.type==='checkbox'?e.target.checked:e.target.value});document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submitted++});document.querySelectorAll('button[aria-controls]').forEach(b=>b.addEventListener('click',()=>{document.getElementById(b.getAttribute('aria-controls')).hidden=false;b.setAttribute('aria-expanded','true')}));</script></body></html>`;
const profile = {
  ...PROFILE,
  personal: { ...PROFILE.personal, phone: "+1 630-555-0142", phoneCountryCode: "+1" },
  workAuth: { ...PROFILE.workAuth, securityClearance: "None", textMessageConsent: "Yes", signedNonCompete: "Yes", employmentTermination: "No", workplaceMisconduct: "No" },
  education: [{ school: "Example University", degree: "Bachelor's Degree", fieldOfStudy: "Computer Science", startDate: "2015-08", endDate: "2019-05", gpa: "3.8", location: "Austin, Texas, United States" }],
  experience: [{ company: "Example Employer", title: "Engineer", startDate: "2020-01", endDate: "2025-08", current: false, location: "Seattle, Washington, United States" }],
};
async function fixture(name, body, p = profile, extra = {}) {
  const path = join(dir, `${name}.html`);
  await writeFile(path, pageHTML(body));
  return runFixture(path, { profile: p, responses: [], url: "https://career55.sapsf.eu/portalcareer?company=test", ...extra });
}
async function value(page, id) { return page.locator(`#${id}`).inputValue(); }

try {
  const { browser, page, runResult } = await fixture("screenshot", `
    <h2>Profile Information</h2><div class="grid">
    ${input("fn", "First Name", 'required')}${input("ln", "Last Name", 'required')}${input("em", "Email", 'type="email" required')}
    ${select("dial", "Country Code", ["+1", "+91"])}${input("ph", "Phone Number", 'type="tel" maxlength="10" pattern="[0-9]{10}" required')}
    ${select("homeCountry", "Country/Region", ["United States", "India"])}${select("homeState", "State / Province", ["North Carolina", "Texas"])}${input("homeCity", "City")}</div>
    <section><h2><button type="button" aria-expanded="false" aria-controls="history">Professional Experience</button></h2><div id="history" hidden class="grid">
    ${input("jobTitle", "Title")}${input("employer", "Current Employer")}${input("jobStart", "Start Date", 'placeholder="MM/DD/YYYY"')}${input("jobEnd", "End Date", 'placeholder="MM/DD/YYYY"')}
    ${select("jobCountry", "Country/Region", ["India", "United States"])}${select("jobState", "State", ["North Carolina", "Washington"])}${input("jobCity", "City")}</div></section>
    <section><h2><button type="button" aria-expanded="false" aria-controls="academic">Education</button></h2><div id="academic" hidden class="grid">
    ${select("eduType", "Education Type", ["Post Graduation", "Graduation", "High School"])}${select("degree", "Degree", ["Bachelors Degree", "Masters Degree"])}${input("school", "College/University")}${select("major", "Major", ["Computer Science", "Mechanical Engineering"])}
    ${input("eduStart", "Start Date", 'placeholder="MM/DD/YYYY"')}${input("eduEnd", "End Date", 'placeholder="MM/DD/YYYY"')}${input("score", "Final Score (CGPA/Percentage)")}${input("passing", "Year Of Passing", 'placeholder="MM/DD/YYYY"')}
    ${select("eduCountry", "Country", ["India", "United States"])}${select("eduState", "State", ["North Carolina", "Texas"])}${input("eduCity", "City")}</div></section>
    <section><h2>Job-Specific Information</h2><div class="grid">${select("authorized", "Are you legally authorized to work in the country/region of the job for which you are applying?", ["Yes", "No"])}${select("sponsorship", "Will you now or in the future require sponsorship for an employment Visa?", ["Yes", "No"])}${select("clearance", "Security Clearance", ["None", "Secret", "Top Secret", "TS/SCI"], "Select")}${select("education", "Education", ["High School", "Bachelor's Degree", "Master's Degree"], "Select")}</div></section>
    <section><h2>Application Questions</h2>${input("sms", "I consent to receive text messages about my job application", 'type="checkbox"')}${select("agreement", "Have you signed a non-compete agreement?", ["Yes", "No"])}${select("termination", "Have you ever been terminated from employment?", ["Yes", "No"])}${select("misconduct", "Have you ever been terminated or disciplined for harassment or workplace violence?", ["Yes", "No"])}</section>`);
  try {
    check("sapsf.eu detection", runResult.ats, "sapSuccessFactors");
    const expected = {fn: PROFILE.personal.firstName, ln: PROFILE.personal.lastName, em: PROFILE.personal.email,
      dial: "+1", ph: "6305550142", homeCountry: "United States", homeState: "North Carolina", homeCity: PROFILE.personal.city,
      jobTitle: "Engineer", employer: "Example Employer", jobStart: "01/01/2020", jobEnd: "08/01/2025", jobCountry: "United States", jobState: "Washington", jobCity: "Seattle",
      eduType: "Graduation", degree: "Bachelors Degree", school: "Example University", major: "Computer Science", eduStart: "08/01/2015", eduEnd: "05/01/2019", score: "3.8", passing: "05/01/2019", eduCountry: "United States", eduState: "Texas", eduCity: "Austin",
      authorized: "Yes", sponsorship: "No", clearance: "None", education: "Bachelor's Degree", agreement: "Yes", termination: "No", misconduct: "No"};
    for (const [id, want] of Object.entries(expected)) check(id, await value(page, id), want);
    check("SMS explicit consent", await page.locator("#sms").isChecked(), true);
    check("phone constraints", await page.locator("#ph").evaluate(el => el.checkValidity()), true);
    const model = await page.evaluate(() => window.model);
    for (const id of ["ph", "clearance", "education", "agreement", "school", "eduState"]) check(`${id} change event reaches portal model`, model[id], expected[id]);
    check("no automatic application submission", await page.evaluate(() => window.submitted), 0);
    await page.locator("#ph").fill("2125550199");
    await page.locator("#ph").blur();
    await page.evaluate(() => window.__applifill.run({manual:true}));
    check("manual phone edit preserved", await value(page, "ph"), "2125550199");
    check("None clearance survives another run", await value(page, "clearance"), "None");
    if (process.env.APPLI_FILL_SCREENSHOT) await page.screenshot({ path: process.env.APPLI_FILL_SCREENSHOT, fullPage: true });
    if (process.env.ZDEBUG) console.log(JSON.stringify(await page.evaluate(() => window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f => ({id:f.el.id,label:f.label,key:f.rule?.key,index:f.index,profileValue:f.rule?.value(window.__applifill.state.fillProfile,f.el,f.label,f.index),plan:window.__applifill.planField(f,window.__applifill.state.fillProfile,{})}))),null,2));
  } finally { await browser.close(); }

  for (const [name, phone, code, want] of [["US", "+16305550142", "+1", "6305550142"], ["India", "+919876543210", "+91", "9876543210"]]) {
    const p = {...profile, personal: {...profile.personal, phone, phoneCountryCode: code}};
    const r = await fixture(name, `${input("bounded", "Phone Number", 'type="tel" maxlength="10" pattern="[0-9]{10}"')}${input("numeric", "Mobile number", 'type="number"')}${input("plain", "Telephone", 'type="tel"')}`, p, {url:"https://careers.example.test/apply"});
    try {
      check(`${name} constrained phone has all national digits`, await value(r.page,"bounded"), want);
      check(`${name} plain phone keeps country code`, await value(r.page,"plain"), phone);
      check(`${name} numeric phone has no formatting`, await value(r.page,"numeric"), phone.replace(/\D/g,""));
    } finally { await r.browser.close(); }
  }
  const unchosen = {...profile, workAuth:{}};
  const q = `${input("sms", "I would like to receive text messages about my job application", 'type="checkbox"')}${select("agreement", "Have you signed a non-compete agreement?",["Yes","No"])}${select("termination", "Have you ever been terminated from employment?",["Yes","No"])}`;
  for (const [name, p, checked, answer] of [["unset",unchosen,false,"-1"],["declined",{...profile,workAuth:{textMessageConsent:"No",signedNonCompete:"No",employmentTermination:"Yes"}},false,"No"]]) {
    const r=await fixture(name,q,p);
    try {
      check(`${name} SMS`,await r.page.locator("#sms").isChecked(),checked);
      check(`${name} non-compete`,await value(r.page,"agreement"),answer);
      check(`${name} termination`,await value(r.page,"termination"),name==="unset"?"-1":"Yes");
    }finally {await r.browser.close();}
  }
} finally { await rm(dir,{recursive:true,force:true}); }
console.log(`${total-failures}/${total} career field checks passed`);
process.exitCode=failures?1:0;
