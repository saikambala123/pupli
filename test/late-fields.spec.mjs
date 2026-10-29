/**
 * Every control type, on a section that rendered after the page booted.
 *
 *   node test/late-fields.spec.mjs
 *
 * `watchPage()` scans once, at boot. After that the only thing attaching a
 * watcher is a `focusin` handler — so a control that renders later and cannot
 * take focus (a div with role=radio, a custom checkbox) is never watched, and
 * answering it produces nothing to save. Multi-step applications, "Add another"
 * sections and late-hydrating demographic blocks are all this shape, which is
 * the "my answers don't show up in the extension" report.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu@example.com", country: "United States" },
  workAuth: {}, eeo: {}, experience: [], education: [], documents: [],
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  window.__held = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg?.type === "APPLI_FILL_HOLD_ANSWERS") window.__held.push(...(msg.items || []));
        const reply = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

// This fixture initially has only one textarea. Use a careers URL so it is
// recognized as an application when the later controls arrive; a file:// URL
// supplies no application context and was testing an unrelated page instead.
await page.route("**/*", async (route) => route.fulfill({
  contentType: "text/html",
  body: await readFile(join(ROOT, "test/fixtures/late-fields.html"), "utf8"),
}));
await page.goto("https://careers.example.test/jobs/field-engineer/apply");
for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}
await page.waitForTimeout(400);          // boot() scans the page here

// Step two arrives only now — after the one scan the content script does.
await page.evaluate(() => window.renderStep2());
await page.waitForTimeout(600);

const held = () => page.evaluate(() =>
  window.__held.map((h) => ({ q: h.question, a: String(h.answer), t: h.inputType }))
);
const find = async (needle) => (await held()).filter((h) => (h.q || "").toLowerCase().includes(needle)).pop();

/* ---- every type, answered by hand on the late section ---- */
await page.selectOption("#late-select", "2-4");
await page.waitForTimeout(500);

await page.click('input[name="late_travel"][value="Yes"]');
await page.waitForTimeout(500);

await page.click('input[name="late_certs"][value="CKA"]');
await page.waitForTimeout(500);

await page.click("#late-text");
await page.type("#late-text", "$185,000");
await page.click("h1");
await page.waitForTimeout(500);

await page.click('[role="radio"][data-value="Nights"]');
await page.waitForTimeout(600);

await page.click('[role="checkbox"][data-value="Grafana"]');
await page.waitForTimeout(600);

const rows = await held();
const detail = JSON.stringify(rows.map((r) => `${r.q}=${r.a}`));

check("a late dropdown answer is held", (await find("kubernetes"))?.a === "2-4", detail);
check("a late radio answer is held", (await find("travel"))?.a === "Yes", detail);
check("a late checkbox answer is held", (await find("certification"))?.a === "CKA", detail);
check("a late text answer is held", (await find("salary"))?.a === "$185,000", detail);
check("a custom radio group answer is held", (await find("shift"))?.a === "Nights", detail);
check("a custom checkbox group answer is held", (await find("tools"))?.a === "Grafana", detail);

check(
  "each late answer carries its own control type",
  (await find("kubernetes"))?.t === "select" &&
  (await find("travel"))?.t === "radio" &&
  (await find("certification"))?.t === "checkbox" &&
  (await find("salary"))?.t === "text",
  JSON.stringify(rows.map((r) => `${r.q}:${r.t}`))
);

check(
  "no question is held twice",
  new Set(rows.map((r) => r.q)).size === rows.length,
  JSON.stringify(rows.map((r) => r.q))
);

/* ---- changing an answer replaces it ---- */
await page.selectOption("#late-select", "5+");
await page.waitForTimeout(600);
check("changing a late dropdown holds the newer answer", (await find("kubernetes"))?.a === "5+",
  JSON.stringify((await held()).filter((r) => /kubernetes/i.test(r.q)).map((r) => r.a)));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
