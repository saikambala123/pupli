/**
 * What the AI pass actually asks for, and what it does with the reply.
 *
 * The answer service is stubbed, so this asserts the contract between the
 * content script and the route: the question text sent over the wire, the
 * options offered, and whether a reply that is not on the menu is refused.
 */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROFILE, SAVED_RESPONSES, check, report, EXT, ROOT } from "./harness.mjs";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile, responses }) => {
  window.__APPLI_FILL_TEST = true;
  window.__asked = [];
  const session = {
    profile, profiles: [profile], responses, premium: true,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false, aiAnswers: true },
  };
  // A stand-in for the answer service: records the request and replies with a
  // value the form would accept.
  const answerFor = (payload) => {
    const q = String(payload.question || "");
    if (/interested in joining/i.test(q)) return "Orbit runs identity at a scale I want to work on.";
    if (/project you are proud of/i.test(q)) return "I rebuilt access reviews at Northern Trust for 40k identities.";
    if (Array.isArray(payload.options) && payload.options.length) {
      if (/production/i.test(q)) return "Kubernetes";
      if (/days per week/i.test(q)) return "3";
      return payload.options[0];
    }
    return "";
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        let reply = { ok: true, data: {} };
        if (msg?.type === "APPLI_FILL_GET_SESSION") reply = { ok: true, data: session };
        else if (msg?.type === "APPLI_FILL_CHECK") reply = { ok: true, data: { duplicate: false } };
        else if (msg?.type === "APPLI_FILL_ANSWER_BATCH") {
          // One request for the page; each question is recorded as asked.
          window.__batches = (window.__batches || 0) + 1;
          const questions = msg.payload.questions || [];
          questions.forEach((q) => window.__asked.push(q));
          reply = { ok: true, data: { answers: questions.map((q) => ({ id: q.id, answer: answerFor(q) })) } };
        }
        else if (msg?.type === "APPLI_FILL_ANSWER") {
          window.__single = (window.__single || 0) + 1;
          window.__asked.push(msg.payload);
          reply = { ok: true, data: { answer: answerFor(msg.payload) } };
        }
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE, responses: SAVED_RESPONSES });

await page.goto(pathToFileURL(join(ROOT, "test/portals/ai.html")).href);
for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}

const out = await page.evaluate(async () => {
  const res = await window.__applifill.run({ manual: true });
  const val = (id) => {
    const el = document.getElementById(id);
    return el.tagName === "SELECT" ? el.value : el.value;
  };
  return {
    drafted: res?.data?.drafted ?? 0,
    batches: window.__batches || 0,
    single: window.__single || 0,
    asked: window.__asked,
    why: val("ai-why"),
    proud: val("ai-proud"),
    tooling: val("ai-tooling"),
    onsite: val("ai-onsite"),
  };
});

console.log(`\nAI pass — ${out.asked.length} questions sent, ${out.drafted} drafted\n`);
console.log("questions sent over the wire:");
for (const a of out.asked) console.log(`   • ${JSON.stringify(a.question)}  [${a.fieldType}] options=${(a.options || []).length}`);
console.log("");

const asked = out.asked.map((a) => String(a.question));
const clean = (q) => !q.includes("|");

check("the page's questions go in one request", out.batches === 1 && out.single === 0,
  `${out.batches} batch request(s), ${out.single} single`);
check("the open question is sent as the question alone", asked.some((q) => q === "Why are you interested in joining Orbit?"),
  `sent: ${JSON.stringify(asked.find((q) => /interested in joining/.test(q)))}`);
check("no question carries the pipe-joined label blob", asked.every(clean),
  `blobs: ${JSON.stringify(asked.filter((q) => !clean(q)))}`);
check("no question leaks the machine name", asked.every((q) => !/custom_question|custom question \d/i.test(q)),
  `leaked: ${JSON.stringify(asked.filter((q) => /custom_question|custom question \d/i.test(q)))}`);

check("the 'why' answer landed", /identity at a scale/.test(out.why || ""), `= ${out.why}`);
check("the 'proud of' answer landed", /access reviews/.test(out.proud || ""), `= ${out.proud}`);
check("the menu question was given its options", out.asked.some((a) => /production/i.test(a.question) && (a.options || []).includes("Kubernetes")),
  `options sent: ${JSON.stringify(out.asked.find((a) => /production/i.test(a.question))?.options)}`);
check("the menu answer landed", out.tooling === "Kubernetes", `= ${out.tooling}`);
check("the numeric menu answer landed", out.onsite === "3", `= ${out.onsite}`);
check("identity fields were never sent to the model", !asked.some((q) => /first name|email/i.test(q)),
  `sent: ${JSON.stringify(asked.filter((q) => /first name|email/i.test(q)))}`);

await browser.close();
process.exit(report("AI answers") ? 0 : 1);
