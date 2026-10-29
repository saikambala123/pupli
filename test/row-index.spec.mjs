/**
 * Repeated-row indexing.
 *
 *   node test/row-index.spec.mjs
 *
 * Reported: in Work Experience 2, Company filled with the right employer while
 * Job Title beside it stayed empty and carried the "needs your answer" marker —
 * with a job title saved on that row of the profile.
 *
 * The cause is that indexes were resolved per field, from whichever numbered
 * heading each one happened to reach. A box nested one wrapper deeper than its
 * neighbours can resolve a different heading, and then one field reads row 2 of
 * the profile while the box beside it reads row 3. Where row 3 does not exist
 * the lookup returns nothing and that single box is left blank.
 *
 * A row describes one job, so disagreement inside a row is always a resolution
 * error. `reconcileRows` gives every field in a row the index most of them
 * agree on, falling back to the row's position on the page.
 */

let seq = 0;
class El {
  constructor(tag, text = "", children = []) {
    this.tagName = tag.toUpperCase(); this.textContent = text; this.children = children;
    this.parentElement = null; this.order = seq++;
    children.forEach((c) => { c.parentElement = this; });
  }
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  compareDocumentPosition(other) { return other.order > this.order ? 4 : other.order < this.order ? 2 : 0; }
}
globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 };

function row(headingText, n) {
  const title = new El("input", "", []);
  const company = new El("input", "", []);
  const location = new El("input", "", []);
  // The title sits one wrapper deeper — the kind of nesting that makes it
  // resolve a different heading from its neighbours.
  const titleWrap = new El("div", "", [title]);
  const body = new El("div", "", [titleWrap, company, location]);
  const heading = new El("h3", headingText);
  const section = new El("section", "", [heading, body]);
  return { section, title, company, location, n };
}

const r1 = row("Work Experience 1", 0);
const r2 = row("Work Experience 2", 1);
const form = new El("form", "", [r1.section, r2.section]);

const fields = [
  { el: r1.title, rule: { key: "currentTitle" } },
  { el: r1.company, rule: { key: "currentCompany" } },
  { el: r1.location, rule: { key: "experienceLocation" } },
  { el: r2.title, rule: { key: "currentTitle" } },
  { el: r2.company, rule: { key: "currentCompany" } },
  { el: r2.location, rule: { key: "experienceLocation" } },
];

// The bug as observed: row 2's Title resolves one row too far.
fields[3].index = 2;
fields[4].index = 1;
fields[5].index = 1;
fields[0].index = 0; fields[1].index = 0; fields[2].index = 0;

// Pull the two helpers out of the content script without booting it.
import { readFileSync } from "node:fs";
const src = readFileSync(`${process.env.APPLI_FILL_EXT || "extension"}/content/autofill.js`, "utf8");
const start = src.indexOf("  function reconcileRows(family) {");
const end = src.indexOf("\n  }", src.indexOf("  function rowContainerOf(el, family) {")) + 4;
const body = src.slice(start, end);
const { reconcileRows } = new Function(`${body}; return { reconcileRows };`)();

const profile = { experience: [
  { title: "Azure DevOps Engineer", company: "Microsoft", location: "Redmond, WA" },
  { title: "Senior DevOps Engineer", company: "One Trust LLC", location: "Atlanta, GA" },
] };
const jobAt = (p, i) => p.experience[i] ?? {};

console.log("before reconciliation");
for (const f of fields) console.log(`   ${f.rule.key.padEnd(20)} index ${f.index}  -> ${JSON.stringify(jobAt(profile, f.index).title ?? null)}`);

reconcileRows(fields);

console.log("\nafter reconciliation");
let fails = 0;
const expect = [0, 0, 0, 1, 1, 1];
fields.forEach((f, i) => {
  const ok = f.index === expect[i];
  if (!ok) fails++;
  console.log(`   ${ok ? "ok  " : "FAIL"} ${f.rule.key.padEnd(20)} index ${f.index}  -> ${JSON.stringify(jobAt(profile, f.index).title ?? null)}`);
});
console.log(fails ? `\n${fails} failing` : "\nevery field in a row shares its row's index");
process.exit(fails ? 1 : 0);
