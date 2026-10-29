/**
 * Side-by-side comparison of the old and new autofill engines on the same
 * mock application form.
 *
 *   node test/compare.mjs
 *
 * Records, for each build: how long the fill took, how many fields it filled,
 * how many times each control was written, how many dropdowns were opened, how
 * many menus were on screen at once, and how far the page scrolled — the last
 * one being what "flickering" looks like as a number.
 *
 * Set APPLI_FILL_OLD to a checkout of the previous extension to run the comparison;
 * otherwise only the current build is measured.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com",
    phone: "+1 630 555 0142", address: "4685 Old Oaks Dr, Lisle, IL, 60532",
    city: "Lisle", state: "Illinois", zip: "60532", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", willingToRelocate: "Yes", noticePeriod: "2 weeks", howDidYouHear: "LinkedIn" },
  eeo: { gender: "Male", race: "Asian", veteranStatus: "I am not a protected veteran", disabilityStatus: "No" },
  experience: [
    { company: "Northern Trust Bank", title: "Senior DevOps Engineer", location: "Chicago, IL", startDate: "2025-04", endDate: "", current: true, description: "Client: American Express Bank." },
    { company: "Cognizant", title: "IAM Security Engineer", location: "Hyderabad, India", startDate: "2021-06", endDate: "2025-03", current: false, description: "IT governance and risk management." },
  ],
  education: [{ school: "Northwestern Polytechnic University", degree: "Master's Degree", fieldOfStudy: "Computer Science", startDate: "2014-01", endDate: "2016-01" }],
  documents: [],
};

const SAVED = [
  { question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks", aliases: [] },
  { question: "Are you willing to relocate?", normalizedKey: "willing relocate", answer: "Yes", aliases: [] },
  { question: "How did you hear about this opportunity?", normalizedKey: "how hear about opportunity", answer: "LinkedIn", aliases: [] },
];

async function measure(label, extDir) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", () => {});

  await page.addInitScript(({ profile, responses }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
    };
    window.chrome = { runtime: { lastError: null,
      sendMessage(m, cb) {
        const r = m?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} } } };
  }, { profile: PROFILE, responses: SAVED });

  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/forms.html")).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(extDir, f), "utf8") });
  }
  await page.addStyleTag({ content: await readFile(join(extDir, "content/overlay.css"), "utf8") });

  await page.evaluate(() => {
    window.__peak = 0;
    window.__scrollJumps = 0;
    window.__scrollDistance = 0;
    window.__lastY = window.scrollY;
    window.__samples = 0;
    window.__watch = setInterval(() => {
      window.__samples++;
      let n = 0;
      document.querySelectorAll('[role="listbox"]').forEach((m) => {
        if (m.getBoundingClientRect().height > 0) n++;
      });
      window.__peak = Math.max(window.__peak, n);
      const y = window.scrollY;
      const delta = Math.abs(y - window.__lastY);
      if (delta > 24) { window.__scrollJumps++; window.__scrollDistance += delta; }
      window.__lastY = y;
    }, 10);
  });

  const t0 = Date.now();
  const data = await page.evaluate(async () => {
    const res = await window.__applifill.run({ manual: true });
    clearInterval(window.__watch);
    const opens = window.ZTEST.opens;
    const values = window.ZTEST.values;
    return {
      filled: res?.data?.filled ?? 0,
      unmatched: res?.data?.unmatched ?? 0,
      peakMenus: Math.max(window.__peak, window.ZTEST.maxConcurrent),
      openLog: opens,
      scrollJumps: window.__scrollJumps,
      scrollDistance: Math.round(window.__scrollDistance),
      menuOpens: Object.values(opens).reduce((a, b) => a + b, 0),
      controlsOpened: Object.keys(opens).length,
      reopened: Object.entries(opens).filter(([, n]) => n > 1).length,
      rewritten: Object.entries(values).filter(([, v]) => v.length > 1).length,
      bodyClicks: window.ZTEST.bodyClicks,
      menusLeftOpen: Array.from(document.querySelectorAll('[role="listbox"]'))
        .filter((m) => m.getBoundingClientRect().height > 0).length,
    };
  });
  data.ms = Date.now() - t0;
  data.label = label;
  await browser.close();
  return data;
}

const runs = [await measure("new", join(ROOT, "extension"))];
if (process.env.APPLI_FILL_OLD) runs.unshift(await measure("old", process.env.APPLI_FILL_OLD));

const rows = [
  ["duration", "ms"],
  ["fields filled", "filled"],
  ["left for the user", "unmatched"],
  ["dropdown openings", "menuOpens"],
  ["dropdowns reopened", "reopened"],
  ["fields written twice+", "rewritten"],
  ["menus open at once (peak)", "peakMenus"],
  ["menus left open", "menusLeftOpen"],
  ["synthetic body clicks", "bodyClicks"],
  ["page scroll jumps", "scrollJumps"],
  ["total scroll distance (px)", "scrollDistance"],
];

const pad = (s, n) => String(s).padEnd(n);
const head = ["metric", ...runs.map((r) => r.label)];
console.log("\n" + pad(head[0], 28) + head.slice(1).map((h) => pad(h, 12)).join(""));
console.log("-".repeat(28 + runs.length * 12));
for (const [name, key] of rows) {
  console.log(pad(name, 28) + runs.map((r) => pad(r[key], 12)).join(""));
}
console.log();
