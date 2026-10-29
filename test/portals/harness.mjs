/**
 * Shared harness for the per-portal fixtures.
 *
 * Loads the real extension libraries into a page holding a faithful copy of one
 * ATS's markup, runs a single fill, and reports what landed where — so a
 * fixture file only has to describe the form and the expectations.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

export const PROFILE = {
  _id: "p1",
  label: "Default",
  personal: {
    firstName: "Madhu", middleName: "R", lastName: "Kumar",
    preferredName: "Madhu",
    email: "madhu.ittech@gmail.com",
    phone: "6305550142", phoneCountryCode: "+1", phoneType: "Mobile",
    address: "1703 High Point Terrace", addressLine2: "Apt 4B",
    city: "Stanley", state: "North Carolina", zip: "28164",
    country: "United States", nationality: "India",
    dateOfBirth: "1992-07-14", pronouns: "he/him",
  },
  websites: [
    { label: "LinkedIn", url: "https://linkedin.com/in/madhukumar" },
    { label: "GitHub", url: "https://github.com/madhukumar" },
    { label: "Portfolio", url: "https://madhukumar.dev" },
  ],
  workAuth: {
    authorizedToWork: "Yes", requireSponsorship: "No",
    visaStatus: "H-1B", willingToRelocate: "Yes",
    noticePeriod: "2 weeks", startDate: "2026-10-01",
    remotePreference: "Hybrid", howDidYouHear: "LinkedIn",
    securityClearance: "No", driversLicense: "Yes",
    over18: "Yes", previouslyEmployed: "No",
  },
  compensation: { desiredSalary: "160000", currentSalary: "145000" },
  eeo: {
    gender: "Male", hispanicLatino: "No", race: "Asian",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No",
  },
  experience: [
    {
      company: "Northern Trust Bank", title: "Senior DevOps Engineer",
      location: "Chicago, IL", startDate: "2025-04", endDate: "",
      current: true, description: "Governed identity and access compliance.",
    },
    {
      company: "Cognizant", title: "IAM Security Engineer",
      location: "Hyderabad, India", startDate: "2021-06", endDate: "2025-03",
      current: false, description: "Applied IT governance and risk management.",
    },
  ],
  education: [
    {
      school: "Northwestern Polytechnic University", degree: "Master's Degree",
      fieldOfStudy: "Computer Science", location: "Fremont, CA",
      startDate: "2014-01", endDate: "2016-01", gpa: "3.8",
    },
  ],
  skills: ["Kubernetes", "Terraform", "Okta", "Python"],
  languages: ["English", "Hindi", "Telugu"],
  summary: "DevOps and IAM engineer with eight years across banking and consulting.",
  documents: [],
};

export const SAVED_RESPONSES = [
  { question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks", aliases: [] },
  { question: "How did you hear about us?", normalizedKey: "how hear about us", answer: "LinkedIn", aliases: ["How did you hear about this opportunity?"] },
  { question: "Years of relevant experience", normalizedKey: "years relevant experience", answer: "8", aliases: [] },
  { question: "Why do you want to work here?", normalizedKey: "why want work here", answer: "The platform work and the scale of the identity problem.", aliases: [] },
  { question: "Do you have experience with Kubernetes?", normalizedKey: "have experience kubernetes", answer: "Yes", aliases: [] },
  { question: "What is your desired salary?", normalizedKey: "what desired salary", answer: "160000", aliases: [] },
];

const results = [];
export const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

export function report(title) {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed — ${title}\n`);
  return results.every((r) => r.pass);
}

/**
 * Boots a page on `fixture`, injects the extension, runs one fill and hands
 * back the page plus helpers for reading what the fill produced.
 */
export async function runFixture(fixture, { profile = PROFILE, responses = SAVED_RESPONSES, premium = false, settings = {}, url } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    // Keep the fixture offline: a test page must never depend on the network,
    // and Chromium's own background fetches only add noise to the run.
    args: ["--no-sandbox", "--disable-background-networking", "--disable-component-update", "--no-first-run"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("  console error:", m.text()); });

  await page.addInitScript(({ profile, responses, premium, settings }) => {
    window.__APPLI_FILL_TEST = true;
    const session = {
      profile, profiles: [profile], responses, premium,
      settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false, ...settings },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          const reply =
            msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session } :
            msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } } :
            { ok: true, data: {} };
          setTimeout(() => cb && cb(reply), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile, responses, premium, settings });

  // A real posting URL matters: several adapters key off the hostname.
  if (url) {
    await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
    await page.goto(url);
    await page.setContent(await readFile(fixture, "utf8"));
  } else {
    await page.goto(pathToFileURL(fixture).href);
  }

  for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
  }
  await page.addStyleTag({ content: await readFile(join(EXT, "content/overlay.css"), "utf8") });

  const runResult = await page.evaluate(async () => {
    const res = await window.__applifill.run({ manual: true });
    return {
      filled: res?.data?.filled ?? 0,
      unmatchedCount: res?.data?.unmatched ?? 0,
      ats: window.APPLI_FILL_ATS?.detect?.()?.key ?? null,
      unmatched: (window.__applifill.state.unmatched || []).map((f) => ({
        id: f.el.id || f.el.name || f.el.getAttribute?.("data-automation-id") || f.el.tagName,
        label: String(f.label || "").slice(0, 90),
        kind: f.kind,
      })),
    };
  });

  /** The value a human would see in the control with this id. */
  const read = (id) =>
    page.evaluate((sel) => {
      const el = document.getElementById(sel) || document.querySelector(`[name="${sel}"], [data-automation-id="${sel}"]`);
      if (!el) return null;
      const M = window.APPLI_FILL_MATCHER;
      if (el.tagName === "SELECT") return el.value;
      if (el.tagName === "BUTTON" || el.getAttribute("role") === "combobox" || el.getAttribute("role") === "button") {
        return M.comboboxDisplayValue?.(el) || el.getAttribute("aria-valuetext") || el.textContent.trim();
      }
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? (el.value || "on") : null;
      return el.value;
    }, id);

  /** Which option of a radio/checkbox group is selected. */
  const picked = (name) =>
    page.evaluate((n) => {
      const list = Array.from(document.querySelectorAll(`input[name="${n}"]`)).filter((r) => r.checked);
      return list.length ? list.map((r) => r.value || r.getAttribute("aria-label") || "on") : null;
    }, name);

  /** What a react-select style widget would actually submit. */
  const hidden = (name) =>
    page.evaluate((n) => document.querySelector(`input[type="hidden"][name="${n}"]`)?.value ?? null, name);

  return { browser, page, runResult, read, picked, hidden };
}
