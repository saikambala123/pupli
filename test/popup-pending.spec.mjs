/**
 * The popup's pending answers: visible, editable, live, and addable by hand.
 *
 *   node test/popup-pending.spec.mjs
 *
 * Reported: "when we edit or manually enter data in pending saved answers in
 * the extension it is not showing". The list started collapsed on every open
 * and every refresh, it only read storage once when the popup opened, and an
 * entry could be saved or discarded but never corrected. The popup is rendered
 * here against an in-memory extension API.
 */

import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(() => {
  const AGREE = "Have you signed any agreements with your current or former employer(s) that could restrict your ability to work for GDIT?";
  const store = {
    apiBase: "https://applifill.test", stats: { applications: 3 }, applifillAutoSubmitAccount: true,
    heldAnswers: [
      { question: AGREE, answer: "Yes", inputType: "select", options: ["Yes", "No"], editedAt: 1 },
      { question: "Please state your desired annual salary.", answer: "150000", inputType: "text", options: [], editedAt: 2 },
    ],
    pendingResponses: [],
  };
  const session = {
    premium: false, profile: { _id: "p1", label: "Default" }, profiles: [{ _id: "p1", label: "Default" }],
    responses: [{ question: "What is your notice period?", answer: "2 weeks" }],
    settings: { showOverlay: true, trackAutomatically: true, reuseSavedResponses: true, autoAttachResume: true },
  };
  const listeners = [];
  const changed = (keys) => {
    const changes = {};
    keys.forEach((k) => { changes[k] = { newValue: store[k] }; });
    listeners.forEach((fn) => { try { fn(changes, "local"); } catch {} });
  };
  window.__store = store;
  window.__sent = [];
  window.__changed = changed;
  const norm = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        window.__sent.push(JSON.parse(JSON.stringify(msg)));
        let reply = { ok: true, data: {} };
        switch (msg?.type) {
          case "APPLI_FILL_GET_SESSION": reply = { ok: true, data: session }; break;
          case "APPLI_FILL_GET_PENDING": reply = { ok: true, data: { responses: store.pendingResponses } }; break;
          case "APPLI_FILL_GET_HELD": reply = { ok: true, data: { held: store.heldAnswers } }; break;
          case "APPLI_FILL_EDIT_PENDING": {
            const item = store.heldAnswers.find((r) => norm(r.question) === norm(msg.question));
            if (item) { item.answer = msg.answer; item.question = msg.newQuestion || item.question; }
            reply = { ok: Boolean(item), held: true };
            changed(["heldAnswers"]);
            break;
          }
          case "APPLI_FILL_SAVE_HELD": {
            const want = msg.questions?.map(norm);
            const moving = store.heldAnswers.filter((r) => !want || want.includes(norm(r.question)));
            store.heldAnswers = store.heldAnswers.filter((r) => !moving.includes(r));
            session.responses.push(...moving);
            reply = { ok: true, saved: moving.length, synced: true };
            changed(["heldAnswers"]);
            break;
          }
          case "APPLI_FILL_ADD_PENDING":
            store.heldAnswers.push({ question: msg.question, answer: msg.answer, inputType: "text", options: [] });
            changed(["heldAnswers"]);
            break;
          default: break;
        }
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: { get(keys, cb) { cb(store); }, set(obj) { Object.assign(store, obj); }, remove() {} },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
    tabs: {
      query() { return Promise.resolve([{ id: 1, url: "https://gdit.wd5.myworkdayjobs.com/job/apply" }]); },
      sendMessage(_id, _m, cb) { cb && cb({ ok: true, isApplication: true, ats: "Workday" }); },
      create() {},
    },
  };
});

await page.goto(pathToFileURL(join(EXT, "popup/popup.html")).href);
await page.waitForTimeout(500);

/* ------------------------------------------------------------------ */
console.log("\nmanual edits are on screen as soon as the popup opens");
const listOpen = await page.evaluate(() => !document.getElementById("pending-list").hidden);
check("the pending list opens by itself when there are edits to review", listOpen);
const rows = await page.$$eval("#pending-list li", (lis) => lis.map((li) => li.textContent));
check("both edits are listed", rows.length === 2 && rows.some((t) => /desired annual salary/.test(t)), JSON.stringify(rows));
check("each has an Edit button", (await page.$$("#pending-list .pending__edit-btn")).length === 2);
check("there is no 'attach my resume' switch",
  !(await page.evaluate(() => document.body.innerText.includes("Attach my resume"))));

/* ------------------------------------------------------------------ */
console.log("\ncorrecting an answer before saving it");
await page.click("#pending-list li:first-child .pending__edit-btn");
const editor = await page.evaluate(() => {
  const li = document.querySelector("#pending-list li.pending__item--editing");
  const select = li?.querySelector("select");
  return { open: Boolean(li), options: select ? Array.from(select.options).map((o) => o.value) : null };
});
check("the editor opens in place", editor.open);
check("a dropdown answer is edited from the question's own choices", JSON.stringify(editor.options) === JSON.stringify(["Yes", "No"]),
  JSON.stringify(editor.options));

// A capture arriving while the editor is open must not wipe it out.
await page.evaluate(() => {
  window.__store.heldAnswers.push({ question: "Are you willing to relocate for this position?", answer: "No", inputType: "select", options: ["Yes", "No"] });
  window.__changed(["heldAnswers"]);
});
await page.waitForTimeout(400);
check("a live update waits while an answer is being edited",
  Boolean(await page.$("#pending-list li.pending__item--editing select")));

await page.selectOption("#pending-list li.pending__item--editing select", "No");
await page.click("#pending-list li.pending__item--editing .pending__save");
await page.waitForTimeout(500);
const sent = await page.evaluate(() => window.__sent.map((m) => m.type));
const edit = await page.evaluate(() => window.__sent.find((m) => m.type === "APPLI_FILL_EDIT_PENDING"));
check("the edit is sent with the new answer", edit?.answer === "No", JSON.stringify(edit));
check("and the corrected answer is saved in the same step", sent.includes("APPLI_FILL_SAVE_HELD"), sent.join(", "));
const after = await page.$$eval("#pending-list li", (lis) => lis.map((li) => li.textContent));
check("the saved answer leaves the list and the late capture appears",
  !after.some((t) => /signed any agreements/.test(t)) && after.some((t) => /relocate/.test(t)), JSON.stringify(after));
check("the saved-answer count moves", (await page.textContent("#stat-answers")).trim() === "2");

/* ------------------------------------------------------------------ */
console.log("\nthe list stays current while the popup is open");
await page.evaluate(() => {
  window.__store.heldAnswers.push({ question: "Are you over the age of 18?", answer: "No", inputType: "select", options: ["Yes", "No"] });
  window.__changed(["heldAnswers"]);
});
await page.waitForTimeout(500);
check("an answer captured on the page appears without reopening the popup",
  (await page.$$eval("#pending-list li", (lis) => lis.map((li) => li.textContent))).some((t) => /over the age of 18/.test(t)));

/* ------------------------------------------------------------------ */
console.log("\ntyping an answer in by hand");
await page.click("#add-answer");
check("the form opens", await page.evaluate(() => !document.getElementById("add-answer-form").hidden));
await page.fill("#add-question", "Do you currently hold an active security clearance?");
await page.fill("#add-answer-text", "No");
await page.click("#add-answer-save");
await page.waitForTimeout(500);
const added = await page.evaluate(() => window.__sent.find((m) => m.type === "APPLI_FILL_ADD_PENDING"));
check("it is added", added?.question === "Do you currently hold an active security clearance?" && added?.answer === "No", JSON.stringify(added));
const lastSave = await page.evaluate(() => window.__sent.filter((m) => m.type === "APPLI_FILL_SAVE_HELD").pop());
check("and saved to the dashboard straight away", lastSave?.questions?.[0] === "Do you currently hold an active security clearance?",
  JSON.stringify(lastSave));
check("the form closes afterwards", await page.evaluate(() => document.getElementById("add-answer-form").hidden));

await page.screenshot({ path: join(ROOT, "screenshots", "popup-pending.png"), fullPage: true }).catch(() => {});

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
