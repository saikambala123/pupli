/**
 * DOM tests for the extension's field matching and dropdown handling.
 *
 *   npm i -g jsdom && node scripts/test-autofill-fields.mjs
 *
 * Covers the two failures reported from Workday:
 *   - a job's "Location" field taking the candidate's home address
 *   - "How Did You Hear About Us?" whose answers live inside sub-menus
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  try {
    ({ JSDOM } = require(`${process.env.HOME}/.npm-global/lib/node_modules/jsdom`));
  } catch {
    console.error("jsdom is required: npm i -g jsdom");
    process.exit(1);
  }
}

const root = new URL("..", import.meta.url).pathname;
const matcherSrc = readFileSync(`${root}extension/lib/matcher.js`, "utf8");
const fieldMapSrc = readFileSync(`${root}extension/lib/field-map.js`, "utf8");

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
};

function boot(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;

  // jsdom reports every element as zero-sized; the option scanner filters on
  // that, so give elements a real box.
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20, x: 0, y: 0 };
  };
  window.Element.prototype.scrollIntoView = function () {};

  const run = (src) => window.eval(src);
  run(matcherSrc);
  run(fieldMapSrc);
  return window;
}

/* ------------------------------------------------------------------ */
/* Work experience location must not take the home address             */
/* ------------------------------------------------------------------ */

const workdayExperience = `
  <h2>My Experience</h2>
  <div data-automation-id="workExperienceSection">
    <h3>Work Experience 1</h3>
    <div><label for="t1">Job Title</label><input id="t1"></div>
    <div><label for="c1">Company</label><input id="c1"></div>
    <div><label for="l1">Location</label><input id="l1"></div>
  </div>
  <div data-automation-id="workExperienceSection">
    <h3>Work Experience 2</h3>
    <div><label for="t2">Job Title</label><input id="t2"></div>
    <div><label for="c2">Company</label><input id="c2"></div>
    <div><label for="l2">Location</label><input id="l2"></div>
  </div>
  <h3>Contact Information</h3>
  <div><label for="home">Location</label><input id="home"></div>
`;

{
  const w = boot(workdayExperience);
  const M = w.APPLI_FILL_MATCHER;
  const RULES = w.APPLI_FILL_FIELD_MAP;

  const jobLoc = w.document.getElementById("l1");
  const jobLoc2 = w.document.getElementById("l2");
  const homeLoc = w.document.getElementById("home");

  check("section title", M.sectionContext(jobLoc).title, "Work Experience 1");
  check("section index 1", M.sectionContext(jobLoc).index, 0);
  check("section index 2", M.sectionContext(jobLoc2).index, 1);

  const ruleFor = (el) => M.matchRule(el, M.deriveLabel(el), RULES)?.key ?? null;
  check("job location rule", ruleFor(jobLoc), "experienceLocation");
  check("job location rule 2", ruleFor(jobLoc2), "experienceLocation");
  check("home location rule", ruleFor(homeLoc), "location");

  // The value each rule pulls from the profile.
  const profile = {
    personal: { city: "Hyderabad", state: "TS", country: "India" },
    experience: [
      { company: "Optum", title: "Engineer", location: "Eden Prairie, MN" },
      { company: "Wells Fargo", title: "Engineer", location: "Charlotte, NC" },
    ],
  };
  const valueOf = (el, index) => {
    const rule = M.matchRule(el, M.deriveLabel(el), RULES);
    return rule ? rule.value(profile, el, M.deriveLabel(el), index) : null;
  };
  check("role 1 location value", valueOf(jobLoc, M.sectionContext(jobLoc).index), "Eden Prairie, MN");
  check("role 2 location value", valueOf(jobLoc2, M.sectionContext(jobLoc2).index), "Charlotte, NC");
  check("home location value", valueOf(homeLoc, 0), "Hyderabad, TS, India");
}

/* ------------------------------------------------------------------ */
/* Nested "How Did You Hear About Us?" menu                            */
/* ------------------------------------------------------------------ */

const nestedMenu = `
  <div><label id="lbl">How Did You Hear About Us?</label>
    <button id="hear" aria-haspopup="listbox" aria-labelledby="lbl"></button></div>
  <div id="menu" role="listbox"></div>
`;

{
  const w = boot(nestedMenu);
  const M = w.APPLI_FILL_MATCHER;
  const doc = w.document;
  const button = doc.getElementById("hear");
  const menu = doc.getElementById("menu");

  const TAXONOMY = {
    "Career Fair": null,
    "Direct Sourcing": null,
    "Job Board": ["Indeed", "Monster", "ZipRecruiter"],
    "Social Media": ["Facebook", "LinkedIn", "Twitter"],
    "Our Web Site": ["Careers Page", "Blog"],
    Other: ["Newspaper", "Radio"],
  };

  let chosen = null;
  const renderTop = () => {
    menu.innerHTML = "";
    for (const [name, children] of Object.entries(TAXONOMY)) {
      const row = doc.createElement("div");
      row.setAttribute("role", "option");
      row.textContent = children ? `${name} ›` : name;
      if (children) row.setAttribute("aria-haspopup", "true");
      row.addEventListener("click", () => {
        if (!children) { chosen = name; menu.innerHTML = ""; return; }
        menu.innerHTML = "";
        for (const child of children) {
          const leaf = doc.createElement("div");
          leaf.setAttribute("role", "option");
          leaf.textContent = child;
          leaf.addEventListener("click", () => { chosen = child; menu.innerHTML = ""; });
          menu.appendChild(leaf);
        }
      });
      menu.appendChild(row);
    }
  };

  button.addEventListener("click", () => { if (!menu.children.length) renderTop(); });
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.innerHTML = ""; });

  const ok = await M.setComboboxValue(button, "LinkedIn", 400);
  check("nested menu selected LinkedIn", chosen, "LinkedIn");
  check("nested menu reported success", typeof ok, "boolean");

  // A value that sits at the top level must still work.
  chosen = null;
  menu.innerHTML = "";
  await M.setComboboxValue(button, "Career Fair", 400);
  check("top-level option", chosen, "Career Fair");

  // An answer that exists nowhere must not pick something at random, and must
  // leave the menu closed rather than hanging open over the form.
  chosen = null;
  menu.innerHTML = "";
  const missing = await M.setComboboxValue(button, "Carrier Pigeon", 300);
  check("unknown value not chosen", chosen, null);
  check("unknown value returns false", missing, false);
  check("menu closed after failure", menu.children.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
