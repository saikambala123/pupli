/**
 * Choices matched on meaning: states and Yes/No.
 *
 *   node test/canonical-choices.spec.mjs
 *
 * Option scoring compared spellings. "NC" was looked for inside option text,
 * so "MA" picked Maine and "GA" picked Michigan; "No" was a prefix of "North
 * Carolina" and of "None", so a state or a clearance level became a confident
 * "No" on a Yes/No menu. These checks pin the canonical forms and the setters
 * that use them, on native selects, radio groups and a custom listbox alike.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-background-networking"],
});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body><form id='f'></form></body></html>");
await page.addScriptTag({ content: await readFile(join(EXT, "lib/matcher.js"), "utf8") });

/* ------------------------------------------------------------------ */
console.log("\nstates, however they are written");
const regions = await page.evaluate(() => {
  const M = window.APPLI_FILL_MATCHER;
  const loose = (t) => M.regionId(t, { loose: true });
  return {
    NC: M.regionId("NC"), nc: M.regionId("nc"), dots: M.regionId("N.C."), full: M.regionId("North Carolina"),
    paren: M.regionId("North Carolina (NC)"), dash: M.regionId("NC - North Carolina"), us: M.regionId("US-NC"),
    city: loose("Stanley, NC"), cityStrict: M.regionId("Stanley, NC"),
    country: M.regionId("United States"), um: M.regionId("United States Minor Outlying Islands"),
    vi: M.regionId("Virgin Islands, U.S."), dc: M.regionId("Washington, D.C."), wa: M.regionId("Washington"),
    wv: M.regionId("West Virginia"), va: M.regionId("Virginia"), ks: M.regionId("Kansas"), ar: M.regionId("Arkansas"),
    ka: M.regionId("Karnataka"), kaIn: loose("Karnataka, IN"), on: M.regionId("ON"), qc: M.regionId("Québec"),
    name: M.regionName("US-GA"), code: M.regionCode("Massachusetts"),
  };
});
check("NC, nc, N.C. and North Carolina are one state",
  [regions.NC, regions.nc, regions.dots, regions.full, regions.paren, regions.dash, regions.us].every((id) => id === "US-NC"),
  JSON.stringify(regions));
check("a city in front is read from the applicant's own value", regions.city === "US-NC" && regions.cityStrict === null);
check("the country is not a state", regions.country === null);
check("the outlying islands are their own entry", regions.um === "US-UM");
check("Virgin Islands and D.C. in their portal spellings", regions.vi === "US-VI" && regions.dc === "US-DC" && regions.wa === "US-WA");
check("Virginia is not West Virginia, Kansas is not Arkansas",
  regions.va === "US-VA" && regions.wv === "US-WV" && regions.ks === "US-KS" && regions.ar === "US-AR");
check("Indian states by name, with a trailing country code", regions.ka === "IN-karnataka" && regions.kaIn === "IN-karnataka");
check("Canadian provinces by code and accented name", regions.on === "CA-ON" && regions.qc === "CA-QC");
check("an id reads back as the name a menu uses", regions.name === "Georgia" && regions.code === "MA");

/* ------------------------------------------------------------------ */
console.log("\nyes and no");
const yn = await page.evaluate(() => {
  const M = window.APPLI_FILL_MATCHER;
  const ids = {};
  for (const t of ["Yes", "no", "Yes, I am legally authorized", "No, I will not require sponsorship", "None",
    "N/A", "Not sure", "I do not know", "Prefer not to say", "I don't wish to answer", "North Carolina",
    "Norway", "Nothing", "1", "10", "Hybrid", "Secret"]) ids[t] = M.yesNoId(t);
  return {
    ids,
    list1: M.isYesNoList(["Select One", "Yes", "No"]),
    list2: M.isYesNoList(["Yes, full-time", "No", "Prefer not to say"]),
    list3: M.isYesNoList(["Male", "Female"]),
    list4: M.isYesNoList(["Yes", "No", "Other"]),
  };
});
check("plain and sentence-form answers", yn.ids.Yes === "yes" && yn.ids.no === "no" &&
  yn.ids["Yes, I am legally authorized"] === "yes" && yn.ids["No, I will not require sponsorship"] === "no", JSON.stringify(yn.ids));
check("None is a no; N/A, unsure and decline are their own answers",
  yn.ids.None === "no" && yn.ids["N/A"] === "na" && yn.ids["Not sure"] === "maybe" && yn.ids["I do not know"] === "maybe" &&
  yn.ids["Prefer not to say"] === "decline" && yn.ids["I don't wish to answer"] === "decline", JSON.stringify(yn.ids));
check("words that merely begin with 'no' are not answers",
  yn.ids["North Carolina"] === null && yn.ids.Norway === null && yn.ids.Nothing === null && yn.ids["10"] === null,
  JSON.stringify(yn.ids));
check("a Yes/No menu is recognised, with a placeholder or a decline option", yn.list1 && yn.list2);
check("other menus are not Yes/No menus", !yn.list3 && !yn.list4);

/* ------------------------------------------------------------------ */
console.log("\nnative selects");
const selects = await page.evaluate(() => {
  const M = window.APPLI_FILL_MATCHER;
  const make = (options) => {
    const s = document.createElement("select");
    ["", ...options].forEach((t, i) => { const o = document.createElement("option"); o.textContent = t || "Select…"; o.value = i ? t : ""; s.appendChild(o); });
    document.getElementById("f").appendChild(s);
    return s;
  };
  const states = ["Maine", "Maryland", "Massachusetts", "Michigan", "Georgia", "Nevada", "Virginia", "West Virginia", "California", "Iowa"];
  const out = {};
  for (const [value, key] of [["MA", "ma"], ["GA", "ga"], ["VA", "va"], ["IA", "ia"], ["West Virginia", "wv"]]) {
    const s = make(states);
    out[key] = M.setSelectValue(s, value, null, "State") ? s.value : "(none)";
  }
  const coded = make(["AL", "NC", "NY"]);
  out.coded = M.setSelectValue(coded, "North Carolina", null, "State") ? coded.value : "(none)";

  const yesno = () => make(["Yes", "No"]);
  let s = yesno(); out.stateIntoYesNo = M.setSelectValue(s, "North Carolina", null, "Q") ? s.value : "(none)";
  s = yesno(); out.noneIntoYesNo = M.setSelectValue(s, "None", null, "Q") ? s.value : "(none)";
  s = yesno(); out.hybridIntoYesNo = M.setSelectValue(s, "Hybrid", null, "Q") ? s.value : "(none)";
  s = yesno(); out.yes = M.setSelectValue(s, "Yes", null, "Q") ? s.value : "(none)";
  const long = make(["Yes, I will require sponsorship", "No, I will not require sponsorship"]);
  out.long = M.setSelectValue(long, "No", null, "Q") ? long.value : "(none)";
  const other = make(["None of the above", "No", "Yes"]);
  out.noneOfAbove = M.setSelectValue(other, "No", null, "Q") ? other.value : "(none)";
  return out;
});
check("MA → Massachusetts, GA → Georgia, VA → Virginia, IA → Iowa",
  selects.ma === "Massachusetts" && selects.ga === "Georgia" && selects.va === "Virginia" && selects.ia === "Iowa",
  JSON.stringify(selects));
check("West Virginia is not taken for Virginia", selects.wv === "West Virginia");
check("a full state name selects a menu of postal codes", selects.coded === "NC", selects.coded);
check("a state is never written into a Yes/No menu", selects.stateIntoYesNo === "(none)", selects.stateIntoYesNo);
check("a clearance of None answers No", selects.noneIntoYesNo === "No", selects.noneIntoYesNo);
check("a non-answer like Hybrid is never written into a Yes/No menu", selects.hybridIntoYesNo === "(none)", selects.hybridIntoYesNo);
check("Yes still selects Yes", selects.yes === "Yes");
check("No selects the sentence-form No option", selects.long === "No, I will not require sponsorship", selects.long);
check("No is not read inside 'None of the above'", selects.noneOfAbove === "No", selects.noneOfAbove);

/* ------------------------------------------------------------------ */
console.log("\nradio groups");
const radios = await page.evaluate(() => {
  const M = window.APPLI_FILL_MATCHER;
  const group = (name, labels) => {
    const box = document.createElement("fieldset");
    labels.forEach((t, i) => {
      const id = `${name}-${i}`;
      box.insertAdjacentHTML("beforeend", `<div><input type="radio" id="${id}" name="${name}" value="${i}"><label for="${id}">${t}</label></div>`);
    });
    document.getElementById("f").appendChild(box);
    return box.querySelector("input");
  };
  const picked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.nextElementSibling?.textContent ?? "(none)";
  M.setRadioValue(group("r1", ["Yes", "No"]), "North Dakota", null, "Q");
  M.setRadioValue(group("r2", ["Yes", "No"]), "No", null, "Q");
  M.setRadioValue(group("r3", ["Yes, I have signed one", "No, I have not"]), "No", null, "Q");
  return { r1: picked("r1"), r2: picked("r2"), r3: picked("r3") };
});
check("a state is never clicked into a Yes/No radio group", radios.r1 === "(none)", radios.r1);
check("No clicks No", radios.r2 === "No");
check("No clicks the sentence-form No", radios.r3 === "No, I have not", radios.r3);

/* ------------------------------------------------------------------ */
console.log("\nalready-correct detection");
const eq = await page.evaluate(() => {
  const M = window.APPLI_FILL_MATCHER;
  const s = document.createElement("select");
  ["Virginia", "West Virginia", "North Carolina"].forEach((t) => { const o = document.createElement("option"); o.textContent = t; o.value = t; s.appendChild(o); });
  document.getElementById("f").appendChild(s);
  s.value = "West Virginia";
  const wv = M.valuesEquivalent(s, "Virginia", "State");
  s.value = "North Carolina";
  const nc = M.valuesEquivalent(s, "NC", "State");
  return { wv, nc };
});
check("West Virginia on screen is not mistaken for Virginia", eq.wv === false);
check("North Carolina on screen counts as the profile's NC", eq.nc === true);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
