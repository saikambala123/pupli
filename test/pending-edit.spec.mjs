/**
 * Pending answers can be edited, added by hand, and a fresh edit is never
 * swallowed by an old dismissal.
 *
 *   node test/pending-edit.spec.mjs
 *
 * Runs background.js's message handlers against fake storage and a fake API,
 * the same way held-answers.spec does.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const EXT = process.env.APPLI_FILL_EXT || "extension";

const disk = {};
const uploads = [];
const chrome = {
  storage: { local: {
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {}; list.forEach((k) => { if (k in disk) out[k] = disk[k]; }); cb(out);
    },
    set: (obj, cb) => { Object.assign(disk, obj); cb && cb(); },
    remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete disk[k]); cb && cb(); },
  } },
  runtime: { onMessage: { addListener: (fn) => { chrome.__onMessage = fn; } }, onInstalled: { addListener: (fn) => { chrome.__onInstalled = fn; } },
             onStartup: { addListener() {} }, lastError: null },
  action: { setBadgeText(o) { chrome.__badge = o.text; }, setBadgeBackgroundColor() {} },
  tabs: { onActivated: { addListener() {} }, query: (q, cb) => cb && cb([]), sendMessage() {}, create() {} },
  commands: { onCommand: { addListener() {} } },
};

/* A server that confirms every answer it is sent, and serves them back. */
const serverAnswers = [];
const fetchStub = async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  if (path === "/api/extension/sync" && options.method === "POST") {
    const body = JSON.parse(options.body || "{}");
    const norm = (q) => String(q).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 180);
    for (const r of body.responses || []) {
      uploads.push(r);
      const i = serverAnswers.findIndex((x) => norm(x.question) === norm(r.question));
      if (i >= 0) serverAnswers[i] = { ...r }; else serverAnswers.push({ ...r });
    }
    const keys = (body.responses || []).map((r) => norm(r.question));
    return { ok: true, status: 200, json: async () => ({ data: { responsesSaved: keys.length, savedKeys: keys } }) };
  }
  if (path === "/api/extension/bootstrap") {
    return { ok: true, status: 200, json: async () => ({ data: {
      user: { premium: false }, settings: {}, profiles: [{ _id: "p1", isDefault: true }], activeProfileId: "p1",
      responses: serverAnswers.map((r) => ({ ...r })), syncedAt: new Date().toISOString(),
    } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const sb = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: fetchStub, AbortController,
  URL, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat };
sb.self = sb; sb.globalThis = sb; sb.window = undefined;
vm.createContext(sb);
vm.runInContext(readFileSync(`${EXT}/background.js`, "utf8"), sb);

const call = (msg) => new Promise((resolve) => {
  const keepOpen = chrome.__onMessage(msg, { tab: { id: 1 } }, resolve);
  if (!keepOpen) resolve(undefined);
});

let fails = 0;
const check = (label, pass, detail = "") => {
  if (!pass) fails++;
  console.log(`${pass ? "  ok  " : "  FAIL"} ${label}${!pass && detail ? `\n         ${detail}` : ""}`);
};

disk.token = "t";
disk.apiBase = "https://applifill.test";

const Q = "Have you signed any agreements with your current or former employer(s) that could restrict your ability to work for GDIT?";

console.log("\nediting an unsaved answer");
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: Q, answer: "Yes", inputType: "select", options: ["Yes", "No"], editedAt: Date.now() }] });
let res = await call({ type: "APPLI_FILL_EDIT_PENDING", question: Q, answer: "No" });
check("the edit is accepted", res?.ok === true, JSON.stringify(res));
check("the held answer now reads No", disk.heldAnswers?.[0]?.answer === "No", JSON.stringify(disk.heldAnswers));
check("its choices are kept", JSON.stringify(disk.heldAnswers?.[0]?.options) === JSON.stringify(["Yes", "No"]));
check("still one entry, not two", disk.heldAnswers.length === 1);
check("nothing was uploaded by an edit alone", uploads.length === 0);

console.log("\nrewording the question of an unsaved answer");
res = await call({ type: "APPLI_FILL_EDIT_PENDING", question: Q, newQuestion: "Have you signed a non-compete agreement?", answer: "No" });
check("the question can be reworded", res?.ok === true && disk.heldAnswers[0].question === "Have you signed a non-compete agreement?",
  JSON.stringify(disk.heldAnswers));
res = await call({ type: "APPLI_FILL_EDIT_PENDING", question: "Have you signed a non-compete agreement?", newQuestion: "Yes", answer: "No" });
check("a question too short to match anything is refused", res?.ok === false);

console.log("\nediting an answer that is already queued uploads the correction");
await call({ type: "APPLI_FILL_SAVE_HELD" });
check("saving uploaded it", uploads.length === 1 && uploads[0].answer === "No", JSON.stringify(uploads));
disk.pendingResponses = [{ question: "What is your notice period?", answer: "2 weeks", inputType: "text" }];
res = await call({ type: "APPLI_FILL_EDIT_PENDING", question: "What is your notice period?", answer: "30 days" });
check("the queued edit is accepted", res?.ok === true, JSON.stringify(res));
check("and uploaded straight away", uploads.some((u) => u.answer === "30 days"), JSON.stringify(uploads));
check("the dashboard copy is the corrected one", serverAnswers.find((r) => /notice/.test(r.question))?.answer === "30 days");
check("nothing is left waiting", (disk.pendingResponses ?? []).length === 0, JSON.stringify(disk.pendingResponses));

console.log("\nediting something that is no longer pending");
res = await call({ type: "APPLI_FILL_EDIT_PENDING", question: "Never captured?", answer: "x" });
check("is refused with a reason", res?.ok === false && Boolean(res.error));

console.log("\nan answer typed into the popup");
res = await call({ type: "APPLI_FILL_ADD_PENDING", question: "Are you over the age of 18?", answer: "Yes" });
check("is held", res?.ok === true && disk.heldAnswers.some((r) => r.question === "Are you over the age of 18?" && r.answer === "Yes"));
res = await call({ type: "APPLI_FILL_ADD_PENDING", question: "Age", answer: "Yes" });
check("a one-word question is refused", res?.ok === false);
res = await call({ type: "APPLI_FILL_ADD_PENDING", question: "Are you a veteran?", answer: "" });
check("an empty answer is refused", res?.ok === false);
await call({ type: "APPLI_FILL_SAVE_HELD", questions: ["Are you over the age of 18?"] });
check("and reaches the dashboard on Save", serverAnswers.some((r) => r.question === "Are you over the age of 18?" && r.answer === "Yes"));

console.log("\na dismissal does not swallow a later, deliberate edit");
const D = "Are you willing to travel up to 25% of the time?";
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: D, answer: "No", editedAt: Date.now() }] });
await call({ type: "APPLI_FILL_DISCARD_HELD", questions: [D] });
check("discarded", !(disk.heldAnswers ?? []).some((r) => r.question === D));
// The same capture bouncing back (no newer edit) stays gone...
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: D, answer: "No" }] });
check("the same capture replayed without a new edit stays dismissed", !(disk.heldAnswers ?? []).some((r) => r.question === D));
// ...but the applicant choosing it again later is shown.
await new Promise((r) => setTimeout(r, 5));
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: D, answer: "No", editedAt: Date.now() }] });
check("a fresh edit made after the dismissal is held", (disk.heldAnswers ?? []).some((r) => r.question === D && r.answer === "No"),
  JSON.stringify(disk.heldAnswers));


/* ------------------------------------------------------------------ *
 * Lever, up to 1.15.0: the question wrappers were collected as boxes, and
 * an <li> reports its list number — so "Full name: 0", "Current location: 0"
 * and "Current company: 0" were held as the applicant's answers.
 * ------------------------------------------------------------------ */
console.log("\nanswers read off a question's wrapper");
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [
  { question: "Full name", answer: "0", editedAt: Date.now() },
  { question: "Current location", answer: "0", editedAt: Date.now() },
  { question: "How many years of Terraform experience do you have?", answer: "0", editedAt: Date.now() },
] });
check("a wrapper's list number is never held", !(disk.heldAnswers ?? []).some((r) => /full name|current location/i.test(r.question)),
  JSON.stringify(disk.heldAnswers));
check("a real answer of 0 still is", (disk.heldAnswers ?? []).some((r) => /terraform/i.test(r.question) && r.answer === "0"));

disk.heldAnswers = [
  ...(disk.heldAnswers ?? []),
  { question: "Current company", answer: "0", heldAt: 1 },
  { question: "Full name", answer: "0", heldAt: 1 },
];
await chrome.__onInstalled({ reason: "update" });
check("updating clears the ones an older build held", !(disk.heldAnswers ?? []).some((r) => /current company|full name/i.test(r.question)),
  JSON.stringify(disk.heldAnswers));
check("  and keeps everything else", (disk.heldAnswers ?? []).some((r) => /terraform/i.test(r.question)));

console.log("\nputting Appli-Fill's answer back withdraws the detour");
const W = "Are you willing to work on-site in Reston, VA?";
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: W, answer: "No", editedAt: Date.now() }] });
await call({ type: "APPLI_FILL_DISCARD_HELD", questions: [W], withdrawn: true });
check("withdrawn from the list", !(disk.heldAnswers ?? []).some((r) => r.question === W));
await call({ type: "APPLI_FILL_HOLD_ANSWERS", items: [{ question: W, answer: "No" }] });
check("but not remembered as rejected", (disk.heldAnswers ?? []).some((r) => r.question === W && r.answer === "No"),
  JSON.stringify(disk.heldAnswers));

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
