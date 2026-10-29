/**
 * Application questions answered from the profile — the rules on their own.
 *
 *   node test/app-questions-rules.spec.mjs
 *
 * Reported against 1.16.0: "application questions are not filling". On a
 * Workday Application Questions page most of them were left blank, and some
 * of the ones that were filled were wrong:
 *
 *   - "Have you previously been employed by Leidos?" answered "No" for an
 *     applicant with Leidos on their work history (one stored answer for every
 *     employer);
 *   - "Do you have any relatives currently employed by Leidos?" answered "Yes"
 *     — the "I currently work here" row rule claimed it;
 *   - "Are you currently employed?" answered "No" for someone with a current job;
 *   - Workday's own sponsorship wording ("require the company to sponsor an
 *     immigration case") matched no rule at all;
 *   - federal service, clearance eligibility and the highest level of
 *     education were never answered from what the profile already says;
 *   - a years-of-experience menu of ranges matched nothing.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${ok ? "" : `\n         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

/** The rule table as a page at `host` would load it. */
function load(host = "leidos.wd5.myworkdayjobs.com", path = "/en-US/External/job/Reston-VA/Cloud-Engineer/apply") {
  const sb = {
    location: { hostname: host, pathname: path }, console,
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, documentElement: {} },
    setTimeout, clearTimeout, CSS: { escape: (s) => s },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    Event: class { constructor(t) { this.type = t; } }, KeyboardEvent: class { constructor(t) { this.type = t; } },
    MouseEvent: class { constructor(t) { this.type = t; } }, FocusEvent: class { constructor(t) { this.type = t; } },
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(readFileSync(join(EXT, "lib/field-map.js"), "utf8"), sb);
  vm.runInContext(readFileSync(join(EXT, "lib/matcher.js"), "utf8"), sb);
  return { RULES: sb.APPLI_FILL_FIELD_MAP, M: sb.APPLI_FILL_MATCHER };
}

const { RULES, M } = load();
const rule = (key, rules = RULES) => rules.find((r) => r.key === key);

/** Does `key` claim this label on its own patterns and denials? */
const claims = (key, label, rules = RULES) => {
  const r = rule(key, rules);
  const hit = r.match.some((re) => re.test(label));
  const denied = (r.deny || []).some((d) => (typeof d === "function" ? d(label) : d.test(label)));
  return hit && !denied;
};
const value = (key, profile, label, rules = RULES) => rule(key, rules).value(profile, null, label, 0) ?? null;

const PROFILE = {
  personal: { citizenship: "United States" },
  workAuth: { previouslyEmployedHere: "No", securityClearance: "None", workAuthType: "U.S. Citizen" },
  eeo: {},
  experience: [
    { company: "Amazon Web Services", title: "Cloud Engineer", startDate: "2021-05", current: true },
    { company: "Leidos, Inc.", title: "Systems Engineer", startDate: "2018-06", endDate: "2021-04" },
    { company: "U.S. Army", title: "Signal Support Specialist", startDate: "2012-01", endDate: "2016-12" },
  ],
  education: [
    { school: "UNC Charlotte", degree: "Master of Science", endDate: "2018-05" },
    { school: "JNTU", degree: "B.Tech", endDate: "2011-05" },
  ],
};

/* ------------------------------------------------------------------ */
console.log("\nWorked for this employer before — read from the work history");

check("named employer on the history → Yes (former)",
  value("previouslyEmployed", PROFILE, "Are you currently or have you previously been employed by Leidos or any of its subsidiaries?"),
  "Yes, former employee");
check("the current employer → Yes (current)",
  value("previouslyEmployed", PROFILE, "Have you ever worked for Amazon or any of its subsidiaries?"), "Yes, current employee");
check("\"currently employed by\" a past employer → the stored No",
  value("previouslyEmployed", PROFILE, "Are you currently employed by Leidos?"), "No");
check("a window the job ended before → the stored No",
  value("previouslyEmployed", PROFILE, "Have you been employed by Leidos in the last 12 months?"), "No");
check("an employer not on the history → the stored No",
  value("previouslyEmployed", PROFILE, "Have you ever worked at Pineapple Labs?"), "No");
check("\"this company\" on a Workday tenant uses the tenant",
  value("previouslyEmployed", PROFILE, "Have you previously worked for this company?"), "Yes, former employee");
check("nothing stored and no match → left for the applicant",
  value("previouslyEmployed", { ...PROFILE, workAuth: {} }, "Have you ever worked at Pineapple Labs?"), null);

{
  const gdit = load("gdit.wd5.myworkdayjobs.com").RULES;
  const onHistory = { ...PROFILE, experience: [{ company: "General Dynamics Information Technology", startDate: "2014-01", endDate: "2017-06" }] };
  check("an acronym tenant matches the full name (GDIT)",
    value("previouslyEmployed", onHistory, "Have you previously worked for this company?", gdit), "Yes, former employee");
  check("an acronym in the question matches the full name",
    value("previouslyEmployed", onHistory, "Are you a current or former employee of GDIT?"), "Yes, former employee");
  const booz = load("boozallen.wd1.myworkdayjobs.com").RULES;
  check("a joined-up tenant matches the spaced name (boozallen)",
    value("previouslyEmployed", { ...PROFILE, experience: [{ company: "Booz Allen Hamilton", startDate: "2015-01", endDate: "2017-01" }] },
      "Are you a former employee?", booz), "Yes, former employee");
  const helpers = RULES.helpers;
  check("\"Apple\" is not \"Pineapple Labs\"", helpers.sameEmployer("Apple", "Pineapple Labs"), false);
  check("\"Meta\" is \"Meta Platforms, Inc.\"", helpers.sameEmployer("Meta", "Meta Platforms, Inc."), true);
  check("\"Solutions\" alone identifies nobody", helpers.sameEmployer("Solutions", "Acme Solutions"), false);
  check("the employer a question names", helpers.employerNamedIn("Have you previously been employed by GDIT or any of its predecessor companies?"), "GDIT");
  check("a government is not an employer name", helpers.employerNamedIn("Have you ever been employed by the U.S. Federal Government?"), null);
}

check("the prior-employment rule claims \"current or former employee of X\"",
  claims("previouslyEmployed", "Are you a current or former employee of Leidos?"), true);
check("…and \"this company\" / \"a former employee\"",
  claims("previouslyEmployed", "Have you previously worked for this company?") && claims("previouslyEmployed", "Are you a former employee?"), true);
check("…but not a question about a skill (\"ever worked with Kubernetes\")",
  claims("previouslyEmployed", "Have you ever worked with Kubernetes?"), false);
check("…nor one about a kind of company", claims("previouslyEmployed", "Have you ever worked for a startup before?"), false);
check("\"worked with\" names a tool, not an employer", RULES.helpers.employerNamedIn("Have you ever worked with Kubernetes?"), null);
check("\"employed with\" does name an employer", RULES.helpers.employerNamedIn("Have you been employed with Accenture?"), "Accenture");
check("…but never a federal-government question",
  claims("previouslyEmployed", "Have you ever been employed by the U.S. Federal Government (military or civilian)?"), false);

/* ------------------------------------------------------------------ */
console.log("\nFederal service");

const FED = "Have you ever been employed by the U.S. Federal Government (military or civilian)?";
check("the question is claimed", claims("federalEmployment", FED), true);
check("Army service, question includes military → Yes", value("federalEmployment", PROFILE, FED), "Yes");
check("Army service, question about civilian employment only → left open",
  value("federalEmployment", PROFILE, "Are you a current or former federal government employee?"), null);
check("a civilian agency → Yes", value("federalEmployment",
  { ...PROFILE, experience: [{ company: "Department of Veterans Affairs", startDate: "2015-01", endDate: "2019-01" }] },
  "Are you a current or former federal government employee?"), "Yes");
check("a GS grade in the title → Yes", value("federalEmployment",
  { ...PROFILE, experience: [{ company: "Fort Meade", title: "IT Specialist (GS-2210-12)", startDate: "2015-01", endDate: "2019-01" }] },
  "Are you a current or former federal government employee?"), "Yes");
check("a history with no government employer → No", value("federalEmployment",
  { ...PROFILE, experience: [{ company: "Accenture", startDate: "2015-01", current: true }] }, FED), "No");
check("Navy Federal Credit Union is not the Navy", value("federalEmployment",
  { ...PROFILE, experience: [{ company: "Navy Federal Credit Union", startDate: "2015-01", current: true }] }, FED), "No");
check("no history at all → left open", value("federalEmployment", { ...PROFILE, experience: [] }, FED), null);
check("a declared veteran with an empty history → Yes when military counts",
  value("federalEmployment", { ...PROFILE, experience: [], eeo: { veteranStatus: "I identify as one or more of the classifications of protected veteran" } }, FED), "Yes");
check("\"not a protected veteran\" is not evidence of service",
  value("federalEmployment", { ...PROFILE, experience: [], eeo: { veteranStatus: "I am not a protected veteran" } }, FED), null);
check("a window the service ended before → No",
  value("federalEmployment", PROFILE, "Have you been employed by the U.S. Government, including the military, in the last two years?"), "No");
check("federal contracts are a different question",
  claims("federalEmployment", "Have you ever worked on a federal government contract?"), false);
check("the answer is shown as a draft to review", rule("federalEmployment").review, true);

/* ------------------------------------------------------------------ */
console.log("\nSecurity clearance");

const OBTAIN = "If you do not currently hold a security clearance, are you able to obtain one?";
check("a U.S. citizen without one is able to obtain one", value("securityClearance", PROFILE, OBTAIN), "Yes");
check("a visa holder is not", value("securityClearance", { ...PROFILE, workAuth: { securityClearance: "None", workAuthType: "H-1B" } }, OBTAIN), "No");
check("no recorded status → left open", value("securityClearance", { ...PROFILE, personal: {}, workAuth: { securityClearance: "None" } }, OBTAIN), null);
check("a held clearance → Yes", value("securityClearance", { ...PROFILE, workAuth: { securityClearance: "Secret" } }, OBTAIN), "Yes");
check("eligibility is answered even with no clearance field at all", value("securityClearance", { ...PROFILE, workAuth: { workAuthType: "U.S. Citizen" } }, OBTAIN), "Yes");
check("an active-clearance question still answers from the level held",
  value("securityClearance", PROFILE, "Do you currently hold an active U.S. Government security clearance?"), "No");

/* ------------------------------------------------------------------ */
console.log("\nHighest level of education");

const EDU = "What is the highest level of education you have completed?";
check("the question goes to the level rule, not the history row", claims("highestEducation", EDU) && rule("highestEducation").weight > rule("degree").weight, true);
check("Master of Science + B.Tech → Master's Degree", value("highestEducation", PROFILE, EDU), "Master's Degree");
check("a PhD in progress does not count as completed", value("highestEducation",
  { ...PROFILE, education: [...PROFILE.education, { degree: "Ph.D.", current: true }] }, EDU), "Master's Degree");
check("…but does for \"highest level of education\" without \"completed\"", value("highestEducation",
  { ...PROFILE, education: [...PROFILE.education, { degree: "Ph.D.", current: true }] }, "Highest level of education"), "Doctorate");
check("B.S. → Bachelor's Degree", value("highestEducation", { education: [{ degree: "B.S. Computer Science" }] }, EDU), "Bachelor's Degree");
check("MBA → Master's Degree", value("highestEducation", { education: [{ degree: "MBA" }] }, EDU), "Master's Degree");
check("Associate of Applied Science → Associate's Degree", value("highestEducation", { education: [{ degree: "Associate of Applied Science" }] }, EDU), "Associate's Degree");
check("no education → left open", value("highestEducation", { education: [] }, EDU), null);

/* ------------------------------------------------------------------ */
console.log("\nSponsorship, in Workday's words");

const SPONSOR = "Will you now or in the future require the company to sponsor an immigration case in order to employ you (for example, H-1B status)?";
check("claimed by the sponsorship rule", claims("requireSponsorship", SPONSOR), true);
check("not claimed by the work-authorization rule", claims("authorizedToWork", SPONSOR), false);
check("answered from the profile", value("requireSponsorship", { workAuth: { requireSponsorship: "No" } }, SPONSOR), "No");
const INVERTED = "Are you able to work in the United States without the company sponsoring a visa?";
check("\"without the company sponsoring\" is the inverted question", value("requireSponsorship", { workAuth: { requireSponsorship: "No" } }, INVERTED), "Yes");
check("…and No for someone who needs sponsorship", value("requireSponsorship", { workAuth: { requireSponsorship: "Yes" } }, INVERTED), "No");
check("sponsoring an event is not immigration", claims("requireSponsorship", "Would your team require us to sponsor an event?"), false);

/* ------------------------------------------------------------------ */
console.log("\nCurrently employed");

check("the row checkbox rule leaves a question about relatives alone",
  claims("currentJob", "Do you have any relatives currently employed by Leidos?"), false);
check("…and \"Are you currently employed?\"", claims("currentJob", "Are you currently employed?"), false);
check("…but still claims \"I currently work here\"", claims("currentJob", "I currently work here"), true);
check("\"Are you currently employed?\" has its own rule", claims("currentlyEmployed", "Are you currently employed?"), true);
check("with a current job → Yes", value("currentlyEmployed", PROFILE, "Are you currently employed?"), "Yes");
check("with only past jobs → No", value("currentlyEmployed",
  { experience: [{ company: "Leidos", startDate: "2018-06", endDate: "2021-04" }] }, "Are you currently employed?"), "No");
check("no history → left open", value("currentlyEmployed", { experience: [] }, "Are you currently employed?"), null);
check("the relatives question is claimed by neither",
  claims("currentlyEmployed", "Do you have any relatives currently employed by Leidos?"), false);

/* ------------------------------------------------------------------ */
console.log("\nYears of experience");

const CAREER = {
  skills: ["AWS", "Kubernetes", "Terraform", "Python"],
  experience: [
    { company: "Amazon Web Services", title: "Cloud Engineer", startDate: "2021-05", current: true, description: "Runs Kubernetes and Terraform on AWS." },
    { company: "Leidos", title: "Systems Engineer", startDate: "2018-06", endDate: "2021-04", description: "Managed Linux servers and migrated workloads to the cloud." },
    { company: "U.S. Army", title: "Signal Support Specialist", startDate: "2012-01", endDate: "2016-12" },
  ],
};
const monthsSince = (y, m) => { const now = new Date(); return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m) + 1; };
const cloudYears = String(Math.max(1, Math.round(monthsSince(2021, 5) / 12)));
const careerYears = String(Math.round((monthsSince(2021, 5) + 35 + 60) / 12));
check("a plain years-of-experience question is the whole career, overlaps counted once",
  value("yearsExperience", CAREER, "How many years of professional experience do you have?"), careerYears);
check("\"cloud engineering\" counts the Cloud Engineer role, not the whole career",
  value("yearsExperience", CAREER, "How many years of professional cloud engineering experience do you have?"), cloudYears);
check("\"with Kubernetes\" counts the roles that describe it, as a listed skill",
  value("yearsExperience", CAREER, "How many years of experience do you have with Kubernetes?"), cloudYears);
check("\"management\" is not read into \"managed the servers\"",
  value("yearsExperience", CAREER, "How many years of management experience do you have?"), null);
check("\"relevant\" needs judgement, not arithmetic",
  value("yearsExperience", CAREER, "How many years of relevant experience do you have?"), null);
check("a topic no role names is left open",
  value("yearsExperience", CAREER, "How many years of Salesforce experience do you have?"), null);

const RANGES = ["Select One", "Less than 2 years", "2-5 years", "6-10 years", "More than 10 years"];
const pick = (answer, options = RANGES) => {
  const scores = M.strictChoiceScores(options, answer);
  if (!scores) return null;
  const best = Math.max(...scores);
  return best > 0 ? options[scores.indexOf(best)] : null;
};
check("13 → More than 10 years", pick("13"), "More than 10 years");
check("10 → 6-10 years", pick("10"), "6-10 years");
check("1 → Less than 2 years", pick("1"), "Less than 2 years");
check("5.5 on whole-year ranges → 2-5 years", pick("5.5"), "2-5 years");
check("\"7 years\" → 6-10 years", pick("7 years"), "6-10 years");
check("10+ style options", pick("12", ["0-3", "4-7", "8-11", "12+"]), "12+");
check("a number with no range to hold it is left unanswered", pick("40", ["0-2 years", "3-5 years"]), null);
check("a menu of months is not a menu of years", pick("3", ["0-6 months", "6-12 months"]), null);
check("words are not ranges", M.strictChoiceScores(["Red", "Blue", "Green"], "3"), null);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
