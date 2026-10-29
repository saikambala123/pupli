/** Real schema/normalizer and extension helper regressions; no server required. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import vm from "node:vm";
import mongoose from "mongoose";
import { BSON } from "mongodb/lib/bson.js";
import ts from "typescript";

register(new URL("../scripts/ts-loader.mjs", import.meta.url));
const schemaSource = await readFile(new URL("../src/models/Profile.ts", import.meta.url), "utf8");
const schemaJS = ts.transpileModule(schemaSource, {compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true}}).outputText;
const schemaExports = {};
vm.runInThisContext(`(function(require,exports){${schemaJS}\n})`)(createRequire(import.meta.url), schemaExports);
const Profile = schemaExports.default;
const { normalizeParsedResume } = await import("../src/lib/profile-shape.ts");
let total = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS ${name}`);
  total++;
}

const declarations = { highSchoolDiplomaOrGED: "No", jobNotifications: "Yes", textMessageConsent: "Yes", signedNonCompete: "No", employmentTermination: "Yes", workplaceMisconduct: "No" };
const doc = new Profile({ userId: new mongoose.Types.ObjectId(), label: "Verification", workAuth: declarations });
await doc.validate();
const stored = BSON.deserialize(BSON.serialize(doc.toObject()));
const reloaded = Profile.hydrate(stored);
const countyProfile = new Profile({ personal: { county: "Gaston" } });
check("county survives Mongoose/BSON serialization", Profile.hydrate(BSON.deserialize(BSON.serialize(countyProfile.toObject()))).personal.county, "Gaston");
check("county survives profile normalization", normalizeParsedResume({personal:{county:"Gaston"}}).personal.county, "Gaston");
for (const [key, value] of Object.entries(declarations)) {
  check(`${key} survives Mongoose/BSON serialization`, reloaded.workAuth[key], value);
  check(`${key} survives profile normalization`, normalizeParsedResume({workAuth: declarations}).workAuth[key], value);
  check(`${key} has no implied answer`, new Profile().workAuth[key], undefined);
  const invalid = new Profile({workAuth: {[key]: "Maybe"}}).validateSync();
  check(`${key} rejects invalid declarations`, Boolean(invalid?.errors[`workAuth.${key}`]), true);
}
reloaded.workAuth.textMessageConsent = "";
await reloaded.validate();
check("consent can be cleared", reloaded.workAuth.textMessageConsent, "");

for (const [raw, country, code, national] of [
  ["+16305550142", "United States", "+1", "6305550142"],
  ["+1 630-555-0142", "United States", "+1", "630-555-0142"],
  ["+919876543210", "India", "+91", "9876543210"],
  ["+442079460958", "United Kingdom", "+44", "2079460958"],
  ["6305550142", "United States", "", "6305550142"],
  ["+358401234567", "", "", "+358401234567"],
]) {
  const parsed = normalizeParsedResume({personal: {phone: raw, country}}).personal;
  check(`${raw} preserves national digits`, parsed.phone, national);
  check(`${raw} calling code`, parsed.phoneCountryCode, code);
}

const context = vm.createContext({ console, setTimeout, clearTimeout, URL,
  location: {hostname: "careers.example.test", pathname: "/apply"},
  document: {body: {}, querySelector: () => null},
});
for (const file of ["matcher.js", "field-map.js"]) {
  vm.runInContext(await readFile(new URL(`../extension/lib/${file}`, import.meta.url), "utf8"), context);
}
const M = context.APPLI_FILL_MATCHER;
const rules = context.APPLI_FILL_FIELD_MAP;
const phone = rules.helpers.phoneForBox;
const box = (attributes = {}, picker) => ({ type: attributes.type || "tel", getAttribute: k => attributes[k] ?? null,
  parentElement: picker ? {parentElement: null, querySelectorAll: () => [picker]} : null });
const picker = {nodeType: 1, tagName: "INPUT", id: "countryPhoneCode", value: "United States (+1)", getAttribute: () => null};
check("known country picker strips only its code", phone("+16305550142", box({}, picker), "+1"), "6305550142");
check("a conflicting calling code never produces a wrong international number", phone("+97455550147", box({}, picker), "+1"), null);
check("an international number without a calling-code picker stays intact", phone("+97455550147", box(), "+1"), "+97455550147");
check("unconfigured Workday picker preserves unconstrained phone", phone("+1 630 555 0142", box({}, {...picker,value:""})), "+1 630 555 0142");
context.location.hostname = "myjobs.adp.com";
check("ADP phone with explicit prefix uses national digits", phone("+1 516-205-8456", box({}, {...picker,value:"US"})), "5162058456");
context.location.hostname = "careers.example.test";
for (const [raw, code, expected] of [["+16305550142","+1","6305550142"],["+919876543210","+91","9876543210"]]) {
  check(`${code} maxlength and pattern`, phone(raw, box({maxlength:"10",pattern:"[0-9]{10}"}), code), expected);
}
check("phone matching a punctuation mask", phone("+16305550142", box({pattern:"\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}"}), "+1"), "(630) 555-0142");
check("phone is never truncated to fit", phone("+16305550142", box({maxlength:"5"}), "+1"), null);
check("invalid negative maxlength has no limit", phone("6305550142", box({maxlength:"-1"})), "6305550142");
check("plain phone keeps international prefix", phone("+919876543210", box(), "+91"), "+919876543210");
check("number input receives digits", phone("+1 630-555-0142", box({type:"number"}), "+1"), "16305550142");
for (const text of ["Master's Degree", "Masters Degree", "Bachelor's Degree", "Bachelors Degree"]) {
  const normalized = M.normalizeChoiceText(text);
  check(`normalizing ${text} is idempotent`, M.normalizeChoiceText(normalized), normalized);
}
check("No Selection is empty", M.isPlaceholderChoice("No Selection"), true);
check("None is a valid clearance", M.isPlaceholderChoice("None", "Security Clearance"), false);
check("Select is still an empty clearance", M.isPlaceholderChoice("Select", "Security Clearance"), true);
check("opt-out wording reverses explicit consent", rules.find(r=>r.key==="textMessageConsent").value({workAuth:declarations},null,"I do not want to receive text messages"), "No");
for (const key of ["textMessageConsent", "restrictiveCovenant", "employmentTermination", "workplaceMisconduct", "securityClearance"]) {
  const rule = rules.find(r=>r.key===key);
  check(`${key} requires a profile or saved declaration`, rule.profileOnly, true);
  check(`${key} does not invent an answer`, rule.value({}), null);
}


const preferences = {personal:{aliases:"Known alias",preferredLanguage:"English"},workAuth:{profileVisibility:"Only recruiters managing jobs I apply to",referrerFirstName:"Alex",referrerLastName:"Taylor",referrerEmployeeId:"EMP-42"},eeo:{ethnicity:"Not Hispanic or Latino",genderIdentity:"Man",sexualOrientation:"Heterosexual",transgender:"No"}};
const preferenceDoc = Profile.hydrate(BSON.deserialize(BSON.serialize(new Profile(preferences).toObject())));
const normalizedPreferences = normalizeParsedResume(preferences);
for (const [section, values] of Object.entries(preferences)) {
  for (const [key, value] of Object.entries(values)) {
    check(`${section}.${key} persists`, preferenceDoc[section][key], value);
    check(`${section}.${key} normalizes`, normalizedPreferences[section][key], value);
  }
}

const diplomaRule = rules.find(r=>r.key==="highSchoolDiplomaOrGED");
check("diploma answer has no assumed value", diplomaRule.value({}), null);
check("negative diploma question reverses Yes", diplomaRule.value({workAuth:{highSchoolDiplomaOrGED:"Yes"}},null,"Do you not have a high school diploma or GED?"), "No");
check("negative diploma question reverses No", diplomaRule.value({workAuth:{highSchoolDiplomaOrGED:"No"}},null,"Do you not have a high school diploma or GED?"), "Yes");
console.log(`${total}/${total} career profile/helper checks passed`);
