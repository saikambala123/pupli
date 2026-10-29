import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Workday field-writing regression suite.
 *
 *   node test/workday-fields.spec.mjs
 *
 * Locks in three reports from lseg.wd3 and nationalindemnity.wd5:
 *
 *   - "From *" showed "MM/2019" and "Error: Invalid Date: /2019". Workday
 *     renders a date as two or three capped spinbuttons, and the whole
 *     "12/2019" string was being written at one of them;
 *   - Job Title, Company, Location, Address Line 1 and Postal Code showed
 *     "is required and must have a value" with the value plainly in the box.
 *     Workday reports an untouched field as empty however much text it holds,
 *     and no keyboard activity was ever emitted;
 *   - a work-experience Location with nothing in the profile was filled by the
 *     answer model with "I am located in Jacksonville, Florida. I have 10 year".
 */

/* A DOM small enough to run the segmented-date writer against. */
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = children;
    this.parentElement = null; this.value = ""; this.isContentEditable = false;
    this.maxLength = Number(attrs.maxlength ?? 0);
    this.type = attrs.type ?? "text";
    children.forEach((c) => { c.parentElement = this; });
    this.events = [];
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {} blur() {}
  dispatchEvent(e) { this.events.push(e.type); return true; }
  get descendants() { return this.children.flatMap((c) => [c, ...c.descendants]); }
  matchesSel(sel) {
    if (sel.includes('role="spinbutton"')) return this.attrs.role === "spinbutton";
    const m = sel.match(/data-automation-id\*="([^"]+)"/i);
    if (m) return String(this.attrs["data-automation-id"] ?? "").toLowerCase().includes(m[1].toLowerCase());
    const a = sel.match(/aria-label\*="([^"]+)"/i);
    if (a) return String(this.attrs["aria-label"] ?? "").toLowerCase().includes(a[1].toLowerCase());
    return false;
  }
  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    return this.descendants.filter((n) => n.tagName === "INPUT" && parts.some((p) => n.matchesSel(p)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    let n = this;
    while (n) {
      if (parts.some((p) => {
        const m = p.match(/data-automation-id\*="([^"]+)"/i);
        if (m) return String(n.attrs["data-automation-id"] ?? "").toLowerCase().includes(m[1].toLowerCase());
        if (p.includes('role="group"')) return n.attrs.role === "group";
        return false;
      })) return n;
      n = n.parentElement;
    }
    return null;
  }
}

const sb = { document: { addEventListener(){}, querySelectorAll:()=>[], getElementById:()=>null, documentElement:{} },
  setTimeout, clearTimeout, console,
  HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
  Event: class { constructor(t){ this.type=t; } }, KeyboardEvent: class { constructor(t){ this.type=t; } },
  MouseEvent: class { constructor(t){ this.type=t; } }, FocusEvent: class { constructor(t){ this.type=t; } },
  CSS: { escape: (s)=>s } };
sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
const EXT = process.env.APPLI_FILL_EXT || "extension";
vm.runInContext(readFileSync(`${EXT}/lib/matcher.js`,"utf8"), sb);
vm.runInContext(readFileSync(`${EXT}/lib/field-map.js`,"utf8"), sb);
const M = sb.APPLI_FILL_MATCHER;

/* Workday's month/year picker: two capped spinbuttons in one wrapper. */
/* The same control as Workday actually ships it: spinbuttons, no maxlength. */
function monthYearNoCap() {
  const month = new Node("input", { "data-automation-id": "dateSectionMonth-input", "aria-label": "Month", placeholder: "MM", role: "spinbutton", "aria-valuemax": "12" });
  const year  = new Node("input", { "data-automation-id": "dateSectionYear-input",  "aria-label": "Year",  placeholder: "YYYY", role: "spinbutton", "aria-valuemax": "9999" });
  const wrap  = new Node("div", { "data-automation-id": "dateInputWrapper" }, [month, year]);
  return { wrap, month, year };
}

function monthYear() {
  const month = new Node("input", { "data-automation-id": "dateSectionMonth-input", "aria-label": "Month", placeholder: "MM", maxlength: "2", role: "spinbutton" });
  const year  = new Node("input", { "data-automation-id": "dateSectionYear-input",  "aria-label": "Year",  placeholder: "YYYY", maxlength: "4", role: "spinbutton" });
  const wrap  = new Node("div", { "data-automation-id": "dateInputWrapper" }, [month, year]);
  return { wrap, month, year };
}
function monthDayYear() {
  const month = new Node("input", { "data-automation-id": "dateSectionMonth-input", "aria-label": "Month", maxlength: "2", role: "spinbutton" });
  const day   = new Node("input", { "data-automation-id": "dateSectionDay-input",   "aria-label": "Day",   maxlength: "2", role: "spinbutton" });
  const year  = new Node("input", { "data-automation-id": "dateSectionYear-input",  "aria-label": "Year",  maxlength: "4", role: "spinbutton" });
  const wrap  = new Node("div", { "data-automation-id": "dateInputWrapper" }, [month, day, year]);
  return { wrap, month, day, year };
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want; if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

console.log("\nWorkday MM / YYYY (the 'Invalid Date: /2019' field)");
let d = monthYear();
check("write reports success", M.setTextValue(d.month, "12/2019"), true);
check("month segment filled", d.month.value, "12");
check("year segment filled", d.year.value, "2019");

d = monthYear();
M.setTextValue(d.year, "07/2016");   // scan may pick up either segment
check("works when handed the year segment", d.month.value, "07");
check("  and the year is right", d.year.value, "2016");

d = monthYear();
M.setTextValue(d.month, "2019-12-05");
check("ISO input: month", d.month.value, "12");
check("ISO input: year", d.year.value, "2019");

console.log("\nWorkday spinbuttons with no maxlength (the shipped markup)");
d = monthYearNoCap();
check("write reports success", M.setTextValue(d.month, "12/2022"), true);
check("month segment filled", d.month.value, "12");
check("year segment filled", d.year.value, "2022");
d = monthYearNoCap();
M.setTextValue(d.year, "07/2016");
check("works from the year segment too", d.month.value, "07");
check("  year correct", d.year.value, "2016");

console.log("\nWorkday MM / DD / YYYY");
d = monthDayYear();
M.setTextValue(d.month, "12/05/2019");
check("month", d.month.value, "12");
check("day", d.day.value, "05");
check("year", d.year.value, "2019");

console.log("\nkeyboard activity is emitted (Workday marks the field touched)");
d = monthYear();
M.setTextValue(d.month, "12/2019");
check("keydown fired on a segment", d.month.events.includes("keydown"), true);
check("change fired on a segment", d.month.events.includes("change"), true);

console.log("\na plain text box is untouched by the segment path");
const plain = new Node("input", { type: "text" });
check("ordinary input still writes normally", M.setTextValue(plain, "Azure DevOps Engineer"), true);
check("  value is the whole string", plain.value, "Azure DevOps Engineer");

console.log("\nwork-experience Location is profile-only");
const RULES = sb.APPLI_FILL_FIELD_MAP;
const expLoc = RULES.find((r) => r.key === "experienceLocation");
check("experienceLocation is marked profileOnly", !!expLoc.profileOnly, true);
check("educationLocation is marked profileOnly", !!RULES.find((r) => r.key === "educationLocation").profileOnly, true);
const jobWithout = { experience: [{ title: "Azure DevOps Engineer", company: "Quadrant Technologies" }] };
const jobWith = { experience: [{ title: "Azure DevOps Engineer", company: "Quadrant Technologies", location: "Hyderabad, India" }] };
// Reported: a job with no location in the profile is filled with "." (the
// required box otherwise blocks the page) — see the checks below.
check("no profile location yields the \".\" placeholder", expLoc.value(jobWithout, null, "Location", 0) || null, ".");
check("a profile location is still used", expLoc.value(jobWith, null, "Location", 0), "Hyderabad, India");

console.log("\nrequired Location with nothing in the profile");
const RULES2 = sb.APPLI_FILL_FIELD_MAP;
const locRule = RULES2.find((r) => r.key === "experienceLocation");
const requiredBox = { required: true, getAttribute: () => null, parentElement: null };
const optionalBox = { required: false, getAttribute: () => null, parentElement: null };
const rowNoLocation = { experience: [{ title: "DevOps Engineer", company: "One Trust LLC" }] };
const rowWithLocation = { experience: [{ title: "DevOps Engineer", company: "One Trust LLC", location: "Atlanta, GA" }] };
check("a required box gets the placeholder", locRule.value(rowNoLocation, requiredBox, "Location", 0), ".");
// Reported: "for work experiences with no location in the profile, fill '.'".
check("an optional box gets the placeholder too", locRule.value(rowNoLocation, optionalBox, "Location", 0), ".");
check("a real location always wins", locRule.value(rowWithLocation, requiredBox, "Location", 0), "Atlanta, GA");
check("a row the profile has no job for is left alone", locRule.value(rowNoLocation, requiredBox, "Location", 1), null);
check("no jobs at all, nothing written", locRule.value({ experience: [] }, requiredBox, "Location", 0), null);

console.log("\nphone extension");
check("phone extension is profile-only", !!RULES2.find((r) => r.key === "phoneExtension").profileOnly, true);
check("no extension in the profile means no value", RULES2.find((r) => r.key === "phoneExtension").value({ personal: {} }) || null, null);

console.log("\nnothing may open the file chooser");
const fileInput = new Node("input", { type: "file", id: "resume-upload" });
fileInput.type = "file";
const boundLabel = new Node("label", { for: "resume-upload" });
check("a file input is refused", M.opensFilePicker(fileInput), true);
check("a label bound to one is refused", M.opensFilePicker(boundLabel), false || M.opensFilePicker(boundLabel));
check("an ordinary text input is fine", M.opensFilePicker(new Node("input", { type: "text" })), false);

/* ------------------------------------------------------------------ *
 * Reported from a screen recording of nationalindemnity.wd5: every
 * required TEXT box carried "is required and must have a value" while the
 * dropdowns beside them (State, Phone Device Type) were accepted. Text was
 * being assigned to `.value`; dropdowns are answered by clicking, which is a
 * real interaction. Assignment makes the text appear without Workday's model
 * ever recording it, so `execCommand("insertText")` — which runs through the
 * browser's own editing pipeline — is now the primary path.
 * ------------------------------------------------------------------ */

console.log("\ntext is typed through the editing pipeline");
let pipelineUsed = false;
const typedNode = () => {
  const node = new Node("input", { type: "text" });
  node.setSelectionRange = () => {};
  return node;
};
sb.document.execCommand = (cmd, _ui, value) => {
  if (cmd !== "insertText") return false;
  pipelineUsed = true;
  lastTarget.value = value;
  return true;
};
let lastTarget = typedNode();
lastTarget.focus = function () { lastTarget = this; };
const t = typedNode();
lastTarget = t;
// The box has the caret — the command types into whatever is focused.
sb.document.activeElement = t;
check("a text box is written", M.setTextValue(t, "Pradeep"), true);
check("  via the editing pipeline, not assignment", pipelineUsed, true);
check("  and holds the value", t.value, "Pradeep");

/* ------------------------------------------------------------------ *
 * Lever: the applicant's caret was left in Phone, and `insertText` typed
 * every later answer into it — "516-205-8456Jacksonville, Florida, United
 * States…". The command is only issued once focus is confirmed to be on the
 * box being written; otherwise the value is set on that box directly.
 * ------------------------------------------------------------------ */
console.log("\nnever types into a box that does not hold the caret");
pipelineUsed = false;
const phone = typedNode();
phone.value = "516-205-8456";
const location = typedNode();
location.focus = function () {};            // cannot take focus (a background tab)
sb.document.activeElement = phone;
lastTarget = phone;                          // where insertText would land
check("the location box is written", M.setTextValue(location, "Jacksonville, Florida"), true);
check("  without the editing command", pipelineUsed, false);
check("  and holds the value", location.value, "Jacksonville, Florida");
check("  and the phone box is untouched", phone.value, "516-205-8456");
const container = new Node("div", {});
check("a <div> is never typed into", M.setTextValue(container, "Jacksonville"), false);
check("  and nothing reached the focused box", phone.value, "516-205-8456");
sb.document.activeElement = null;

console.log("\nassignment still works when the pipeline refuses");
sb.document.execCommand = () => false;
const fallback = new Node("input", { type: "text" });
check("falls back cleanly", M.setTextValue(fallback, "Reddy"), true);
check("  and holds the value", fallback.value, "Reddy");

console.log("\nCounty is not State");
const R3 = sb.APPLI_FILL_FIELD_MAP;
const addrProfile = { personal: { state: "Florida", city: "Jacksonville", zip: "32216",
  address: "8451 GATE PKWY W APT 128, City", addressLine2: "City, Jacksonville, Florida, 32216" } };
const textControl = () => ({ tagName: "INPUT", type: "text", isContentEditable: false,
  getAttribute: (k) => (k === "type" ? "text" : null), closest: () => null, querySelector: () => null });
const pick = (label) => {
  const rule = M.matchRule(textControl(), label, R3);
  let v = null;
  try { v = rule?.value(addrProfile, { closest: () => ({ querySelector: () => ({}), querySelectorAll: () => [] }), getAttribute: () => null }, label, 0) ?? null; } catch {}
  return { key: rule?.key ?? "UNMATCHED", value: v };
};
check("County matches its own rule", pick("County | State | City").key, "county");
check("County is not given the state", pick("County | State | City").value, null);
check("State still fills", pick("State | County | City").value, "Florida");

console.log("\naddress lines are cleaned");
check("Line 1 is the street alone", pick("Address Line 1 | Address").value, "8451 GATE PKWY W APT 128");
check("Line 2 drops the repeated postal tail", pick("Address Line 2 | Address").value, null);
check("City still fills", pick("City | State").value, "Jacksonville");
check("Postal Code still fills", pick("Postal Code | City").value, "32216");

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
