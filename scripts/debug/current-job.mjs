import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const ROOT = new URL("../..", import.meta.url).pathname;
const EXT = join(ROOT, "extension");
// Only the FIRST job is current, exactly as the profile would have it.
const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "m@x.com" },
  websites: {}, workAuth: {}, eeo: {},
  experience: [
    { title: "Senior DevOps Engineer", company: "Northern Trust", location: "Chicago, IL",
      startDate: "2025-02", endDate: "", current: true, description: "Current role." },
    { title: "DevOps Engineer", company: "One Trust LLC", location: "Austin, TX",
      startDate: "2021-06", endDate: "2022-02", current: false, description: "Managed Azure." },
    { title: "Cloud Engineer", company: "Cognizant", location: "Hyderabad, India",
      startDate: "2019-03", endDate: "2021-05", current: false, description: "Cloud." },
  ],
  education: [], documents: [],
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  const session = { profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false } };
  window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
    const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
      : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
    setTimeout(() => cb && cb(r), 0);
  }, onMessage: { addListener() {} } } };
}, { profile: PROFILE });
await page.goto(pathToFileURL(join(ROOT, "test/fixtures/tmp-wd3.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"])
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
await page.waitForTimeout(250);
await page.evaluate(async () => await window.__applifill.run({ manual: true }));
await page.waitForTimeout(1400);
const out = await page.evaluate(() => {
  const ids = ["w1cur","w2cur","w3cur"];
  const boxes = ids.map((i) => i + "=" + (document.getElementById(i)?.checked));
  const fields = window.__applifill.collectFields()
    .filter((f) => f.rule?.key === "currentJob")
    .map((f) => ({ id: f.el.id, index: f.index, label: f.label }));
  const dates = ["w1f-m","w1f-y","w1to-m","w1to-y","w2f-m","w2f-y","w2to-m","w2to-y","w3f-m","w3f-y","w3to-m","w3to-y"]
    .map((i) => i + "=" + (document.getElementById(i)?.value ?? "?"));
  const companies = ["w1c","w2c","w3c"].map((i) => i + "=" + document.getElementById(i).value);
  return { boxes, fields, dates, companies };
});
console.log("checkboxes:", out.boxes.join("  "));
console.log("companies :", out.companies.join("  "));
console.log("dates     :", out.dates.join(" "));
console.log("fields    :", JSON.stringify(out.fields, null, 1));
await browser.close();
