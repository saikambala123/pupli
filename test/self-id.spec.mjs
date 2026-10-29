/**
 * Voluntary self-identification and EEO regression suite.
 *
 *   node test/self-id.spec.mjs
 *
 * Locks in the four reports from the Manulife / John Hancock Workday form:
 *
 *   - the veteran dropdown answered "I IDENTIFY AS A VETERAN, JUST NOT A
 *     PROTECTED VETERAN" for a non-veteran, because that option and "I AM NOT
 *     A PROTECTED VETERAN" reduced to the same id and scored identically;
 *   - the race dropdown answered "American Indian or Alaska Native" for an
 *     applicant whose profile says Asian, because race had no canonical
 *     domain and fell through to token overlap;
 *   - the CC-305 "Name" box was filled with "Yes" and "Employee ID" with the
 *     applicant's name, because both were unmatched and handed to the model;
 *   - the CC-305 "Date" box was never filled at all.
 *
 * Runs without a browser: the matcher and rule table are pure, and the two
 * DOM stubs below carry only the surface the code under test reads.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const sb = {
  document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
  setTimeout, clearTimeout, console,
  HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
  Event: class { constructor(t) { this.type = t; } },
  KeyboardEvent: class {}, MouseEvent: class {}, FocusEvent: class {},
  CSS: { escape: (s) => s },
};
sb.window = sb;
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(readFileSync(join(EXT, "lib/matcher.js"), "utf8"), sb);
vm.runInContext(readFileSync(join(EXT, "lib/field-map.js"), "utf8"), sb);
const M = sb.APPLI_FILL_MATCHER;
const RULES = sb.APPLI_FILL_FIELD_MAP;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

/* A control: matchRule reads only tagName, type and getAttribute. */
const el = (type = "text", attrs = {}) => ({
  tagName: type === "textarea" ? "TEXTAREA" : type === "select" ? "SELECT" : "INPUT",
  type, isContentEditable: false,
  getAttribute: (k) => (k === "type" ? type : attrs[k] ?? null),
  closest: () => null, querySelector: () => null,
});

/* A <select>: assigning .value moves selectedIndex, as the real one does. */
function makeSelect(texts) {
  const options = texts.map((t, i) => ({ textContent: t, value: t, index: i }));
  const node = {
    tagName: "SELECT", options, selectedIndex: 0,
    focus() {}, blur() {}, dispatchEvent() { return true; },
    getAttribute() { return null; }, setAttribute() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  Object.defineProperty(node, "value", {
    get() { return node.options[node.selectedIndex]?.value ?? ""; },
    set(v) { const i = node.options.findIndex((o) => o.value === v); if (i !== -1) node.selectedIndex = i; },
  });
  return node;
}
const pick = (texts, want, hint) => {
  const node = makeSelect(texts);
  return M.setSelectValue(node, want, undefined, hint) ? node.options[node.selectedIndex].textContent : null;
};

const PROFILE = {
  personal: { firstName: "Subhash", lastName: "Yalamadala", email: "subhash.yala19@gmail.com" },
  eeo: { race: "Asian", gender: "Male", veteranStatus: "I am not a protected veteran", disabilityStatus: "No" },
};
const SEC = "Voluntary Self-Identification of Disability | Form CC-305 | OMB Control Number 1250-0005";
const plan = (label, control = el()) => {
  const rule = M.matchRule(control, label, RULES);
  if (!rule) return { key: null, value: null, blank: false, identity: false };
  let value = null;
  try { value = rule.value(PROFILE, control, label, 0); } catch {}
  return { key: rule.key, value, blank: !!rule.blank, identity: !!rule.identity };
};

const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const TODAY_US = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const TODAY_ISO = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

console.log("\nCC-305 block");
check("Name matches the self-ID rule", plan(`Name | ${SEC}`).key, "selfIdName");
check("Name is the applicant's legal name", plan(`Name | ${SEC}`).value, "Subhash Yalamadala");
check("Employee ID matches its own rule", plan(`Employee ID (if applicable) | ${SEC}`).key, "employeeId");
check("Employee ID is left blank", plan(`Employee ID (if applicable) | ${SEC}`).blank, true);
check("Date matches the self-ID date rule", plan(`Date | ${SEC}`).key, "selfIdDate");
check("Date is today, MM/DD/YYYY", plan(`Date | ${SEC}`).value, TODAY_US);
check("Date is ISO for a native date input", plan(`Date | ${SEC}`, el("date")).value, TODAY_ISO);

console.log("\nthe same labels elsewhere are unaffected");
check("a bare Name still resolves to fullName", plan("Name").key, "fullName");
check("a bare Date is still left alone", plan("Date").key, null);
check("Graduation Date is not today", plan("Graduation Date").key !== "selfIdDate", true);
check("Employment Start Date is not today", plan("Employment Start Date").key !== "selfIdDate", true);

console.log("\nidentity fields are unreachable by the model");
for (const label of ["First Name", "Email", "Please specify your gender.", "Please specify your veteran status."]) {
  check(`${label} is flagged identity`, plan(label, el(label.includes("specify") ? "select" : "text")).identity, true);
}

console.log("\nEEO canonicalisation");
const VH = "Please specify your veteran status.";
check("classifications option", M.eeoId("I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN", VH), "veteran:protected");
check("veteran-but-not-protected is its own branch", M.eeoId("I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN", VH), "veteran:unprotected");
check("not-a-protected-veteran", M.eeoId("I AM NOT A PROTECTED VETERAN", VH), "veteran:not");
const RH = "Please select one of the following race designations as defined above.";
for (const [option, want] of [
  ["Asian (Not Hispanic or Latino)", "race:asian"],
  ["American Indian or Alaska Native (Not Hispanic or Latino)", "race:americanindian"],
  ["White (Not Hispanic or Latino)", "race:white"],
  ["Black or African American (Not Hispanic or Latino)", "race:black"],
  ["Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)", "race:nativehawaiian"],
  ["Two or More Races (Not Hispanic or Latino)", "race:twoormore"],
  ["Hispanic or Latino", "race:hispanic"],
]) check(option, M.eeoId(option, RH), want);
const DH = "Voluntary Self-Identification of Disability";
check("'I do not want to answer' is a decline", M.eeoId("I do not want to answer", DH), "decline");
check("'I do not wish to answer' is a decline", M.eeoId("I do not wish to answer", DH), "decline");

console.log("\nveteran dropdown");
const VET = [
  "Select One",
  "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN",
  "I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN",
  "I AM NOT A PROTECTED VETERAN",
  "I DON'T WISH TO ANSWER",
];
check("a non-veteran gets the plain 'not' wording", pick(VET, "I am not a protected veteran", VH), "I AM NOT A PROTECTED VETERAN");
check("a decline gets the decline option", pick(VET, "I don't wish to answer", VH), "I DON'T WISH TO ANSWER");
check("a protected veteran gets the classifications option", pick(VET, "I identify as one or more of the classifications of a protected veteran", VH), VET[1]);
check("a non-protected veteran can still reach their wording", pick(VET, "I identify as a veteran, just not a protected veteran", VH), VET[2]);
check("a non-veteran refuses a list offering only the veteran wording", pick([VET[0], VET[2]], "I am not a protected veteran", VH), null);

console.log("\nrace dropdown");
const RACE = [
  "Select One", "Hispanic or Latino", "White (Not Hispanic or Latino)",
  "Black or African American (Not Hispanic or Latino)",
  "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)",
  "Asian (Not Hispanic or Latino)",
  "American Indian or Alaska Native (Not Hispanic or Latino)",
  "Two or More Races (Not Hispanic or Latino)",
];
check("Asian does not land on American Indian", pick(RACE, "Asian", RH), "Asian (Not Hispanic or Latino)");
check("Asian Indian lands on Asian", pick(RACE, "Asian Indian", RH), "Asian (Not Hispanic or Latino)");
check("Two or More Races is not read as Hispanic", pick(RACE, "Two or More Races", RH), "Two or More Races (Not Hispanic or Latino)");
check("American Indian is still reachable", pick(RACE, "American Indian or Alaska Native", RH), RACE[6]);

console.log("\ngender dropdown");
const GEN = ["Select One", "Man", "Woman", "I don't wish to answer"];
check("Male resolves to Man", pick(GEN, "Male", "Please specify your gender."), "Man");
check("Female resolves to Woman", pick(GEN, "Female", "Please specify your gender."), "Woman");

/* ------------------------------------------------------------------ *
 * Oracle Recruiting (egug.fa.us2.oraclecloud.com) contact section.
 *
 *   - the street landed in Address Line 1, 3 AND 4, because the street rule's
 *     `address\\s*(line\\s*)?1?` made the digit optional and only line 2 was
 *     denied;
 *   - Suffix, Tax District, Title and Second Last Name had no rule, so the
 *     answer model filled them — Suffix with "My address is in Bellevue,
 *     Washington, United States." and Tax District with the full address;
 *   - Second Last Name got the applicant's own surname copied into it.
 * ------------------------------------------------------------------ */

console.log("\nOracle Recruiting contact section");
const ADDR = { personal: { ...PROFILE.personal, address: "16243 NE 13TH PLACE", city: "Bellevue", state: "WA", zip: "98008", country: "United States" } };
const planAddr = (label) => {
  const control = el();
  const rule = M.matchRule(control, label, RULES);
  if (!rule) return { key: null, value: null, blank: false };
  let value = null;
  try { value = rule.value(ADDR, control, label, 0); } catch {}
  return { key: rule.key, value, blank: !!rule.blank };
};

check("Address Line 1 takes the street", planAddr("Address Line 1").key, "address");
check("Address Line 2 does not take the street", planAddr("Address Line 2").key !== "address", true);
check("Address Line 3 does not take the street", planAddr("Address Line 3").key !== "address", true);
check("Address Line 4 does not take the street", planAddr("Address Line 4").key !== "address", true);
check("Address Line 3 is left blank", planAddr("Address Line 3").blank, true);
check("Address Line 4 is left blank", planAddr("Address Line 4").blank, true);
check("Tax District is left blank", planAddr("Tax District").blank, true);
check("Tax District is not the address", planAddr("Tax District").value, null);
check("Suffix has its own rule", planAddr("Suffix").key, "nameSuffix");
check("Suffix is empty without a profile value", planAddr("Suffix").value, null);
check("Title has its own rule", planAddr("Title").key, "namePrefix");
check("Second Last Name is not the surname", planAddr("Second Last Name").value, null);
check("Second Last Name is left blank", planAddr("Second Last Name").blank, true);
check("City still fills", planAddr("City").value, "Bellevue");
check("ZIP Code still fills", planAddr("ZIP Code").value, "98008");
check("Legal First Name still fills", planAddr("Legal First Name").value, "Subhash");
check("Legal Last Name still fills", planAddr("Legal Last Name").value, "Yalamadala");

console.log("\nlength caps");
const capped = (max, text) => {
  const node = { tagName: "INPUT", type: "text", value: "", maxLength: max,
    getAttribute: (k) => (k === "maxlength" ? String(max) : k === "type" ? "text" : null),
    focus() {}, blur() {}, select() {}, dispatchEvent() { return true; },
    setAttribute() {}, closest: () => null, isContentEditable: false };
  return M.setTextValue(node, text);
};
check("a value past the field's maxlength is refused", capped(80, "x".repeat(120)), false);
check("a value within the cap is written", capped(80, "Jr."), true);

console.log("\nrace vs Hispanic/Latino routing");
const selNode = el("select");
const WD_RACE =
  "Please select one of the following race designations as defined above. | " +
  "Asian (Not Hispanic or Latino) - A person having origins in any of the original peoples of the Far East | " +
  "American Indian or Alaska Native (Not Hispanic or Latino) - A person having origins in North and South America";
check("Workday race dropdown reaches the race rule", M.matchRule(selNode, WD_RACE, RULES)?.key, "race");
check("a plain Race label reaches the race rule", M.matchRule(selNode, "Race", RULES)?.key, "race");
check("Ethnicity reaches the race rule", M.matchRule(selNode, "Ethnicity", RULES)?.key, "race");
check("the Hispanic yes/no question is left to its own rule", M.matchRule(selNode, "Are you Hispanic or Latino?", RULES)?.key, "hispanicLatino");
check("...even under an Ethnicity heading", M.matchRule(selNode, "Ethnicity | Are you Hispanic or Latino?", RULES)?.key, "hispanicLatino");

console.log("\nwork eligibility");
const auth = RULES.find((r) => r.key === "authorizedToWork");
const spon = RULES.find((r) => r.key === "requireSponsorship");
check("eligibility rules are profile-only", [auth, spon, RULES.find((r) => r.key === "visaStatus"), RULES.find((r) => r.key === "willingToRelocate")].every((r) => r.profileOnly), true);
check("citizenship alone does not answer country-specific authorization", auth.value({ workAuth: { workAuthType: "U.S. Citizen" } }), null);
check("citizenship alone does not answer sponsorship", spon.value({ workAuth: { workAuthType: "U.S. Citizen" } }, null, "Will you require sponsorship?"), null);
check("residency alone does not answer country-specific authorization", auth.value({ workAuth: { workAuthType: "Green Card" } }), null);
check("an explicit stored answer still wins", spon.value({ workAuth: { workAuthType: "U.S. Citizen", requireSponsorship: "Yes" } }, null, "Will you require sponsorship?"), "Yes");
check("nothing recorded stays blank", auth.value({ workAuth: {} }) || null, null);
check("inverted phrasing still requires an explicit answer", spon.value({ workAuth: { workAuthType: "U.S. Citizen" } }, null, "Are you able to work without sponsorship?"), null);
check("inverted phrasing, needs sponsorship", spon.value({ workAuth: { requireSponsorship: "Yes" } }, null, "Are you able to work without sponsorship?"), "No");

/* ------------------------------------------------------------------ *
 * Workday's contact block.
 *
 * It renders Country Phone Code, Phone Number, Phone Device Type and Email
 * beside each other, so every one of those labels lands in every field's
 * derived label. Denials are tested against that whole string, so `phone`'s
 * deny on /country|type/ fired on the phone box itself: the rule was skipped,
 * the box fell through to saved answers, and it came back holding the email
 * address while the number went into the country-code box.
 * ------------------------------------------------------------------ */

console.log("\nWorkday contact block");
const CONTACT = { personal: { email: "a@b.com", phone: "(425) 444-0364", phoneCountryCode: "+1" } };
const contactCase = (label, wantKey, wantValue) => {
  const control = el();
  const rule = M.matchRule(control, label, RULES);
  check(`${label.split("|")[0].trim()} -> ${wantKey}`, rule?.key ?? "UNMATCHED", wantKey);
  if (!rule) return;
  let v = null;
  try { v = rule.value(CONTACT, control, label, 0) ?? null; } catch {}
  check(`  ...and fills ${JSON.stringify(wantValue)}`, v, wantValue);
};
contactCase("Phone Number | Country Phone Code | Phone Device Type", "phone", "(425) 444-0364");
contactCase("Country Phone Code | Phone Number | Phone Device Type", "phoneCountryCode", "+1");
contactCase("Email Address | Phone Number | Country Phone Code", "email", "a@b.com");
contactCase("Phone Extension | Phone Number | Country Phone Code", "phoneExtension", null);

console.log("\na rule matching the field's own label beats one matching its neighbours");
check("First Name among its siblings", M.matchRule(el(), "First Name | Middle Name | Last Name", RULES)?.key, "firstName");
check("Last Name among its siblings", M.matchRule(el(), "Last Name | First Name | Middle Name", RULES)?.key, "lastName");
check("rules spanning two descriptions still work", M.matchRule(el(), "Location | Work Experience 2", RULES)?.key, "experienceLocation");

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
