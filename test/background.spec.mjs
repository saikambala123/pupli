/**
 * The service worker's sync path.
 *
 *   node test/background.spec.mjs
 *
 * "Sync now" is two-way. The pull half is what carries answers typed into the
 * dashboard's Saved Answers tab down to the extension, and it used to be
 * skipped whenever the local queue happened to be empty — so a user who had
 * only added answers in the dashboard pressed the button and got nothing.
 *
 * background.js is a service worker, so it is run here inside a vm with a
 * minimal `chrome` and `fetch` stubbed in front of it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

/** Boots background.js against a fake browser and a fake API. */
async function boot({ storage = {}, savedAnswers = [] } = {}) {
  const calls = [];
  let listener = null;

  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
          const out = {};
          for (const k of wanted) if (k in storage) out[k] = storage[k];
          cb(out);
        },
        set(obj, cb) { Object.assign(storage, obj); cb && cb(); },
        remove(keys, cb) {
          for (const k of (typeof keys === "string" ? [keys] : keys)) delete storage[k];
          cb && cb();
        },
      },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: { create() {}, query: async () => [], onActivated: { addListener() {} }, sendMessage() {} },
    commands: { onCommand: { addListener() {} } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
  };

  const fetchStub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    if (String(url).includes("/api/extension/bootstrap")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            user: { premium: false }, settings: {}, activeProfileId: "p1",
            profiles: [{ _id: "p1", isDefault: true }],
            responses: savedAnswers,
            syncedAt: "2026-08-26T00:00:00.000Z",
          },
        }),
      };
    }
    // The worker now reports the number the *server* confirmed it wrote rather
    // than the number it offered, so the stub has to answer honestly or the
    // count check is testing nothing.
    const body = (() => { try { return JSON.parse(options.body || "{}"); } catch { return {}; } })();
    // `/api/extension/sync` reports *which* answers it wrote, not just how
    // many, and the worker clears only those. The stub returned the count
    // alone, so nothing was ever confirmed and the queue looked stuck — a
    // property of the stub, not of the worker.
    const normalize = (q) => String(q ?? "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const responses = body.responses ?? [];
    return {
      ok: true, status: 200,
      json: async () => ({
        data: {
          responsesSaved: responses.length,
          savedKeys: responses.map((r) => normalize(r?.question)),
        },
      }),
    };
  };

  const context = vm.createContext({
    chrome, fetch: fetchStub, console,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, JSON, Math, Promise,
    // The worker aborts a request that stalls, so the sandbox needs the same
    // globals a service worker has. Without these every api() call threw a
    // ReferenceError and the whole spec died on its first network call.
    AbortController, Object, Array, Set, Map, String, Number, Boolean, Error,
  });
  vm.runInContext(await readFile(join(ROOT, "extension/background.js"), "utf8"), context);

  const send = (msg) =>
    new Promise((resolve) => {
      listener(msg, {}, resolve);
    });

  return { send, calls, storage };
}

const ANSWERS = [
  { _id: "r1", question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks" },
  { _id: "r2", question: "Are you willing to relocate?", normalizedKey: "willing relocate", answer: "Yes" },
];

/* --- the reported bug: nothing queued locally, answers waiting in the dashboard --- */
{
  const { send, calls, storage } = await boot({
    storage: { token: "t", apiBase: "https://applifill.test" },
    savedAnswers: ANSWERS,
  });

  const res = await send({ type: "APPLI_FILL_SYNC_PENDING" });

  check("Sync now succeeds with an empty local queue", res?.ok === true, JSON.stringify(res));
  check(
    "Sync now still fetches the dashboard's saved answers",
    calls.some((c) => c.url.includes("/api/extension/bootstrap")),
    `requests: ${calls.map((c) => c.url).join(", ") || "none"}`
  );
  check("Sync now reports how many answers it pulled", res?.data?.savedAnswers === 2, JSON.stringify(res?.data));
  check("the pulled answers are cached for the content script", storage.session?.responses?.length === 2);
}

/* --- the push half still works, and the queue is cleared --- */
{
  const { send, calls, storage } = await boot({
    storage: {
      token: "t", apiBase: "https://applifill.test",
      pendingResponses: [{ question: "Why this company?", answer: "Mission fit" }],
    },
    savedAnswers: ANSWERS,
  });

  const res = await send({ type: "APPLI_FILL_SYNC_PENDING" });

  check("queued answers are uploaded", calls.some((c) => c.url.includes("/api/extension/sync") && c.method === "POST"));
  check("the local queue is cleared after a successful upload", storage.pendingResponses === undefined);
  check("the upload count is reported", res?.data?.responsesSaved === 1, JSON.stringify(res?.data));
  check("a pull still happens after the push", calls.some((c) => c.url.includes("/api/extension/bootstrap")));
}

/* --- Clear discards the queue locally and never uploads it --- */
{
  const { send, calls, storage } = await boot({
    storage: {
      token: "t", apiBase: "https://applifill.test",
      session: { profile: { _id: "p1" }, responses: ANSWERS },
      pendingResponses: [
        { question: "Why this company?", answer: "Mission fit" },
        { question: "Notice period?", answer: "teo weeks" },   // the typo the user wants gone
      ],
    },
    savedAnswers: ANSWERS,
  });

  const res = await send({ type: "APPLI_FILL_CLEAR_PENDING" });

  check("Clear reports how many answers it discarded", res?.data?.cleared === 2, JSON.stringify(res?.data));
  check("Clear empties the local queue", storage.pendingResponses === undefined);
  check(
    "Clear uploads nothing",
    !calls.some((c) => c.url.includes("/api/extension/sync")),
    `requests: ${calls.map((c) => c.url).join(", ") || "none"}`
  );
  check(
    "Clear leaves answers already saved in the dashboard alone",
    storage.session?.responses?.length === 2,
    JSON.stringify(storage.session?.responses?.length)
  );
}

/* --- Clear on an already-empty queue is harmless --- */
{
  const { send } = await boot({ storage: { token: "t", apiBase: "https://applifill.test" }, savedAnswers: ANSWERS });
  const res = await send({ type: "APPLI_FILL_CLEAR_PENDING" });
  check("Clear succeeds with nothing queued", res?.ok === true && res?.data?.cleared === 0, JSON.stringify(res));
}

/* --- re-answering one question replaces its queued entry --- */
{
  const { send, storage } = await boot({ storage: { token: "t", apiBase: "https://applifill.test" } });

  await send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [{ question: "What is your notice period?", answer: "2 weeks" }] });
  await send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [{ question: "What is your notice period?", answer: "30 days" }] });
  // Same question, different punctuation — one entry, not two.
  await send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [{ question: "What is your notice period?*", answer: "Immediately" }] });

  const queued = storage.pendingResponses ?? [];
  check("one question queues exactly once", queued.length === 1, JSON.stringify(queued));
  check("the newest answer is the one queued", queued[0]?.answer === "Immediately", JSON.stringify(queued));

  await send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [{ question: "Why this company?", answer: "Mission" }] });
  check("a different question queues separately", (storage.pendingResponses ?? []).length === 2, JSON.stringify(storage.pendingResponses));
}

/* --- one queued answer can be removed on its own --- */
{
  const { send, storage } = await boot({
    storage: {
      token: "t", apiBase: "https://applifill.test",
      pendingResponses: [
        { question: "What is your notice period?", answer: "30 days" },
        { question: "Why this company?", answer: "Mission" },
        { question: "Are you authorized to work?", answer: "Yes" },
      ],
    },
  });

  const res = await send({ type: "APPLI_FILL_DELETE_PENDING", question: "Why this company?" });
  const left = (storage.pendingResponses ?? []).map((r) => r.question);

  check("removing one answer reports it", res?.data?.removed === 1, JSON.stringify(res?.data));
  check("the removed answer is gone", !left.includes("Why this company?"), JSON.stringify(left));
  check("the other answers are untouched", left.length === 2, JSON.stringify(left));

  // Matched on the same normalisation the queue is keyed by.
  await send({ type: "APPLI_FILL_DELETE_PENDING", question: "What is your notice period?*" });
  check("punctuation doesn't stop a removal", (storage.pendingResponses ?? []).length === 1, JSON.stringify(storage.pendingResponses));
}

/* --- dropdown and radio answers survive the trip to the server --- */
{
  const { send, calls, storage } = await boot({ storage: { token: "t", apiBase: "https://applifill.test" }, savedAnswers: ANSWERS });

  await send({ type: "APPLI_FILL_QUEUE_RESPONSES", responses: [
    { question: "What is your highest level of education?", answer: "Master's Degree", inputType: "select",
      options: ["High School", "Bachelor's Degree", "Master's Degree"], ats: "greenhouse", domain: "boards.greenhouse.io" },
    { question: "How did you hear about this opportunity?", answer: "LinkedIn", inputType: "radio",
      options: ["LinkedIn", "Referral", "Job Board"], ats: "greenhouse", domain: "boards.greenhouse.io" },
    { question: "Which shifts are you available for?", answer: "Evenings", inputType: "checkbox",
      options: ["Mornings", "Evenings", "Weekends"] },
    { question: "Do you have a valid driver's license?", answer: "Yes", inputType: "radio", options: ["Yes", "No"] },
  ]});

  const res = await send({ type: "APPLI_FILL_SYNC_PENDING" });
  const push = calls.find((c) => c.url.includes("/api/extension/sync") && c.method === "POST");
  const sent = push ? JSON.parse(push.body).responses : [];
  const byQ = (needle) => sent.find((r) => r.question.toLowerCase().includes(needle));

  check("sync uploads every queued answer", sent.length === 4, `uploaded ${sent.length}: ${sent.map((r) => r.question).join(" | ")}`);
  check("a dropdown answer is uploaded", byQ("highest level")?.answer === "Master's Degree", JSON.stringify(byQ("highest level")));
  check("a radio answer is uploaded", byQ("hear about")?.answer === "LinkedIn", JSON.stringify(byQ("hear about")));
  check("a checkbox answer is uploaded", byQ("shifts")?.answer === "Evenings", JSON.stringify(byQ("shifts")));
  check("the control type travels with the answer", byQ("highest level")?.inputType === "select", JSON.stringify(byQ("highest level")?.inputType));
  check("the choices travel with the answer", (byQ("hear about")?.options ?? []).length === 3, JSON.stringify(byQ("hear about")?.options));
  check("the report counts them", res?.data?.responsesSaved === 4, JSON.stringify(res?.data));
  check("the queue is emptied once they are up", storage.pendingResponses === undefined, JSON.stringify(storage.pendingResponses));
}

/* --- a fresh session must not be served from an empty cache --- */
{
  const { send } = await boot({ storage: { token: "t", apiBase: "https://applifill.test" }, savedAnswers: ANSWERS });
  const res = await send({ type: "APPLI_FILL_GET_SESSION", force: true });
  check("the content script receives the saved answers", res?.data?.responses?.length === 2, JSON.stringify(res?.data?.responses));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
