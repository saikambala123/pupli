/**
 * Address: values the page takes and then says are missing.
 *
 *   node test/workday-address.spec.mjs
 *
 * Reported on Workday: "The field Address Line 1 is required and must have a
 * value" with the address plainly in the box, the same for Postal Code, and
 * Address Line 2 holding a copy of Line 1.
 *
 * Workday rebuilds its address section once the country resolves. The boxes keep
 * their text, its model does not, and it marks the required ones invalid. Round
 * 6's settle passes only restore fields that are *empty*, so a field that is
 * full but disowned was invisible to them.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

// addressLine2 duplicates the street, as résumé parsing sometimes leaves it.
const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com",
    address: "4685 Old Oaks Dr", addressLine2: "4685 Old Oaks Dr",
    city: "Chicago", state: "Illinois", zip: "60532", country: "United States",
  },
  workAuth: {}, eeo: {}, education: [], experience: [], documents: [],
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(({ profile }) => {
  window.__APPLI_FILL_TEST = true;
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(m, cb) {
        const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : m?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/workday-address.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(250);
await page.evaluate(async () => await window.__applifill.run({ manual: true }));
await page.waitForTimeout(3400);   // the re-render, then the settle passes
await page.click("#save");
await page.waitForTimeout(200);

const v = (id) => page.inputValue("#" + id);
const missing = await page.evaluate(() => window.__missing ?? []);

check("the page really did rebuild its address section", await page.evaluate(() => window.__rerendered === true),
  "the fixture never re-rendered, so this case proves nothing");

check("address line 1 holds the street once", (await v("a1")) === "4685 Old Oaks Dr", `got "${await v("a1")}"`);
check("address line 2 is not a copy of line 1", (await v("a2")) === "", `got "${await v("a2")}"`);
check("city is filled", (await v("ct")) === "Chicago", `got "${await v("ct")}"`);
check("postal code is filled", (await v("pc")) === "60532", `got "${await v("pc")}"`);

check(
  "nothing is still required after the re-render",
  missing.length === 0,
  `still required: ${missing.join(", ")} — full boxes the page had disowned`
);
check(
  "the page cleared its own error flags",
  (await page.evaluate(() => document.getElementById("a1").getAttribute("aria-invalid"))) !== "true",
  "address line 1 is still marked invalid"
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
