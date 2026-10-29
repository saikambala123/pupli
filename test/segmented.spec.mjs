/**
 * Segmented choice buttons, and section context that belongs to the page.
 *
 *   node test/segmented.spec.mjs
 *
 * Reproduces a REGENT/Jobright application the user reported, which failed two
 * ways at once:
 *
 *   1. "Full-time" was written into Name and Email. The posting's details panel
 *      beside the form carries an "Employment Type / Full time" heading. It
 *      shares an ancestor with the form and precedes it, so it was accepted as
 *      the fields' section context — and employmentType (weight 12) outranked
 *      fullName (weight 6) and email (weight 10).
 *
 *   2. Three yes/no questions rendered as plain <button> pairs were never
 *      collected, so they were neither answered nor reported. The status pill
 *      said "2 fields need your answer" while three sat untouched.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.APPLI_FILL_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: {
    firstName: "Madhu", lastName: "Kumar",
    email: "madhu.ittech@gmail.com", country: "United States",
  },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", willingToRelocate: "Yes" },
  eeo: {},
  // employmentType is present and correct for the job history — it simply must
  // never reach a name or email box.
  experience: [{ company: "Northern Trust", title: "Senior DevOps Engineer", employmentType: "Full-time", current: true }],
  education: [], documents: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
      sendMessage(msg, cb) {
        const reply = msg?.type === "APPLI_FILL_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "APPLI_FILL_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(reply), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/segmented.html")).href);
for (const file of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, file), "utf8") });
}

const out = await page.evaluate(async () => {
  const M = window.APPLI_FILL_MATCHER;
  const adapter = window.APPLI_FILL_ATS.detect();
  const nameEl = document.getElementById("f-name");
  const fields = window.__applifill.collectFields(adapter);
  const res = await window.__applifill.run({ manual: true });
  const pressed = (id) => document.getElementById(id).getAttribute("aria-pressed") === "true";

  return {
    nameLabel: M.deriveLabel(nameEl),
    nameRuleKey: fields.find((f) => f.el === nameEl)?.rule?.key ?? null,
    segmentFields: fields.filter((f) => M.choiceButtonGroup?.(f.el)).length,
    unmatched: res?.data?.unmatched ?? 0,
    unmatchedIds: (window.__applifill.state.unmatched ?? []).map((f) => f.el.id),
    options: M.optionTextsFor(document.getElementById("auth-yes")) ?? [],
    values: { name: nameEl.value, email: document.getElementById("f-email").value },
    picked: {
      auth: [pressed("auth-yes"), pressed("auth-no")],
      sponsor: [pressed("spon-yes"), pressed("spon-no")],
      reloc: [pressed("reloc-yes"), pressed("reloc-no")],
    },
  };
});

/* --- 1. the posting's details panel is not the form's section --- */
check("the sidebar heading stays out of the derived label", !/employment\s*type/i.test(out.nameLabel), `label: "${out.nameLabel}"`);
check("a box labelled \"Name\" matches the full-name rule", out.nameRuleKey === "fullName", `matched: ${out.nameRuleKey}`);
check("Name gets the applicant's name, not the employment type", out.values.name === "Madhu Kumar", `got "${out.values.name}"`);
check("Email gets the applicant's email, not the employment type", out.values.email === "madhu.ittech@gmail.com", `got "${out.values.email}"`);

/* --- 2. segmented yes/no controls are found and answered --- */
check("each segmented group is collected exactly once", out.segmentFields === 3, `collected ${out.segmentFields}`);
check("the group's options can be read", out.options.join(",") === "Yes,No", JSON.stringify(out.options));
check("work authorisation answers Yes", out.picked.auth[0] === true && out.picked.auth[1] === false, JSON.stringify(out.picked.auth));
check("visa sponsorship answers No", out.picked.sponsor[1] === true && out.picked.sponsor[0] === false, JSON.stringify(out.picked.sponsor));
check("relocation answers Yes", out.picked.reloc[0] === true && out.picked.reloc[1] === false, JSON.stringify(out.picked.reloc));
check("an answered group is not flagged as needing the user", !out.unmatchedIds.some((id) => /^(auth|spon|reloc)-/.test(id)), `flagged: ${out.unmatchedIds.join(", ")}`);

/* --- 3. the open question is still surfaced for the AI pass --- */
check("the free-text question is the one left for the applicant", out.unmatchedIds.includes("f-why"), `flagged: ${out.unmatchedIds.join(", ") || "none"}`);
check("no submit button is treated as a question", !out.unmatchedIds.includes("submit-app"), `flagged: ${out.unmatchedIds.join(", ")}`);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
