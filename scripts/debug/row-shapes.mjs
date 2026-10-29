import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const ROOT = new URL("../..", import.meta.url).pathname;
const EXT = join(ROOT, "extension");
const CURRENT_AT = Number(process.env.CUR ?? 0);   // which job is the current one, -1 for none
const PROFILE = {
  _id: "p1", label: "Default", personal: { firstName: "M", lastName: "K", email: "m@x.com" },
  websites: {}, workAuth: {}, eeo: {},
  experience: [
    { title: "Senior DevOps Engineer", company: "Northern Trust", startDate: "2025-02", endDate: "2025-08", current: CURRENT_AT === 0 },
    { title: "DevOps Engineer", company: "One Trust LLC", startDate: "2021-06", endDate: "2022-02", current: CURRENT_AT === 1 },
    { title: "Cloud Engineer", company: "Cognizant", startDate: "2019-03", endDate: "2021-05", current: CURRENT_AT === 2 },
  ],
  education: [], documents: [],
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
for (const shape of ["A", "B", "C"]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
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
  await page.goto(pathToFileURL(join(ROOT, `test/fixtures/${shape}.html`)).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"])
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  await page.waitForTimeout(200);
  await page.evaluate(async () => await window.__applifill.run({ manual: true }));
  await page.waitForTimeout(1000);
  const out = await page.evaluate(() => {
    const isOn = (el) => el.getAttribute("role") === "checkbox" ? el.getAttribute("aria-checked") === "true" : el.checked;
    const boxes = [1,2,3].map((n) => `cur${n}=${isOn(document.getElementById("cur" + n))}`);
    const comps = [1,2,3].map((n) => `c${n}="${document.getElementById("c" + n).value}"`);
    const idx = window.__applifill.collectFields().filter((f) => f.rule?.key === "currentJob")
      .map((f) => `${f.el.id}:idx=${f.index}`);
    return { boxes, comps, idx };
  });
  console.log(`shape ${shape}: ${out.boxes.join(" ")}   | ${out.idx.join(" ")}`);
  console.log(`          ${out.comps.join(" ")}`);
  await page.close();
}
await browser.close();
